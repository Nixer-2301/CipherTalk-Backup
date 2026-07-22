/**
 * 子助手/委托任务的执行进度面板：分组、去重合并、格式化展示 + 模型首个输出前的等待文案。
 * 从 AgentPage.tsx 拆出。
 */
import { useEffect, useState } from 'react'
import { Card } from '@heroui/react'
import { CircleInfo, Magnifier, Sparkles, Wrench } from '@gravity-ui/icons'
import type { AgentProgressEvent } from '@/features/aiagent/transport/ipcChatTransport'
import { Loader } from '@/components/ai-elements/loader'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { formatElapsed, formatToolName } from './agentMessageHelpers'

const SUB_AGENT_PROGRESS_LIMIT = 48
export const AGENT_PENDING_TITLE = '正在准备请求'
const AGENT_PREP_PROGRESS_TITLE = '大模型准备中'
// 准备阶段由主进程合并成单一可见步骤；这里只隐藏可能存在的本地占位项。
const HIDDEN_PREP_PROGRESS_TITLES = new Set([
  AGENT_PENDING_TITLE,
])

export function shouldDisplayAgentProgress(progress: AgentProgressEvent) {
  if (progress.stage === 'error') return true
  if (progress.visible === false) return false
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_started' && progress.title === AGENT_PREP_PROGRESS_TITLE) return true
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_started' && HIDDEN_PREP_PROGRESS_TITLES.has(progress.title)) return false
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_finished' && progress.title === '回答生成完成') return false
  return true
}

function subAgentProgressGroupKey(progress: AgentProgressEvent) {
  return [
    progress.parentToolCallId || 'delegate',
    progress.subTaskId || progress.subTaskTitle || 'single',
  ].join(':')
}

function subAgentProgressKey(progress: AgentProgressEvent) {
  const groupKey = subAgentProgressGroupKey(progress)
  if (progress.toolCallId) return `${groupKey}:call:${progress.toolCallId}`
  if (progress.toolName && (progress.stage === 'tool_started' || progress.stage === 'tool_finished' || progress.stage === 'error')) {
    return `${groupKey}:tool:${progress.depth ?? 0}:${progress.toolName}`
  }
  return `${groupKey}:event:${progress.depth ?? 0}:${progress.stage}:${progress.title}:${progress.sessionId ?? ''}`
}

function sameSubAgentProgressEvent(left: AgentProgressEvent, right: AgentProgressEvent) {
  return left.stage === right.stage
    && left.title === right.title
    && left.detail === right.detail
    && left.visible === right.visible
    && left.category === right.category
    && left.toolName === right.toolName
    && left.toolCallId === right.toolCallId
    && left.parentToolCallId === right.parentToolCallId
    && left.subTaskId === right.subTaskId
    && left.subTaskTitle === right.subTaskTitle
    && left.sessionId === right.sessionId
    && left.elapsedMs === right.elapsedMs
    && left.messagesScanned === right.messagesScanned
    && left.indexedCount === right.indexedCount
    && left.sessionsScanned === right.sessionsScanned
    && left.coverage === right.coverage
    && left.depth === right.depth
    && left.at === right.at
}

export function mergeSubAgentProgress(prev: AgentProgressEvent[], progress: AgentProgressEvent) {
  const key = subAgentProgressKey(progress)
  const existing = prev.find((item) => subAgentProgressKey(item) === key)
  if (existing && sameSubAgentProgressEvent(existing, progress)) return prev
  const next = prev.filter((item) => subAgentProgressKey(item) !== key)
  return [...next, progress].slice(-SUB_AGENT_PROGRESS_LIMIT)
}

function formatSubAgentStage(progress: AgentProgressEvent) {
  switch (progress.stage) {
    case 'tool_started':
      return '开始'
    case 'tool_finished':
      return '完成'
    case 'indexing':
      return '索引'
    case 'searching':
      return '检索'
    case 'error':
      return '出错'
    case 'run_finished':
      return '完成'
    case 'run_started':
    default:
      return '启动'
  }
}

function formatSubAgentProgressTitle(progress: AgentProgressEvent) {
  if (progress.toolName) return `${formatToolName(progress.toolName)} · ${formatSubAgentStage(progress)}`
  return progress.title
}

function formatSubAgentProgressMeta(progress: AgentProgressEvent): string[] {
  const meta: string[] = []
  if (progress.depth != null) meta.push(`深度 ${progress.depth}`)
  if (progress.messagesScanned != null) meta.push(`扫描 ${progress.messagesScanned} 条`)
  if (progress.indexedCount != null) meta.push(`索引 ${progress.indexedCount} 条`)
  if (progress.sessionsScanned != null) meta.push(`会话 ${progress.sessionsScanned}`)
  if (progress.coverage) meta.push(progress.coverage)
  if (progress.elapsedMs != null) meta.push(formatElapsed(progress.elapsedMs))
  if (progress.detail) meta.push(progress.detail)
  return meta
}

function subAgentProgressIcon(progress: AgentProgressEvent) {
  if (progress.stage === 'searching') return Magnifier
  if (progress.stage === 'indexing') return Sparkles
  if (progress.stage === 'error') return CircleInfo
  return Wrench
}

// 等待模型首个输出的空窗期（可能 2~12s）轮播的安抚文案：让"死等"看起来像"它在忙"
const MODEL_WAITING_PHRASES = [
  '大模型正在酝酿措辞…',
  '正在翻箱倒柜整理思路…',
  '灵感马上就位…',
  '正在斟酌怎么回你…',
  '大模型还在打草稿…',
  '快了快了，正在组织语言…',
]

// 输出前的等待指示：只显示轮播的动态文案，不套「执行过程」折叠框，也不显示「大模型准备中」这类静态步骤
export function ModelWaitingLine() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * MODEL_WAITING_PHRASES.length))
  useEffect(() => {
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % MODEL_WAITING_PHRASES.length),
      3200,
    )
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Loader />
      <Shimmer as="span" duration={1.25}>{MODEL_WAITING_PHRASES[index]}</Shimmer>
    </div>
  )
}

function subAgentProgressDotClass(progress: AgentProgressEvent) {
  if (progress.stage === 'error') return 'bg-destructive'
  if (progress.stage === 'tool_finished' || progress.stage === 'run_finished') return 'bg-emerald-500'
  return 'bg-foreground/70'
}

function formatProgressTime(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function subAgentPanelTitle(latest: AgentProgressEvent) {
  if (latest.stage === 'error') return '子助手出错'
  if ((latest.depth ?? 0) === 0) {
    if (latest.stage === 'run_finished') return 'AI 助手已完成'
    return 'AI 助手准备中'
  }
  if (latest.stage === 'run_finished') return '子助手已完成'
  return '子助手运行中'
}

type SubAgentProgressGroup = {
  key: string
  title: string
  events: AgentProgressEvent[]
  latest: AgentProgressEvent
}

function groupSubAgentProgress(events: AgentProgressEvent[]): SubAgentProgressGroup[] {
  const groups = new Map<string, AgentProgressEvent[]>()
  for (const event of events) {
    const key = subAgentProgressGroupKey(event)
    groups.set(key, [...(groups.get(key) || []), event])
  }
  return Array.from(groups.entries()).map(([key, groupEvents], index) => {
    const latest = groupEvents[groupEvents.length - 1]
    return {
      key,
      title: latest.subTaskTitle || `子任务 ${index + 1}`,
      events: groupEvents,
      latest,
    }
  })
}

function formatSubAgentPanelTitle(groups: SubAgentProgressGroup[], latest: AgentProgressEvent) {
  if (groups.length <= 1) return subAgentPanelTitle(latest)
  const finished = groups.filter((group) => group.latest.stage === 'run_finished').length
  const failed = groups.filter((group) => group.latest.stage === 'error').length
  if (finished + failed >= groups.length) {
    return failed > 0 ? `子助手完成 ${finished}/${groups.length}` : `子助手已完成 ${groups.length}/${groups.length}`
  }
  return `${groups.length} 个子任务并行分析中`
}

export function SubAgentProgressPanel({ events, tasks }: { events: AgentProgressEvent[]; tasks?: string[] }) {
  if (events.length === 0) return null
  const latestKey = subAgentProgressKey(events[events.length - 1])
  const latest = events[events.length - 1]
  const toolCount = new Set(events.map((event) => event.toolName).filter(Boolean)).size
  const groups = groupSubAgentProgress(events)
  const finishedGroups = groups.filter((group) => group.latest.stage === 'run_finished').length
  const failedGroups = groups.filter((group) => group.latest.stage === 'error').length

  return (
    <div aria-live="polite" className="mt-1.5 space-y-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{formatSubAgentPanelTitle(groups, latest)}</span>
        <span className="min-w-0 truncate text-muted-foreground font-normal">
          {formatSubAgentProgressTitle(latest)}
        </span>
      </div>
      {tasks && tasks.length > 0 && (
        <Card className="w-fit max-w-full gap-1" variant="transparent">
          <div className="text-[11px] text-muted-foreground">委托任务</div>
          {tasks.length === 1 ? (
            <div className="line-clamp-3 whitespace-pre-wrap wrap-break-word">{tasks[0]}</div>
          ) : (
            <ol className="list-inside list-decimal space-y-0.5">
              {tasks.slice(0, 4).map((task, index) => (
                <li className="line-clamp-2 whitespace-pre-wrap wrap-break-word" key={`${index}-${task}`}>
                  {task}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}
      <div className="flex flex-wrap gap-1">
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{events.length} 条进度</span>
        {groups.length > 1 && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">完成 {finishedGroups}/{groups.length}</span>}
        {failedGroups > 0 && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">失败 {failedGroups}</span>}
        {toolCount > 0 && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{toolCount} 个工具</span>}
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">最近 {formatProgressTime(latest.at)}</span>
      </div>
      <div className="space-y-1.5 border-border/50 border-l pl-3">
        {groups.map((group) => {
          const groupLatestKey = subAgentProgressKey(group.latest)
          return (
            <div className="space-y-1" key={group.key}>
              {groups.length > 1 && (
                <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
                  <span className={`size-1.5 shrink-0 rounded-full ${subAgentProgressDotClass(group.latest)}`} />
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatSubAgentStage(group.latest)}</span>
                </div>
              )}
              <div className={groups.length > 1 ? 'space-y-1 border-border/40 border-l pl-3' : 'space-y-1'}>
                {group.events.slice(groups.length > 1 ? -4 : -SUB_AGENT_PROGRESS_LIMIT).map((progress) => {
                  const Icon = subAgentProgressIcon(progress)
                  const itemKey = subAgentProgressKey(progress)
                  const meta = formatSubAgentProgressMeta(progress)
                  const active = (itemKey === latestKey || itemKey === groupLatestKey)
                    && progress.stage !== 'tool_finished'
                    && progress.stage !== 'run_finished'
                    && progress.stage !== 'error'
                  return (
                    <div
                      className="flex min-w-0 items-start gap-2 text-muted-foreground"
                      key={itemKey}
                    >
                      <span className="relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
                        <Icon className="size-3.5" />
                        <span className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${subAgentProgressDotClass(progress)} ${active ? 'animate-pulse' : ''}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-foreground">{formatSubAgentProgressTitle(progress)}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{formatProgressTime(progress.at)}</span>
                        </div>
                        {meta.length > 0 && (
                          <div className="mt-0.5 flex min-w-0 flex-wrap gap-1">
                            {meta.map((item) => (
                              <span
                                className="max-w-full truncate rounded-(--agent-radius,12px) bg-muted/60 px-1.5 py-0.5"
                                key={item}
                                title={item}
                              >
                                {item}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
