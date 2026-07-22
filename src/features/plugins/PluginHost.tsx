import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ListBox, Select, Spinner, toast } from '@heroui/react'
import { usePluginStore } from '../../stores/pluginStore'
import { PLUGIN_UI_KIT_CSS } from './pluginUiKit'

/**
 * PluginHost —— 插件视图承载组件（见 PLUGIN_SYSTEM_PLAN.md §3）。
 *
 * - sandboxed iframe 加载 ct-plugin://<id>/... （开发者模式可为 devServer URL）
 * - 与 iframe 建立独立 MessageChannel，pluginId 按 iframe 实例绑定，插件无法冒充
 * - ui.* 方法在本组件内处理，其余经 electronAPI.plugin.invoke 转发主进程
 */

interface InvokeRequest {
  type: 'invoke'
  id: number
  method: string
  args?: Record<string, unknown>
}

export interface PluginHostContext {
  sessionId?: string
  sessionName?: string
}

/**
 * 快照宿主根元素上全部 CSS 自定义属性（HeroUI 主题 tokens + 应用自有变量），
 * 注入插件 iframe 后插件观感与宿主一致，主题切换实时同步。
 */
function collectThemeVars(): { vars: Record<string, string>; isDark: boolean } {
  const styles = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (let i = 0; i < styles.length; i++) {
    const prop = styles[i]
    if (prop.startsWith('--')) {
      vars[prop] = styles.getPropertyValue(prop)
    }
  }
  return { vars, isDark: document.documentElement.classList.contains('dark') }
}

interface PickerState {
  id: number
  left: number
  top: number
  width: number
  height: number
  options: Array<{ value: string; label: string }>
  selected: string | null
}

/**
 * 宿主侧下拉选择器：插件里的 <select class="ct-select"> 被 SDK 接管后，
 * 弹出层在宿主窗口用真正的 HeroUI Select/ListBox 渲染（与设置页同一组件），
 * 锚定在插件触发器的屏幕位置上，选择结果经 RPC 回传插件。
 */
function HostSelectPicker({ picker, onDone }: { picker: PickerState; onDone: (value: string | null) => void }) {
  const settledRef = useRef(false)
  const finish = (value: string | null) => {
    if (settledRef.current) return
    settledRef.current = true
    onDone(value)
  }
  return (
    <div
      style={{
        position: 'fixed',
        left: picker.left,
        top: picker.top,
        width: picker.width,
        height: picker.height,
        zIndex: 2147483000,
        pointerEvents: 'none',
      }}
    >
      <Select
        aria-label="插件下拉选择"
        selectedKey={picker.selected}
        onSelectionChange={(key) => finish(key == null ? null : String(key))}
        isOpen
        onOpenChange={(open: boolean) => { if (!open) finish(null) }}
        fullWidth
      >
        <Select.Trigger className="pointer-events-none h-full w-full opacity-0" />
        <Select.Popover>
          <ListBox>
            {picker.options.map((option) => (
              <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                {option.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}

export default function PluginHost({
  pluginId,
  viewId,
  context,
}: {
  pluginId: string
  viewId: string
  context?: PluginHostContext
}) {
  const navigate = useNavigate()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const [viewUrl, setViewUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const pickerRespondRef = useRef<((value: string | null) => void) | null>(null)
  const pickerIdRef = useRef(0)

  const finishPicker = useCallback((value: string | null) => {
    pickerRespondRef.current?.(value)
    pickerRespondRef.current = null
    setPicker(null)
  }, [])

  useEffect(() => {
    let mounted = true
    setStatus('loading')
    setViewUrl(null)
    window.electronAPI.plugin.getViewUrl(pluginId, viewId)
      .then((url) => {
        if (!mounted) return
        if (url) {
          setViewUrl(url)
        } else {
          setStatus('error')
        }
      })
      .catch(() => { if (mounted) setStatus('error') })
    return () => { mounted = false }
  }, [pluginId, viewId, reloadKey])

  const handleInvoke = useCallback(async (request: InvokeRequest, port: MessagePort) => {
    const respond = (ok: boolean, data?: unknown, error?: string) => {
      port.postMessage({ type: 'result', id: request.id, ok, data, error })
    }
    const args = request.args ?? {}

    // ui.* 是渲染进程本地能力，不经主进程
    if (request.method === 'ui.toast') {
      const text = String(args.text ?? '')
      if (args.type === 'error') toast.danger(text, { timeout: 3000 })
      else toast.success(text, { timeout: 3000 })
      respond(true, true)
      return
    }
    if (request.method === 'ui.navigate') {
      navigate(`/plugin/${pluginId}/${String(args.viewId ?? viewId)}`)
      respond(true, true)
      return
    }
    // 宿主渲染的下拉选择：弹出层与设置页 Select 是同一个组件
    if (request.method === 'ui.pickOption') {
      const iframeRect = iframeRef.current?.getBoundingClientRect()
      const anchor = args.anchor as { x: number; y: number; width: number; height: number } | undefined
      const rawOptions = Array.isArray(args.options) ? args.options.slice(0, 500) : []
      const options = rawOptions
        .map((o) => ({ value: String((o as any)?.value ?? ''), label: String((o as any)?.label ?? '') }))
        .filter((o) => o.label !== '')
      if (!iframeRect || !anchor || options.length === 0) {
        respond(false, undefined, 'pickOption 参数不完整')
        return
      }
      if (pickerRespondRef.current) {
        respond(false, undefined, '已有下拉在打开中')
        return
      }
      pickerRespondRef.current = (value) => respond(true, { value })
      pickerIdRef.current += 1
      setPicker({
        id: pickerIdRef.current,
        left: iframeRect.left + Number(anchor.x || 0),
        top: iframeRect.top + Number(anchor.y || 0),
        width: Math.max(Number(anchor.width) || 0, 40),
        height: Math.max(Number(anchor.height) || 0, 24),
        options,
        selected: args.selected != null && args.selected !== '' ? String(args.selected) : null,
      })
      return
    }

    try {
      const result = await window.electronAPI.plugin.invoke(pluginId, request.method, args)
      respond(result.success, result.data, result.error)
    } catch (e) {
      respond(false, undefined, String(e))
    }
  }, [navigate, pluginId, viewId])

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return

    // iframe 重载时取消未决的下拉选择
    finishPicker(null)
    portRef.current?.close()
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent) => {
      const data = event.data as InvokeRequest
      if (data?.type === 'invoke' && typeof data.method === 'string') {
        void handleInvoke(data, channel.port1)
      }
    }
    // 仅发给这个具体 iframe 的 window；端口即信道，pluginId 由宿主侧闭包绑定
    iframe.contentWindow.postMessage(
      {
        type: 'ciphertalk:connect',
        pluginId,
        viewId,
        context: context ?? {},
        theme: collectThemeVars(),
        // 统一 UI 组件样式（.ct-btn / .ct-select / .ct-switch 等），SDK 自动注入
        uiKit: PLUGIN_UI_KIT_CSS,
      },
      '*',
      [channel.port2]
    )
    setStatus('ready')
  }, [handleInvoke, pluginId, viewId, context])

  // 主进程事件桥：按目标插件 + 权限过滤后转发进 iframe
  useEffect(() => {
    return window.electronAPI.plugin.onEvent((data) => {
      if (data.pluginId && data.pluginId !== pluginId) return
      if (data.requiredPermission) {
        const plugin = usePluginStore.getState().plugins.find((p) => p.id === pluginId)
        if (!plugin?.grantedPermissions.includes(data.requiredPermission)) return
      }
      portRef.current?.postMessage({ type: 'event', event: data.event, payload: data.payload })
    })
  }, [pluginId])

  // 宿主主题切换（根元素 class/style 变化）时向插件推送最新 tokens
  useEffect(() => {
    const observer = new MutationObserver(() => {
      portRef.current?.postMessage({ type: 'theme', theme: collectThemeVars() })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => { portRef.current?.close() }, [])

  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-foreground-500">
        <span>插件视图加载失败（插件可能已被禁用）</span>
        <Button variant="secondary" onPress={() => setReloadKey((k) => k + 1)}>重试</Button>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {viewUrl && (
        <iframe
          key={`${viewUrl}-${reloadKey}`}
          ref={iframeRef}
          src={viewUrl}
          title={`plugin-${pluginId}-${viewId}`}
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
          onLoad={handleIframeLoad}
        />
      )}
      {picker && <HostSelectPicker key={picker.id} picker={picker} onDone={finishPicker} />}
    </div>
  )
}
