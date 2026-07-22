/**
 * Canvas 版本历史 —— 打开时拉取 revision 列表，支持恢复到任一历史版本
 * （恢复=生成新 revision，不回退计数，见 store.restore）。
 */
import { useEffect, useState } from 'react'
import { Button as HeroButton, Spinner } from '@heroui/react'
import { Clock } from '@gravity-ui/icons'
import type { AgentCanvasRevisionMeta } from './agentCanvasTypes'
import { canvasApi } from './agentCanvasStore'

const SOURCE_LABEL: Record<string, string> = {
  user: '用户编辑',
  agent: 'AI 修改',
  restore: '版本恢复',
}

function formatRevisionTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export interface AgentCanvasHistoryProps {
  canvasId: string
  currentRevision: number
  /** 消息引用点进来时要在历史里标记的版本（可选，见文档 §10.3） */
  markedRevision?: number | null
  readOnly?: boolean
  onRestore: (revision: number) => void
}

export function AgentCanvasHistory({ canvasId, currentRevision, markedRevision, readOnly = false, onRestore }: AgentCanvasHistoryProps) {
  const [revisions, setRevisions] = useState<AgentCanvasRevisionMeta[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setRevisions(null)
    setError('')
    void canvasApi().listRevisions(canvasId).then((result) => {
      if (cancelled) return
      if (result.success && result.revisions) setRevisions(result.revisions)
      else setError(result.error || '版本列表加载失败')
    })
    return () => { cancelled = true }
  }, [canvasId, currentRevision])

  if (error) {
    return <div className="px-3 py-4 text-destructive text-xs">{error}</div>
  }
  if (!revisions) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-6 text-muted-foreground text-xs">
        <Spinner size="sm" />
        加载版本历史…
      </div>
    )
  }
  if (revisions.length === 0) {
    return <div className="px-3 py-4 text-muted-foreground text-xs">暂无历史版本</div>
  }

  return (
    <div className="ct-agent-scrollbar max-h-72 overflow-y-auto p-1.5">
      {revisions.map((revision) => {
        const isCurrent = revision.revision === currentRevision
        return (
          <div
            className={`flex items-center gap-2.5 rounded-(--agent-radius,12px) px-2.5 py-2 ${
              isCurrent ? 'bg-primary/10' : 'hover:bg-accent/40'
            }`}
            key={revision.revision}
          >
            <Clock className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-foreground text-xs">
                <span className="font-medium">v{revision.revision}</span>
                <span className="text-muted-foreground">· {SOURCE_LABEL[revision.source] || revision.source}</span>
                {isCurrent && <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">当前</span>}
                {markedRevision === revision.revision && !isCurrent && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">消息引用</span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {formatRevisionTime(revision.createdAt)} · {revision.contentLength} 字符
              </div>
            </div>
            {!isCurrent && !readOnly && (
              <HeroButton onPress={() => onRestore(revision.revision)} size="sm" variant="tertiary">
                恢复
              </HeroButton>
            )}
          </div>
        )
      })}
    </div>
  )
}
