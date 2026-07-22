import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Drawer, Tooltip } from '@heroui/react'
import { usePluginStore, ensurePluginStoreSubscribed, selectEnabledPlugins } from '../../stores/pluginStore'
import { PluginIcon } from './PluginIcon'
import PluginHost from './PluginHost'

/**
 * 聊天界面右上角的插件按钮（chatToolbarButtons 贡献点）。
 * 点击打开 drawer 承载插件视图，并注入当前会话上下文（sessionId / sessionName）。
 * 按钮渲染只读 manifest；drawer 打开时才创建 iframe（懒激活）。
 *
 * drawer 复用「会话详情」的定位机制（chat-detail-* 类 + 边界变量），
 * 严格限制在消息内容区内，不遮挡头部工具栏。
 */
export default function PluginChatToolbar({
  sessionId,
  sessionName,
}: {
  sessionId: string | null
  sessionName?: string
}) {
  const plugins = usePluginStore(state => state.plugins)
  const [openView, setOpenView] = useState<{ pluginId: string; viewId: string; label: string } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => { ensurePluginStoreSubscribed() }, [])

  // 会话切换时关闭 drawer，避免插件拿到过期上下文
  useEffect(() => { setOpenView(null) }, [sessionId])

  // 与 ChatHeader 会话详情抽屉同一套边界同步：钉在消息内容区内
  const getDrawerHost = useCallback(() => {
    const shell = anchorRef.current?.closest('.message-shell') as HTMLElement | null
    const area = anchorRef.current?.closest('.message-area') as HTMLElement | null
    return (shell ?? area)?.querySelector('.message-content-wrapper') as HTMLElement | null
  }, [])

  const syncDrawerBounds = useCallback(() => {
    const host = getDrawerHost()
    if (!host) return
    const rect = host.getBoundingClientRect()
    const rootStyle = document.documentElement.style
    rootStyle.setProperty('--chat-detail-drawer-left', `${rect.left}px`)
    rootStyle.setProperty('--chat-detail-drawer-top', `${rect.top}px`)
    rootStyle.setProperty('--chat-detail-drawer-width', `${rect.width}px`)
    rootStyle.setProperty('--chat-detail-drawer-height', `${rect.height}px`)
  }, [getDrawerHost])

  useEffect(() => {
    if (!openView) return
    const host = getDrawerHost()
    if (!host) return
    syncDrawerBounds()
    window.addEventListener('resize', syncDrawerBounds)
    const observer = new ResizeObserver(syncDrawerBounds)
    observer.observe(host)
    return () => {
      window.removeEventListener('resize', syncDrawerBounds)
      observer.disconnect()
    }
  }, [openView, getDrawerHost, syncDrawerBounds])

  const buttons = selectEnabledPlugins(plugins).flatMap((plugin) =>
    (plugin.contributes.chatToolbarButtons ?? []).map((button) => ({
      pluginId: plugin.id,
      id: button.id,
      label: button.label,
      icon: button.icon,
      view: button.view,
    }))
  )

  if (buttons.length === 0 || !sessionId) return null

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {buttons.map((button) => (
        <Tooltip delay={0} key={`${button.pluginId}:${button.id}`}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={button.label}
              onPress={() => setOpenView({ pluginId: button.pluginId, viewId: button.view, label: button.label })}
            >
              <PluginIcon name={button.icon} size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">{button.label}</Tooltip.Content>
        </Tooltip>
      ))}

      <Drawer.Backdrop
        className="chat-detail-backdrop"
        isOpen={!!openView}
        onOpenChange={(open: boolean) => { if (!open) setOpenView(null) }}
        variant="transparent"
      >
        <Drawer.Content className="chat-detail-content" placement="right">
          <Drawer.Dialog className="chat-detail-drawer" aria-label={openView?.label ?? '插件面板'}>
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading>{openView?.label}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex min-h-0 flex-col !p-0">
              {openView && (
                <PluginHost
                  pluginId={openView.pluginId}
                  viewId={openView.viewId}
                  context={{ sessionId: sessionId ?? undefined, sessionName }}
                />
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </>
  )
}
