/**
 * 消息里的 Canvas 引用行 —— data-canvas part 的紧凑展示（不含正文），点击打开右侧面板。
 * 见 Docs Canvas 文档 §10.3。
 */
import { ChevronRight, Code, FileText } from '@gravity-ui/icons'
import type { AgentCanvasRefData } from './agentCanvasTypes'

const ACTION_LABEL: Record<AgentCanvasRefData['action'], string> = {
  created: '已创建',
  updated: '已更新',
  renamed: '已重命名',
  restored: '已恢复',
}

export interface AgentCanvasReferenceProps {
  data: AgentCanvasRefData
  onOpen?: (data: AgentCanvasRefData) => void
}

export function AgentCanvasReference({ data, onOpen }: AgentCanvasReferenceProps) {
  const KindIcon = data.kind === 'code' ? Code : FileText
  return (
    <button
      className="my-1 flex w-full max-w-100 items-center gap-2.5 rounded-(--agent-radius,12px) border border-border bg-surface/70 px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent/40"
      onClick={() => onOpen?.(data)}
      type="button"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-(--agent-radius,12px) bg-primary/10 text-primary">
        <KindIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground text-sm">{data.title || '未命名画布'}</span>
        <span className="block text-muted-foreground text-xs">
          {ACTION_LABEL[data.action] || '已更新'} · v{data.revision}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs">
        打开
        <ChevronRight className="size-3.5" />
      </span>
    </button>
  )
}
