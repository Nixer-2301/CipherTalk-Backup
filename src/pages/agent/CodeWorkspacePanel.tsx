import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { AlertDialog, Button as HeroButton, Label, Popover, Tabs } from '@heroui/react'
import { ArrowsRotateLeft, ArrowUpRightFromSquare, ChevronRight, Code, Display, File, Folder, FolderOpen, ShieldExclamation, Square, Terminal, Xmark } from '@gravity-ui/icons'
import type {
  CodeWorkspaceApprovalRequest,
  CodeWorkspaceFileItem,
  CodeWorkspaceRef,
  CodeWorkspaceState,
} from '@/types/electron'

export const CODE_WORKSPACE_FILE_REF_MIME = 'application/x-ciphertalk-code-workspace-file'

export type CodeWorkspaceFileDragReference = {
  name: string
  path: string
}

type CodeWorkspacePanelProps = {
  approval: CodeWorkspaceApprovalRequest | null
  className?: string
  expanded: boolean
  onApprove: (requestId: string) => void
  onExpandedChange: (expanded: boolean) => void
  onReject: (requestId: string) => void
  onSelect: () => void
  onStopDevServer: () => void
  state: CodeWorkspaceState | null
}

export type CodeWorkspacePanelTab = 'preview' | 'logs'

type CodeWorkspacePanelPopoverProps = {
  activeTab?: CodeWorkspacePanelTab
  isOpen: boolean
  logs: string[]
  onActiveTabChange?: (tab: CodeWorkspacePanelTab) => void
  onOpenChange: (open: boolean) => void
  onStopDevServer: () => void
  state: CodeWorkspaceState | null
}

type CodeWorkspaceSidebarProps = {
  className?: string
  onSelect: () => void
  state: CodeWorkspaceState | null
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

export function riskText(risk: CodeWorkspaceApprovalRequest['risk']): string {
  if (risk === 'high') return '高风险'
  if (risk === 'medium') return '中风险'
  return '低风险'
}

export function describeCodeWorkspaceApproval(approval: CodeWorkspaceApprovalRequest): string {
  return `${kindText(approval.kind)} · ${approval.summary}`
}

function kindText(kind: CodeWorkspaceApprovalRequest['kind']): string {
  switch (kind) {
    case 'write':
      return '写入'
    case 'delete':
      return '删除'
    case 'command':
      return '命令'
    case 'dev-server':
      return '开发服务器'
    case 'sensitive-read':
      return '敏感读取'
    default:
      return kind
  }
}

function fileName(value: string): string {
  return basename(value.replace(/\\/g, '/'))
}

function sortFileItems(items: CodeWorkspaceFileItem[]) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return fileName(a.path).localeCompare(fileName(b.path), 'zh-CN')
  })
}

function FileTreeRow({
  depth,
  expanded,
  item,
  loading,
  onToggle,
}: {
  depth: number
  expanded: boolean
  item: CodeWorkspaceFileItem
  loading: boolean
  onToggle: (item: CodeWorkspaceFileItem) => void
}) {
  const isDir = item.type === 'dir'
  const Icon = isDir ? (expanded ? FolderOpen : Folder) : File
  const displayName = fileName(item.path)

  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    if (isDir) return
    const payload: CodeWorkspaceFileDragReference = {
      name: displayName,
      path: item.path,
    }
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(CODE_WORKSPACE_FILE_REF_MIME, JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', item.path)
  }

  return (
    <button
      className={`flex h-7 w-full min-w-0 items-center gap-1 rounded-(--agent-radius,12px) px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/45 hover:text-foreground ${isDir ? '' : 'cursor-grab active:cursor-grabbing'}`}
      draggable={!isDir}
      onClick={() => isDir && onToggle(item)}
      onDragStart={handleDragStart}
      style={{ paddingLeft: `${Math.min(depth, 8) * 0.75 + 0.375}rem` }}
      title={isDir ? displayName : `拖到输入框引用：${item.path}`}
      type="button"
    >
      {isDir ? (
        <ChevronRight className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      ) : (
        <span className="size-3 shrink-0" />
      )}
      <Icon className={`size-3.5 shrink-0 ${isDir ? 'text-accent' : 'text-muted-foreground'}`} />
      <span className="min-w-0 flex-1 truncate">{displayName}</span>
      {loading && <span className="shrink-0 text-[10px] text-muted-foreground">...</span>}
    </button>
  )
}

export function CodeWorkspaceSidebar({
  className,
  onSelect,
  state,
}: CodeWorkspaceSidebarProps) {
  const workspace = state?.workspace ?? null
  const [rootItems, setRootItems] = useState<CodeWorkspaceFileItem[]>([])
  const [childrenByPath, setChildrenByPath] = useState<Record<string, CodeWorkspaceFileItem[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const childrenByPathRef = useRef(childrenByPath)

  useEffect(() => {
    childrenByPathRef.current = childrenByPath
  }, [childrenByPath])

  const loadDirectory = useCallback(async (targetPath = '.', force = false, preserveTree = false) => {
    if (!workspace) return
    if (!force && targetPath !== '.' && childrenByPathRef.current[targetPath]) return
    setError('')
    setLoadingPaths((prev) => new Set(prev).add(targetPath))
    try {
      const result = await window.electronAPI.agentWorkspace.listFiles({
        path: targetPath,
        maxDepth: 0,
        limit: 300,
      })
      if (!result.success) {
        setError(result.error || '文件树加载失败')
        return
      }
      const items = sortFileItems(result.items || [])
      setTruncated(Boolean(result.truncated))
      if (targetPath === '.') {
        setRootItems(items)
        if (!preserveTree) {
          setChildrenByPath({})
          setExpanded(new Set())
        }
      } else {
        setChildrenByPath((prev) => ({ ...prev, [targetPath]: items }))
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '文件树加载失败')
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev)
        next.delete(targetPath)
        return next
      })
    }
  }, [workspace?.id])

  useEffect(() => {
    setRootItems([])
    setChildrenByPath({})
    setExpanded(new Set())
    setError('')
    setTruncated(false)
    if (workspace) void loadDirectory('.', true)
  }, [loadDirectory, workspace?.id])

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!workspace) return undefined
    const unsubscribe = window.electronAPI.agentWorkspace.onWorkspaceEvent((event) => {
      if (event.type !== 'files-changed') return
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        void loadDirectory('.', true, true)
        for (const path of expanded) void loadDirectory(path, true)
      }, 120)
    })
    return () => {
      unsubscribe()
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [expanded, loadDirectory, workspace])

  const toggleDirectory = (item: CodeWorkspaceFileItem) => {
    const nextExpanded = new Set(expanded)
    if (nextExpanded.has(item.path)) {
      nextExpanded.delete(item.path)
      setExpanded(nextExpanded)
      return
    }
    nextExpanded.add(item.path)
    setExpanded(nextExpanded)
    void loadDirectory(item.path)
  }

  const renderItems = (items: CodeWorkspaceFileItem[], depth: number): ReactNode[] => {
    const rows: ReactNode[] = []
    for (const item of items) {
      const isExpanded = expanded.has(item.path)
      rows.push(
        <FileTreeRow
          depth={depth}
          expanded={isExpanded}
          item={item}
          key={item.path}
          loading={loadingPaths.has(item.path)}
          onToggle={toggleDirectory}
        />
      )
      if (item.type === 'dir' && isExpanded) {
        const children = childrenByPath[item.path] || []
        if (children.length > 0) {
          rows.push(...renderItems(children, depth + 1))
        } else if (!loadingPaths.has(item.path)) {
          rows.push(
            <div
              className="h-6 truncate px-2 py-1 text-muted-foreground text-[11px]"
              key={`${item.path}:empty`}
              style={{ paddingLeft: `${Math.min(depth + 1, 8) * 0.75 + 1.25}rem` }}
            >
              空目录
            </div>
          )
        }
      }
    }
    return rows
  }

  return (
    <aside className={`flex w-72 shrink-0 flex-col border-r border-border/60 bg-surface/35 ${className || ''}`}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm text-foreground">
            {workspace ? basename(workspace.root) : '代码工作区'}
          </div>
          <div className="truncate text-muted-foreground text-[11px]">
            {workspace ? '文件树' : '未选择'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {workspace && (
            <HeroButton
              aria-label="刷新文件树"
              className="size-7 p-0"
              isIconOnly
              onPress={() => { void loadDirectory('.', true) }}
              size="sm"
              variant="ghost"
            >
              <ArrowsRotateLeft className="size-3.5" />
            </HeroButton>
          )}
          <HeroButton className="h-7 px-2 text-xs" onPress={onSelect} size="sm" variant="secondary">
            <FolderOpen className="size-3.5" />
            {workspace ? '切换' : '选择'}
          </HeroButton>
        </div>
      </div>
      <div className="ct-agent-scrollbar min-h-0 flex-1 overflow-auto p-2">
        {!workspace ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-muted-foreground text-xs">
            <Code className="size-5" />
            <span>选择工作区后显示文件树</span>
          </div>
        ) : rootItems.length > 0 ? (
          <div className="space-y-0.5">
            {renderItems(rootItems, 0)}
            {truncated && (
              <div className="px-2 py-1 text-muted-foreground text-[11px]">文件较多，已截断显示</div>
            )}
          </div>
        ) : loadingPaths.has('.') ? (
          <div className="px-2 py-3 text-muted-foreground text-xs">加载文件树...</div>
        ) : (
          <div className="px-2 py-3 text-muted-foreground text-xs">空工作区</div>
        )}
        {error && (
          <div className="mt-2 rounded-(--agent-radius,12px) border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-destructive text-xs">
            {error}
          </div>
        )}
      </div>
    </aside>
  )
}

function WorkspacePanelContent({
  activeTab: activeTabProp,
  logs,
  onActiveTabChange,
  onOpenChange,
  onStopDevServer,
  state,
}: CodeWorkspacePanelPopoverProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<CodeWorkspacePanelTab>('preview')
  const activeTab = activeTabProp ?? internalActiveTab
  const workspace = state?.workspace ?? null
  const devServer = state?.devServer
  const previewUrl = devServer?.previewUrl || ''
  const terminalOutput = useMemo(() => logs.join('\n'), [logs])

  useEffect(() => {
    if (previewUrl && !activeTabProp) setInternalActiveTab('preview')
  }, [activeTabProp, previewUrl])

  const setActiveTab = (next: CodeWorkspacePanelTab) => {
    setInternalActiveTab(next)
    onActiveTabChange?.(next)
  }

  return (
    <Tabs
      className="flex h-[min(72vh,44rem)] w-[min(calc(100vw-2rem),52rem)] min-h-0 flex-col overflow-hidden"
      selectedKey={activeTab}
      onSelectionChange={(key) => setActiveTab(key as CodeWorkspacePanelTab)}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="min-w-0">
          <Tabs.ListContainer>
            <Tabs.List aria-label="代码工作区面板" className="*:h-7 *:px-3 *:text-xs">
              <Tabs.Tab id="preview">
                预览
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="logs">
                <Tabs.Separator />
                日志
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {previewUrl && (
            <HeroButton
              className="h-7 px-2 text-xs"
              onPress={() => { void window.electronAPI.shell.openExternal(previewUrl) }}
              size="sm"
              variant="ghost"
            >
              <ArrowUpRightFromSquare className="size-3.5" />
              打开
            </HeroButton>
          )}
          {devServer?.running && (
            <HeroButton className="h-7 px-2 text-xs" onPress={onStopDevServer} size="sm" variant="secondary">
              <Square className="size-3.5" />
              停止
            </HeroButton>
          )}
          <HeroButton
            aria-label="关闭代码工作区面板"
            className="size-7 p-0"
            isIconOnly
            onPress={() => onOpenChange(false)}
            size="sm"
            variant="ghost"
          >
            <Xmark className="size-4" />
          </HeroButton>
        </div>
      </div>
      <Tabs.Panel className="min-h-0 flex-1 p-0" id="preview">
        {previewUrl ? (
          <iframe
            className="h-full min-h-0 w-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            src={previewUrl}
            title="代码工作区预览"
          />
        ) : (
          <div className="flex h-full min-h-80 items-center justify-center text-muted-foreground text-sm">
            暂无本地预览
          </div>
        )}
      </Tabs.Panel>
      <Tabs.Panel className="min-h-0 flex-1 p-0" id="logs">
        <pre className="ct-agent-scrollbar ct-agent-scrollbar-dark h-full min-h-0 overflow-auto bg-zinc-950 p-4 font-mono text-[11px] text-zinc-100 leading-5">
          {terminalOutput || '$ 等待命令输出'}
        </pre>
      </Tabs.Panel>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-4 py-2 text-muted-foreground text-xs">
        <Terminal className="size-3.5 shrink-0" />
        <span className="truncate">{previewUrl || devServer?.command || (workspace ? basename(workspace.root) : '未选择工作区')}</span>
      </div>
    </Tabs>
  )
}

export function CodeWorkspacePanelPopover(props: CodeWorkspacePanelPopoverProps) {
  const devServerRunning = Boolean(props.state?.devServer.running)

  return (
    <Popover isOpen={props.isOpen} onOpenChange={props.onOpenChange}>
      <HeroButton
        aria-label="代码工作区面板"
        className="group relative size-9 overflow-visible p-0"
        isIconOnly
        render={(buttonProps) => (
          <button
            {...buttonProps}
            title={devServerRunning ? '代码工作区面板 · 预览运行中' : '代码工作区面板'}
          />
        )}
        size="md"
        variant={devServerRunning ? 'secondary' : 'tertiary'}
      >
        <Display className="size-4.5" />
        {devServerRunning && (
          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-emerald-500" />
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute top-[calc(100%+0.375rem)] right-0 z-50 whitespace-nowrap rounded-(--agent-radius,12px) border border-border bg-popover px-2 py-1 text-popover-foreground text-xs opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        >
          {devServerRunning ? '代码工作区面板 · 预览运行中' : '代码工作区面板'}
        </span>
      </HeroButton>
      <Popover.Content
        className="overflow-hidden p-0"
        offset={8}
        placement="bottom end"
        shouldFlip
      >
        <Popover.Dialog className="p-0">
          <WorkspacePanelContent {...props} />
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

export function CodeWorkspacePanel({
  approval,
  className,
  expanded,
  onApprove,
  onExpandedChange,
  onReject,
  state,
}: CodeWorkspacePanelProps) {
  const workspace = state?.workspace ?? null
  const devServer = state?.devServer

  return (
    <>
      <div className={className || 'mx-auto mb-2 w-full min-w-80 max-w-[82%]'}>
        <div className="flex min-h-5 min-w-0 items-center px-1 text-[11px] leading-none">
          {workspace ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span className="inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-muted/30 px-2">
                <Code className="size-3 shrink-0 text-accent" />
                <span className="shrink-0 text-muted-foreground">代码工作区</span>
                <span className="min-w-0 truncate font-medium text-foreground">{basename(workspace.root)}</span>
                {devServer?.running && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    dev
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
              <Code className="size-3 shrink-0" />
              <span>未选择代码工作区</span>
            </div>
          )}
        </div>
      </div>

      <AlertDialog.Backdrop isOpen={approval !== null && expanded} onOpenChange={onExpandedChange}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-3xl">
            <AlertDialog.Header>
              <div className="flex items-center gap-2">
                <ShieldExclamation className="size-4 text-amber-500" />
                代码工作区确认
              </div>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {approval && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-(--agent-radius,12px) border border-border px-2 py-1">{kindText(approval.kind)}</span>
                    <span className="rounded-(--agent-radius,12px) border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                      {riskText(approval.risk)}
                    </span>
                    <Label>{approval.summary}</Label>
                  </div>
                  {approval.targetPath && (
                    <div className="rounded-(--agent-radius,12px) bg-muted/50 px-3 py-2 font-mono text-xs">
                      {approval.targetPath}
                    </div>
                  )}
                  {approval.command && (
                    <div className="rounded-(--agent-radius,12px) bg-zinc-950 px-3 py-2 font-mono text-zinc-100 text-xs">
                      $ {approval.command}
                    </div>
                  )}
                  {approval.diffPreview && (
                    <pre className="ct-agent-scrollbar max-h-[50vh] overflow-auto rounded-(--agent-radius,12px) border border-border bg-muted/35 p-3 font-mono text-xs">
                      {approval.diffPreview}
                    </pre>
                  )}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton
                onPress={() => approval && onReject(approval.requestId)}
                variant="secondary"
              >
                拒绝
              </HeroButton>
              <HeroButton
                onPress={() => approval && onApprove(approval.requestId)}
                variant="primary"
              >
                批准
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
