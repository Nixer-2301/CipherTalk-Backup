/**
 * 消息渲染用的小型展示组件：模型能力图标、模型下拉项、计划卡片、压缩标记、执行过程折叠框、用户消息操作条。
 * 从 AgentPage.tsx 拆出。
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Card, Dropdown, Label } from '@heroui/react'
import { Bulb, Check, ChevronDown, Copy, CurlyBrackets, FileText, ListCheck, PencilToLine, Picture, Terminal, Wrench } from '@gravity-ui/icons'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import { MessageAction, MessageActions, MessageResponse } from '@/components/ai-elements/message'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import type { AIModelInfo } from '@/types/ai'

export type AgentModelItem = {
  chef: string
  chefSlug: string
  id: string
  kind?: 'local-agent'
  name: string
  modelDetail?: AIModelInfo
  disabled?: boolean
}

// 与设置页 ModelCapabilityStrip 同一套能力图标
const CAPABILITY_ICONS = [
  { key: 'reasoning', label: '推理', icon: Bulb, on: (d: AIModelInfo) => d.capabilities.reasoning },
  { key: 'tool', label: '工具调用', icon: Wrench, on: (d: AIModelInfo) => d.capabilities.toolCall },
  { key: 'structured', label: '结构化输出', icon: CurlyBrackets, on: (d: AIModelInfo) => d.capabilities.structuredOutput },
  { key: 'image', label: '图像输入', icon: Picture, on: (d: AIModelInfo) => d.modalities.input.includes('image') },
  { key: 'pdf', label: 'PDF', icon: FileText, on: (d: AIModelInfo) => d.modalities.input.includes('pdf') },
]

export function ModelCapabilityIcons({ detail }: { detail: AIModelInfo }) {
  const active = CAPABILITY_ICONS.filter((item) => item.on(detail))
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {active.map(({ key, label, icon: Icon }) => (
        <span className="inline-flex" key={key} title={`${label}：支持`}>
          <Icon className="size-3.5" />
        </span>
      ))}
    </span>
  )
}

export const ModelItem = memo(
  ({ model }: { model: AgentModelItem }) => {
    return (
      <Dropdown.Item id={model.id} key={model.id} textValue={model.name}>
        <Dropdown.ItemIndicator />
        {model.kind === 'local-agent'
          ? <Terminal className="size-5 shrink-0 text-muted" />
          : model.chefSlug && <AIProviderLogo providerId={model.chefSlug} alt={model.chef} className="shrink-0" size={20} />}
        <Label className="min-w-0 flex-1 truncate text-left">{model.name}</Label>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {model.modelDetail && <ModelCapabilityIcons detail={model.modelDetail} />}
          {model.disabled && <span className="text-[10px] text-muted-foreground">无工具</span>}
        </span>
      </Dropdown.Item>
    )
  }
)
ModelItem.displayName = 'ModelItem'

// 计划模式专用：把"执行计划"正文装进单独的可折叠卡片，默认收起，点击标题展开看详情。
export function PlanCard({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-border bg-surface">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-sm hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ListCheck className="size-4 shrink-0 text-muted-foreground" />
        <span>执行计划</span>
        {streaming
          ? <span className="font-normal text-muted-foreground text-xs">生成中…</span>
          : <span className="font-normal text-muted-foreground text-xs">{open ? '点击收起' : '点击展开查看详情'}</span>}
        <ChevronDown className={`ml-auto size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-border border-t px-3 py-2">
          <MessageResponse isStreaming={streaming}>{text}</MessageResponse>
        </div>
      )}
    </div>
  )
}

// 上下文自动压缩标记（data-compaction part）：占满超过模型窗口 90% 时，早期历史被 AI 摘要折叠。
// 作为历史性记录持久落在消息里——点开看摘要，全程都在。
export type CompactionPartData = {
  summary?: string
  foldedMessages?: number
  approxTokensBefore?: number
  approxTokensAfter?: number
  contextWindow?: number
}

export function CompactionMarker({ data }: { data: CompactionPartData }) {
  const [open, setOpen] = useState(false)
  const { approxTokensBefore: before, approxTokensAfter: after, contextWindow } = data
  const triggeredPct = before && contextWindow ? Math.round((before / contextWindow) * 100) : null
  const savedPct = before && after && before > after ? Math.round((1 - after / before) * 100) : null
  return (
    <div className="my-3">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground text-xs"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1">
          <FileText className="size-3.5 shrink-0" />
          上下文已自动压缩
          {triggeredPct != null && <span className="text-muted-foreground/80">· 触发于 {triggeredPct}%</span>}
          {savedPct != null && savedPct > 0 && <span className="text-muted-foreground/80">· 省 {savedPct}%</span>}
          <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {open && data.summary && (
        <div className="mt-2 whitespace-pre-wrap wrap-break-word rounded-(--agent-radius,12px) border border-border bg-surface/70 px-3 py-2 text-muted-foreground text-xs leading-6">
          {data.summary}
        </div>
      )}
    </div>
  )
}

// 工具调用参数：默认收起，用户想看点开就有。数据大时截断，避免刷屏。
const TOOL_IO_CHAR_CAP = 4000

function formatToolValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function ToolIOSection({ label, text }: { label: string; text: string }) {
  if (!text) return null
  const clipped = text.length > TOOL_IO_CHAR_CAP ? `${text.slice(0, TOOL_IO_CHAR_CAP)}\n…（已截断，共 ${text.length} 字）` : text
  return (
    <Card className="mt-1.5 w-fit max-w-full gap-1" variant="transparent">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap wrap-break-word text-[11px] text-foreground leading-5">{clipped}</pre>
    </Card>
  )
}

export function ToolIODetails({ input }: { input?: unknown }) {
  const [open, setOpen] = useState(false)
  const inputText = formatToolValue(input)
  if (!inputText) return null
  return (
    <div className="mt-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 text-muted-foreground text-[11px] hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? '收起调用详情' : '查看调用详情'}
      </button>
      {open && (
        <ToolIOSection label="参数" text={inputText} />
      )}
    </div>
  )
}

// 外层进行中自动展开、结束后自动收起；内部步骤详情各自保持默认收起。
export function MessageChainOfThought({
  active,
  children,
  persistedElapsedMs,
}: {
  active: boolean
  children: ReactNode
  persistedElapsedMs?: number
}) {
  const [open, setOpen] = useState(active)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const startedAtRef = useRef<number | null>(active ? Date.now() : null)
  useEffect(() => {
    setOpen(active)
  }, [active])
  useEffect(() => {
    if (!active) {
      if (startedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
      }
      return
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now()
    const updateElapsed = () => {
      if (startedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
      }
    }
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const displayedSeconds = startedAtRef.current !== null
    ? elapsedSeconds
    : typeof persistedElapsedMs === 'number' && Number.isFinite(persistedElapsedMs)
      ? Math.max(0, Math.floor(persistedElapsedMs / 1000))
      : null
  const elapsedText = displayedSeconds === null
    ? ''
    : displayedSeconds >= 60
      ? `${Math.floor(displayedSeconds / 60)}分${displayedSeconds % 60}秒`
      : `${displayedSeconds}秒`
  return (
    <ChainOfThought onOpenChange={setOpen} open={open}>
      <ChainOfThoughtHeader>{active ? '处理中' : '已处理'}{elapsedText ? ` ${elapsedText}` : ''}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>{children}</ChainOfThoughtContent>
    </ChainOfThought>
  )
}

export function UserMessageActions({
  copied,
  messageText,
  onCopy,
  onEdit,
}: {
  copied: boolean
  messageText: string
  onCopy: () => void
  onEdit: () => void
}) {
  if (!messageText) return null

  return (
    <div className="-mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <MessageActions aria-label="用户消息操作" className="rounded-(--agent-radius,12px) bg-background/80 px-1 py-0.5 shadow-xs ring-1 ring-border/60 backdrop-blur">
        <MessageAction
          label="复制"
          onClick={onCopy}
          tooltip={copied ? '已复制' : '复制'}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </MessageAction>
        <MessageAction
          label="编辑"
          onClick={onEdit}
          tooltip="编辑"
        >
          <PencilToLine className="size-3.5" />
        </MessageAction>
      </MessageActions>
    </div>
  )
}
