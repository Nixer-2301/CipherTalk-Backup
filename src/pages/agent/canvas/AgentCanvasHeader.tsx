/**
 * Canvas 面板头部 —— 紧凑工具栏：标题（可改名）、保存状态、历史、复制、下载、归档、关闭。
 * 窄屏（<900px 全屏态）左侧显示返回按钮回到对话；关闭只关视图不删数据。
 */
import { useEffect, useRef, useState } from 'react'
import { Button as HeroButton, Tooltip } from '@heroui/react'
import { ArrowDownToLine, ArrowLeft, Check, ClockArrowRotateLeft, Code, Copy, Eye, FileText, PencilToLine, TrashBin, Xmark } from '@gravity-ui/icons'
import type { AgentCanvasRecord, AgentCanvasSaveStatus } from './agentCanvasTypes'
import { saveStatusLabel } from './agentCanvasStore'

export interface AgentCanvasHeaderProps {
  record: AgentCanvasRecord
  saveStatus: AgentCanvasSaveStatus
  historyOpen: boolean
  copied: boolean
  readOnly?: boolean
  /** document 类型才有预览/编辑切换；code 类型恒为编辑态，传 null 隐藏按钮 */
  viewMode: 'preview' | 'edit' | null
  onToggleViewMode?: () => void
  onRename: (title: string) => void
  onToggleHistory: () => void
  onCopy: () => void
  onDownload: () => void
  onArchive: () => void
  onClose: () => void
}

function statusClass(status: AgentCanvasSaveStatus): string {
  if (status === 'conflict' || status === 'save-failed') return 'text-destructive'
  if (status === 'saving' || status === 'dirty') return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground'
}

export function AgentCanvasHeader({
  record,
  saveStatus,
  historyOpen,
  copied,
  readOnly = false,
  viewMode,
  onToggleViewMode,
  onRename,
  onToggleHistory,
  onCopy,
  onDownload,
  onArchive,
  onClose,
}: AgentCanvasHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(record.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setTitleDraft(record.title)
  }, [editing, record.title])
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commitRename = () => {
    setEditing(false)
    if (readOnly) return
    const next = titleDraft.trim()
    if (next && next !== record.title) onRename(next)
  }

  const KindIcon = record.kind === 'code' ? Code : FileText

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <Tooltip delay={0}>
        <HeroButton
          aria-label="返回对话"
          className="hidden size-8 shrink-0 p-0 max-[900px]:inline-flex"
          isIconOnly
          onPress={onClose}
          size="sm"
          variant="tertiary"
        >
          <ArrowLeft className="size-4" />
        </HeroButton>
        <Tooltip.Content placement="bottom">返回对话</Tooltip.Content>
      </Tooltip>
      <KindIcon className="size-4 shrink-0 text-muted-foreground" />
      {editing ? (
        <input
          aria-label="编辑画布标题"
          className="h-8 min-w-0 flex-1 rounded-(--agent-radius,12px) border border-border bg-background px-2 text-foreground text-sm outline-none focus:border-ring"
          maxLength={120}
          onBlur={commitRename}
          onChange={(event) => setTitleDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commitRename() }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
          }}
          ref={inputRef}
          value={titleDraft}
        />
      ) : (
        <button
          className="min-w-0 flex-1 truncate rounded-(--agent-radius,12px) px-1.5 py-1 text-left font-medium text-foreground text-sm hover:bg-accent/40"
          disabled={readOnly}
          onClick={() => setEditing(true)}
          title={`重命名：${record.title}`}
          type="button"
        >
          {record.title}
          {record.status === 'archived' && <span className="ml-1.5 text-muted-foreground text-xs">（已归档）</span>}
        </button>
      )}
      <span className={`shrink-0 text-[11px] ${statusClass(saveStatus)}`}>
        {saveStatusLabel(saveStatus)} · v{record.revision}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {viewMode !== null && (
          <Tooltip delay={0}>
            <HeroButton
              aria-label={viewMode === 'preview' ? '编辑' : '预览'}
              className="size-8 p-0"
              isIconOnly
              onPress={() => onToggleViewMode?.()}
              size="sm"
              variant="tertiary"
            >
              {viewMode === 'preview' ? <PencilToLine className="size-4" /> : <Eye className="size-4" />}
            </HeroButton>
            <Tooltip.Content placement="bottom">{viewMode === 'preview' ? '编辑源码' : '预览渲染效果'}</Tooltip.Content>
          </Tooltip>
        )}
        <Tooltip delay={0}>
          <HeroButton
            aria-label="版本历史"
            className="size-8 p-0"
            isIconOnly
            onPress={onToggleHistory}
            size="sm"
            variant={historyOpen ? 'secondary' : 'tertiary'}
          >
            <ClockArrowRotateLeft className="size-4" />
          </HeroButton>
          <Tooltip.Content placement="bottom">版本历史</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <HeroButton
            aria-label="复制全文"
            className="size-8 p-0"
            isIconOnly
            onPress={onCopy}
            size="sm"
            variant="tertiary"
          >
            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </HeroButton>
          <Tooltip.Content placement="bottom">复制全文</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <HeroButton
            aria-label="下载"
            className="size-8 p-0"
            isIconOnly
            onPress={onDownload}
            size="sm"
            variant="tertiary"
          >
            <ArrowDownToLine className="size-4" />
          </HeroButton>
          <Tooltip.Content placement="bottom">下载到本机</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <HeroButton
            aria-label="归档画布"
            className="size-8 p-0"
            isIconOnly
            isDisabled={readOnly}
            onPress={onArchive}
            size="sm"
            variant="tertiary"
          >
            <TrashBin className="size-4" />
          </HeroButton>
          <Tooltip.Content placement="bottom">归档画布（不物理删除）</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <HeroButton
            aria-label="关闭面板"
            className="size-8 p-0 max-[900px]:hidden"
            isIconOnly
            onPress={onClose}
            size="sm"
            variant="tertiary"
          >
            <Xmark className="size-4" />
          </HeroButton>
          <Tooltip.Content placement="bottom">关闭面板（画布不会被删除）</Tooltip.Content>
        </Tooltip>
      </div>
    </div>
  )
}
