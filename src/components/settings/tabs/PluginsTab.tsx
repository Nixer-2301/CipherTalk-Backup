import { useEffect, useState } from 'react'
import { Button, Chip, Switch } from '@heroui/react'
import { ArrowsRotateLeft, FolderOpen, FolderPlus, Puzzle, ShieldCheck, TrashBin } from '@gravity-ui/icons'
import { usePluginStore, ensurePluginStoreSubscribed } from '../../../stores/pluginStore'
import type { PluginInfo } from '../../../types/electron'
import { dialog } from '../../../services/ipc'
import ConfirmDialog from '../ui/ConfirmDialog'

/** 权限项的用户可读说明（启用确认时展示） */
const PERMISSION_LABELS: Record<string, string> = {
  'sessions:read': '读取会话列表',
  'contacts:read': '读取联系人与群成员',
  'messages:read': '读取聊天消息',
  'clipboard:write': '写入剪贴板',
  'media:read': '读取图片 / 语音等媒体',
  'stt:use': '使用语音转写',
  'search:use': '使用全文搜索',
  'stats:read': '读取统计数据',
  'export:use': '调用导出功能',
  'notify:send': '发送系统通知',
  'window:create': '打开独立窗口',
  'sns:read': '读取朋友圈',
  'ai:use': '调用 AI 能力',
  'network': '访问网络（数据可能被发送到外部）',
}

function BareSwitch({ isSelected, isDisabled, onChange, label }: {
  isSelected: boolean
  isDisabled?: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <Switch isSelected={isSelected} isDisabled={isDisabled} onChange={onChange} aria-label={label}>
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
    </Switch>
  )
}

function PluginsTab({ showMessage }: { showMessage: (text: string, success: boolean) => void }) {
  const { plugins, devModeEnabled, refresh } = usePluginStore()
  const [confirmEnable, setConfirmEnable] = useState<PluginInfo | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<PluginInfo | null>(null)

  useEffect(() => { ensurePluginStoreSubscribed() }, [])

  const handleToggle = async (plugin: PluginInfo, enabled: boolean) => {
    if (enabled) {
      // 启用前展示权限清单，用户确认后才授予
      setConfirmEnable(plugin)
      return
    }
    const result = await window.electronAPI.plugin.disable(plugin.id)
    if (!result.success) showMessage(result.error || '禁用失败', false)
    await refresh()
  }

  const doEnable = async () => {
    if (!confirmEnable) return
    const result = await window.electronAPI.plugin.enable(confirmEnable.id)
    if (result.success) showMessage(`已启用「${confirmEnable.name}」`, true)
    else showMessage(result.error || '启用失败', false)
    setConfirmEnable(null)
    await refresh()
  }

  const doUninstall = async () => {
    if (!confirmUninstall) return
    const result = await window.electronAPI.plugin.uninstall(confirmUninstall.id)
    if (result.success) showMessage(`已卸载「${confirmUninstall.name}」`, true)
    else showMessage(result.error || '卸载失败', false)
    setConfirmUninstall(null)
    await refresh()
  }

  const handleSetDevMode = async (enabled: boolean) => {
    await window.electronAPI.plugin.setDevMode(enabled)
    await refresh()
  }

  const handleAddDevPlugin = async () => {
    const result = await dialog.openFile({
      title: '选择插件目录（包含 manifest.json）',
      properties: ['openDirectory'],
    })
    const dir = result?.filePaths?.[0]
    if (!dir) return
    const added = await window.electronAPI.plugin.addDevPlugin(dir)
    if (added.success) showMessage('本地插件已加载', true)
    else showMessage(added.error || '加载失败', false)
    await refresh()
  }

  const handleRescan = async () => {
    await window.electronAPI.plugin.rescan()
    await refresh()
    showMessage('已重新扫描插件目录', true)
  }

  const handleInstall = async () => {
    const result = await window.electronAPI.plugin.installFromFile()
    if (result.canceled) return
    if (result.success) showMessage(`已安装「${result.name}」，启用前请确认权限`, true)
    else showMessage(result.error || '安装失败', false)
    await refresh()
  }

  return (
    <div className="tab-content">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">插件</h3>
          <p className="text-sm text-foreground-500">插件在隔离沙箱中运行，仅能使用你授予的权限</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onPress={() => { void handleInstall() }} aria-label="安装插件">
            <FolderPlus width={16} height={16} /> 安装插件
          </Button>
          <Button variant="ghost" onPress={() => { void handleRescan() }} aria-label="重新扫描">
            <ArrowsRotateLeft width={16} height={16} /> 重新扫描
          </Button>
        </div>
      </div>

      {plugins.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-foreground-200 py-12 text-foreground-400">
          <Puzzle width={32} height={32} />
          <span>还没有安装插件</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {plugins.map((plugin) => (
          <div key={plugin.id} className="flex items-start justify-between gap-4 rounded-2xl border border-foreground-100 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{plugin.name}</span>
                <Chip size="sm" variant="soft">v{plugin.version}</Chip>
                {plugin.isDev && <Chip size="sm" color="warning" variant="soft">开发</Chip>}
                {plugin.error && <Chip size="sm" color="danger" variant="soft">异常</Chip>}
              </div>
              {plugin.description && (
                <p className="mt-1 truncate text-sm text-foreground-500">{plugin.description}</p>
              )}
              <p className="mt-0.5 text-xs text-foreground-400">
                开发者：{plugin.author?.name || '未知'}
                {plugin.author?.email && <span className="ml-2">{plugin.author.email}</span>}
              </p>
              {plugin.error && (
                <p className="mt-1 text-sm text-danger">{plugin.error}</p>
              )}
              {plugin.permissions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {plugin.permissions.map((p) => (
                    <Chip key={p} size="sm" variant="soft" color={p === 'network' ? 'danger' : undefined}>
                      {PERMISSION_LABELS[p] ?? p}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <BareSwitch
                isSelected={plugin.enabled}
                isDisabled={!!plugin.error}
                onChange={(v) => { void handleToggle(plugin, v) }}
                label={`启用 ${plugin.name}`}
              />
              <Button
                variant="ghost"
                isIconOnly
                aria-label="卸载"
                onPress={() => setConfirmUninstall(plugin)}
              >
                <TrashBin width={16} height={16} />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-foreground-100 p-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-medium">插件开发者模式</span>
            <p className="text-sm text-foreground-500">允许加载本地插件目录，支持 devServer 热更新</p>
          </div>
          <BareSwitch
            isSelected={devModeEnabled}
            onChange={(v) => { void handleSetDevMode(v) }}
            label="插件开发者模式"
          />
        </div>
        {devModeEnabled && (
          <Button className="mt-3" variant="secondary" onPress={() => { void handleAddDevPlugin() }}>
            <FolderOpen width={16} height={16} /> 加载本地插件目录
          </Button>
        )}
      </div>

      {confirmEnable && (
        <ConfirmDialog
          title={`启用「${confirmEnable.name}」`}
          titleIcon={<ShieldCheck width={20} height={20} />}
          message={
            confirmEnable.permissions.length > 0 ? (
              <span>
                开发者：{confirmEnable.author?.name || '未知'}
                {confirmEnable.author?.email ? `（${confirmEnable.author.email}）` : ''}
                <br />
                该插件将获得以下权限：
                <ul className="mt-2 list-inside list-disc text-left">
                  {confirmEnable.permissions.map((p) => (
                    <li key={p} className={p === 'network' ? 'text-danger' : undefined}>
                      {PERMISSION_LABELS[p] ?? p}
                    </li>
                  ))}
                </ul>
              </span>
            ) : '该插件不需要任何数据权限。'
          }
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirmEnable(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => { void doEnable() }}>确认启用</button>
            </>
          }
        />
      )}

      {confirmUninstall && (
        <ConfirmDialog
          title={`卸载「${confirmUninstall.name}」`}
          message={confirmUninstall.isDev
            ? '将从列表移除该本地插件（源码目录不会被删除），并清除其权限与私有数据。'
            : '将删除插件文件、权限与私有数据，此操作不可恢复。'}
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirmUninstall(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => { void doUninstall() }}>确认卸载</button>
            </>
          }
        />
      )}
    </div>
  )
}

export default PluginsTab
