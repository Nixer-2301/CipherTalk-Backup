/**
 * Canvas 右侧面板 —— 头部工具栏 + 冲突条 + 编辑器 + 版本历史（页面区域，不套卡片）。
 * 桌面占内容区 clamp(420px, 44%, 760px)；宽度 <900px 时切换为内容区全屏视图（返回按钮回对话）。
 * 危险操作（归档、冲突覆盖）走 HeroUI AlertDialog 二次确认。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertDialog, Button as HeroButton, Spinner } from '@heroui/react'
import { TrashBin, TriangleExclamation } from '@gravity-ui/icons'
import { MessageResponse } from '@/components/ai-elements/message'
import type { UseAgentCanvasResult } from './useAgentCanvas'
import { downloadCanvasContent } from './agentCanvasStore'
import { AgentCanvasEditor } from './AgentCanvasEditor'
import { AgentCanvasHeader } from './AgentCanvasHeader'
import { AgentCanvasHistory } from './AgentCanvasHistory'

export interface AgentCanvasPanelProps {
  canvas: UseAgentCanvasResult
  /** 消息引用点开时标记的历史版本（引用 revision 旧于当前时在历史里标注） */
  markedRevision?: number | null
}

export function AgentCanvasPanel({ canvas, markedRevision }: AgentCanvasPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [keepMineConfirmOpen, setKeepMineConfirmOpen] = useState(false)
  // 文档画布默认预览态（Markdown/mermaid/echarts 渲染出来），代码画布恒为编辑态
  const [viewMode, setViewMode] = useState<'preview' | 'edit'>('preview')

  const { record, conflict } = canvas
  const recordId = record?.id
  const recordKind = record?.kind
  useEffect(() => {
    // 有内容的文档默认预览；空白文档（手动新建）直接进编辑态，预览一片空白没意义
    setViewMode(recordKind === 'document' && canvas.draft.trim() ? 'preview' : 'edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在切换画布时决定初始视图
  }, [recordId, recordKind])
  const showPreview = recordKind === 'document' && viewMode === 'preview'

  const handleCopy = useCallback(async () => {
    if (!navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(canvas.draft)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [canvas.draft])

  const handleDownload = useCallback(() => {
    if (record) downloadCanvasContent(record, canvas.draft)
  }, [record, canvas.draft])

  const handleCopyMine = useCallback(async () => {
    if (!navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(canvas.draft)
  }, [canvas.draft])

  return (
    <div className="flex h-full min-h-0 w-[clamp(420px,44%,760px)] shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background/40 max-[900px]:absolute max-[900px]:inset-0 max-[900px]:z-40 max-[900px]:w-full max-[900px]:border-l-0 max-[900px]:bg-background">
      {canvas.loading || !record ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner size="sm" />
          正在加载画布…
        </div>
      ) : (
        <>
          <AgentCanvasHeader
            copied={copied}
            historyOpen={historyOpen}
            readOnly={record.status === 'archived'}
            onArchive={() => setArchiveConfirmOpen(true)}
            onClose={canvas.closePanel}
            onCopy={() => { void handleCopy() }}
            onDownload={handleDownload}
            onRename={(title) => { void canvas.rename(title) }}
            onToggleHistory={() => setHistoryOpen((prev) => !prev)}
            onToggleViewMode={() => setViewMode((prev) => (prev === 'preview' ? 'edit' : 'preview'))}
            record={record}
            saveStatus={canvas.saveStatus}
            viewMode={record.kind === 'document' ? viewMode : null}
          />
          {conflict && (
            <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <TriangleExclamation className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="min-w-0 flex-1 text-amber-700 dark:text-amber-300">
                画布已被更新到 v{conflict.actualRevision}（本地基于 v{conflict.expectedRevision}），自动保存已暂停。
              </span>
              <HeroButton onPress={canvas.conflictUseLatest} size="sm" variant="tertiary">
                查看最新版本
              </HeroButton>
              <HeroButton onPress={() => setKeepMineConfirmOpen(true)} size="sm" variant="tertiary">
                保留我的版本
              </HeroButton>
              <HeroButton onPress={() => { void handleCopyMine() }} size="sm" variant="tertiary">
                复制我的内容
              </HeroButton>
            </div>
          )}
          {historyOpen && (
            <div className="shrink-0 border-b border-border/60">
              <AgentCanvasHistory
                canvasId={record.id}
                currentRevision={record.revision}
                markedRevision={markedRevision}
                readOnly={record.status === 'archived'}
                onRestore={(revision) => { void canvas.restoreRevision(revision) }}
              />
            </div>
          )}
          <div className="min-h-0 flex-1">
            {showPreview ? (
              <div className="ct-agent-scrollbar h-full overflow-y-auto px-4 py-3">
                <MessageResponse className="text-sm" isStreaming={false} showStreamingIndicator={false}>
                  {canvas.draft}
                </MessageResponse>
              </div>
            ) : (
              <AgentCanvasEditor
                kind={record.kind}
                disabled={record.status === 'archived'}
                onChange={canvas.setDraft}
                value={canvas.draft}
              />
            )}
          </div>
        </>
      )}

      <AlertDialog.Backdrop isOpen={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <TrashBin className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>归档这个画布？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>归档后面板会关闭；数据不会被物理删除，仍随会话保留。</p>
              {record && <p className="mt-2 truncate font-medium text-foreground">{record.title}</p>}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton onPress={() => setArchiveConfirmOpen(false)} variant="tertiary">取消</HeroButton>
              <HeroButton
                onPress={() => {
                  setArchiveConfirmOpen(false)
                  void canvas.archiveCanvas()
                }}
                variant="danger"
              >
                归档
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={keepMineConfirmOpen} onOpenChange={setKeepMineConfirmOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <TriangleExclamation className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>用我的版本覆盖最新内容？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                这会把画布全文覆盖为你本地未保存的版本，v{conflict?.actualRevision ?? record?.revision} 的改动会被替换
                （仍可在版本历史中恢复）。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton onPress={() => setKeepMineConfirmOpen(false)} variant="tertiary">取消</HeroButton>
              <HeroButton
                onPress={() => {
                  setKeepMineConfirmOpen(false)
                  void canvas.conflictKeepMine()
                }}
                variant="danger"
              >
                覆盖为我的版本
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}
