/**
 * 消息/工具渲染相关的纯函数 + 小组件：工具名映射、执行过程分段、检索徽标、出处列表等。
 * 从 AgentPage.tsx 拆出，供主组件和 AgentSubAgentProgress 等复用。
 */
import { Tooltip } from '@heroui/react'
import { ArrowUpRightFromSquare, FileText, Globe, QuoteOpen } from '@gravity-ui/icons'
import { useState } from 'react'
import { isToolUIPart, type UIMessage } from 'ai'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Shimmer } from '@/components/ai-elements/shimmer'

// ====== 计划模式控制标记 ======
const PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN = /<!--\s*ciphertalk:delegate_analysis=required\s*-->/i
const PLAN_CONTROL_MARKER_PATTERN = /<!--\s*ciphertalk:delegate_analysis=(?:required|not_required)\s*-->/gi

export function stripPlanControlMarkers(text: string): string {
  return text.replace(PLAN_CONTROL_MARKER_PATTERN, '').trim()
}

export function planRequiresDelegateAnalysis(text: string): boolean {
  return PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN.test(text)
}

// ====== 工具名 → 中文标签 ======
export const TOOL_LABELS: Record<string, string> = {
  list_contacts: '查看联系人',
  search_messages: '搜索聊天记录',
  semantic_search: '语义检索聊天记录',
  get_context: '查看上下文',
  get_timeline: '查看时间线',
  transcribe_voice_message: '转写语音消息',
  chat_stats: '聊天统计',
  list_groups: '查看群聊列表',
  group_members: '查看群成员',
  group_member_ranking: '群成员活跃排行',
  query_sql: '查询数据库',
  update_plan: '更新计划',
  code_workspace_status: '查看工作区状态',
  code_list_files: '列出文件',
  code_read_file: '读取文件',
  code_get_dev_server_logs: '查看开发服务器日志',
  code_get_browser_diagnostics: '查看浏览器诊断',
  code_replace_in_file: '编辑文件',
  code_write_file: '写入文件',
  code_delete_file: '删除文件',
  code_run_command: '运行命令',
  code_start_dev_server: '启动开发服务器',
  code_stop_dev_server: '停止开发服务器',
  delegate_analysis: '委托子助手',
  remember: '保存记忆',
  recall: '查找记忆',
  list_memories: '查看记忆',
  forget: '删除记忆',
  consolidate_memory: '整理记忆',
  search_moments: '搜索朋友圈',
  moments_stats: '朋友圈统计',
  web_search: '联网搜索',
  google_search: '联网搜索',
  generate_image: '生成图片',
  search_moment_media: '找朋友圈图片',
  search_media: '找历史媒体',
  search_similar_media: '以图找图',
  inspect_media_image: '识别历史图片',
  send_media_from_history: '发送历史媒体',
  search_stickers: '翻表情包',
  send_sticker: '发表情包',
  send_random_image: '抽一张图片',
  send_wechat_media: '回复微信媒体',
  send_wechat_file: '回复微信文件',
  export_chat: '导出聊天记录',
  find_files: '查找本机文件',
  search_local_files: '搜索本机内容',
  index_local_files: '索引本机文件',
  add_knowledge_source: '加入资料库',
  search_knowledge: '搜索资料库',
  remove_knowledge_source: '移除资料来源',
  create_artifact: '生成产物文件',
  create_task: '创建任务',
  list_tasks: '查看任务',
  update_task: '更新任务',
  cancel_task: '取消任务',
  run_task_now: '立即运行任务',
  list_audit_logs: '查看审计',
  rollback_operation: '回滚操作',
  desktop_screenshot: '桌面截图',
  desktop_ocr: '桌面 OCR',
  audit_memories: '记忆体检',
  apply_memory_fix: '修复记忆',
  persona_control: '数字分身',
  auto_memory: '自动记忆',
  // 本地编码智能体（codex）的结构化事件
  run_command: '运行命令',
  file_change: '文件变更',
}

export type PersonaControlOutput = {
  success?: boolean
  action?: 'open_persona_chat' | 'ask_persona_build' | 'build_persona' | 'build_session_vectors'
  sessionId?: string
  displayName?: string
  message?: string
  error?: string
}

export function formatToolName(toolName: string) {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__')
    const server = parts[0] || 'server'
    const tool = parts.slice(1).join('__') || 'tool'
    return `MCP: ${server}/${tool}`
  }
  return TOOL_LABELS[toolName] ?? toolName.replace(/[_-]+/g, ' ')
}

const COMMAND_TOOL_NAMES = new Set(['code_run_command', 'run_command'])

export function isCommandTool(toolName: string) {
  return COMMAND_TOOL_NAMES.has(toolName)
}

function formatCommandArg(value: unknown) {
  const text = String(value)
  return !text || /[\s"']/.test(text) ? JSON.stringify(text) : text
}

function commandTextFrom(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const commandLine = typeof record.commandLine === 'string' ? record.commandLine.trim() : ''
  if (commandLine) return commandLine
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (!command) return ''
  const args = Array.isArray(record.args) ? record.args.map(formatCommandArg) : []
  return [command, ...args].join(' ')
}

function commandOutputFailed(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const record = output as Record<string, unknown>
  if (record.success === false) return true
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  return ['failed', 'error', 'timed_out', 'cancelled', 'canceled'].includes(status)
}

export function formatToolStepLabel(toolName: string, state: string | undefined, input?: unknown, output?: unknown) {
  if (!isCommandTool(toolName)) return formatToolName(toolName)
  const command = commandTextFrom(input) || commandTextFrom(output)
  const failed = state === 'output-error' || commandOutputFailed(output)
  const done = state === 'output-available'
  const prefix = failed ? '运行失败' : done ? '已运行' : '正在运行'
  return command ? `${prefix} ${command}` : `${prefix}命令`
}

// ====== 工具审批一行动态说明（输入框上方审批条用）======
// 通用兜底：不为每个工具写专属映射，按常见字段名取第一个命中的当关键信息
const APPROVAL_DETAIL_KEYS = ['title', 'command', 'filePath', 'media', 'path', 'query', 'sessionId', 'md5', 'name']

export function describeToolApprovalRequest(toolName: string, input: unknown): string {
  const label = formatToolName(toolName)
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  if (!record) return label
  for (const key of APPROVAL_DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return `${label} · ${value.trim().slice(0, 60)}`
    }
  }
  return label
}

export function getPersonaControlOutput(part: unknown): PersonaControlOutput | null {
  const p = part as { type?: unknown; state?: unknown; output?: unknown }
  if (p?.type !== 'tool-persona_control' || p.state !== 'output-available') return null
  if (!p.output || typeof p.output !== 'object') return null
  return p.output as PersonaControlOutput
}

export function renderChainLabel(label: string, active: boolean) {
  if (!active) return label
  return (
    <Shimmer as="span" duration={1.25}>
      {label}
    </Shimmer>
  )
}

export function formatElapsed(ms: number) {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${Math.round(ms / 100) / 10}s`
}

export function toolProgressKey(toolName: string, toolCallId?: string) {
  return toolCallId ? `call:${toolCallId}` : `name:${toolName}`
}

export function toolPartProgressKey(part: unknown, toolName: string) {
  const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
    ? (part as { toolCallId: string }).toolCallId
    : undefined
  return toolProgressKey(toolName, toolCallId)
}

export function getDelegateTasks(part: unknown): string[] {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const tasks = (input as { tasks?: unknown }).tasks
  if (Array.isArray(tasks)) {
    return tasks
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const task = (item as { task?: unknown }).task
        return typeof task === 'string' ? task.trim() : ''
      })
      .filter(Boolean)
  }
  const task = (input as { task?: unknown }).task
  return typeof task === 'string' && task.trim() ? [task.trim()] : []
}

export type AgentMessagePart = UIMessage['parts'][number]
export type AgentChainPart = AgentMessagePart & {
  input?: unknown
  output?: unknown
  state?: string
  errorText?: string
}

export function isAgentChainPart(part: AgentMessagePart): part is AgentChainPart {
  return part.type === 'reasoning' || isToolUIPart(part)
}

// 参考 Claude 的消息展示：按 parts 原始顺序渲染，只把"连续"的思考/工具调用合并成一个执行过程块，
// 思考与正文交错时保持时间顺序，而不是把所有思考都提到正文前面。
export type AgentRenderSegment =
  | { kind: 'chain'; items: Array<{ part: AgentChainPart; index: number }> }
  | { kind: 'part'; part: AgentMessagePart; index: number }

export function buildRenderSegments(parts: UIMessage['parts']): AgentRenderSegment[] {
  const segments: AgentRenderSegment[] = []
  parts.forEach((part, index) => {
    if (part.type === 'step-start') return
    if (isAgentChainPart(part)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'chain') last.items.push({ part, index })
      else segments.push({ kind: 'chain', items: [{ part, index }] })
    } else {
      segments.push({ kind: 'part', part, index })
    }
  })
  return segments
}

// ====== 检索工具输出徽标（召回方式/回退原因/命中方式）======
function collectToolBadges(value: unknown, badges: string[] = []): string[] {
  if (badges.length >= 6 || value == null) return badges
  if (typeof value === 'string') {
    const matches = value.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"'<>)]*)?/gi) || []
    for (const match of matches) {
      const normalized = match.replace(/^https?:\/\//i, '').replace(/\/$/, '')
      if (!badges.includes(normalized)) badges.push(normalized)
      if (badges.length >= 6) break
    }
    return badges
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolBadges(item, badges)
    return badges
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectToolBadges(item, badges)
  }
  return badges
}

const RETRIEVAL_MODE_LABELS: Record<string, string> = {
  hybrid: '召回: 混合',
  keyword: '召回: 关键词',
  vector: '召回: 向量',
}

const RETRIEVAL_FALLBACK_LABELS: Record<string, string> = {
  missing_session: '回退: 未限定会话',
  embedding_not_ready: '回退: 未配置向量',
  vector_no_hits: '回退: 向量无命中',
  vector_error: '回退: 向量失败',
}

const MATCHED_BY_LABELS: Record<string, string> = {
  both: '命中: 向量+关键词',
  vector: '命中: 向量',
  keyword: '命中: 关键词',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function pushBadge(badges: string[], label?: string) {
  if (label && !badges.includes(label)) badges.push(label)
}

function collectMatchedByBadges(value: unknown, badges: string[]) {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const item of items) {
    const obj = asRecord(item)
    const matchedBy = typeof obj?.matchedBy === 'string' ? obj.matchedBy : ''
    if (matchedBy) seen.add(matchedBy)
  }
  for (const key of ['both', 'vector', 'keyword']) {
    if (seen.has(key)) pushBadge(badges, MATCHED_BY_LABELS[key])
  }
}

export function collectRetrievalBadges(toolName: string, output: unknown): string[] {
  if (toolName !== 'semantic_search' && toolName !== 'recall' && toolName !== 'search_messages') return []
  const obj = asRecord(output)
  if (!obj) return []
  const retrieval = asRecord(obj.retrieval)
  const badges: string[] = []
  const mode = typeof retrieval?.mode === 'string'
    ? retrieval.mode
    : typeof obj.mode === 'string'
      ? obj.mode
      : ''
  pushBadge(badges, RETRIEVAL_MODE_LABELS[mode] || (mode ? `召回: ${mode}` : undefined))
  const fallbackReason = typeof retrieval?.fallbackReason === 'string' ? retrieval.fallbackReason : ''
  pushBadge(badges, RETRIEVAL_FALLBACK_LABELS[fallbackReason])
  const rerank = asRecord(retrieval?.rerank)
  if (rerank?.applied === true) pushBadge(badges, '重排: 已应用')
  else if (rerank?.enabled === true) pushBadge(badges, '重排: 已回退')
  collectMatchedByBadges(toolName === 'recall' ? obj.memories : obj.hits, badges)
  return badges.slice(0, 5)
}
// collectToolBadges 目前只在检索徽标之外的历史工具展示里可能用到，保留导出以防未来复用。
export { collectToolBadges }

// ====== 模型厂商来源（AI SDK source-url / source-document）======
export type ProviderSourceItem =
  | { kind: 'url'; id: string; url: string; title: string; host: string }
  | { kind: 'document'; id: string; title: string; mediaType: string; filename?: string }

function normalizeProviderSourceUrl(value: unknown): { url: string; host: string } | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return {
      url: parsed.href,
      host: parsed.hostname.replace(/^www\./i, '') || parsed.host,
    }
  } catch {
    return null
  }
}

/** 提取 provider 原生搜索、网页抓取或文件检索返回的结构化来源。 */
export function extractProviderSources(parts: UIMessage['parts']): ProviderSourceItem[] {
  const items: ProviderSourceItem[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.type === 'source-url') {
      const normalized = normalizeProviderSourceUrl(part.url)
      if (!normalized || seen.has(`url:${normalized.url}`)) continue
      seen.add(`url:${normalized.url}`)
      items.push({
        kind: 'url',
        id: String(part.sourceId || normalized.url),
        url: normalized.url,
        title: String(part.title || '').trim() || normalized.host,
        host: normalized.host,
      })
      continue
    }
    if (part.type === 'source-document') {
      const title = String(part.title || part.filename || '').trim() || '引用文档'
      const identity = `document:${String(part.sourceId || `${title}:${part.mediaType}`)}`
      if (seen.has(identity)) continue
      seen.add(identity)
      items.push({
        kind: 'document',
        id: String(part.sourceId || identity),
        title,
        mediaType: String(part.mediaType || 'document'),
        ...(part.filename ? { filename: String(part.filename) } : {}),
      })
    }
  }
  return items.slice(0, 20)
}

function ProviderSourceIcon({ item }: { item: ProviderSourceItem }) {
  const [faviconFailed, setFaviconFailed] = useState(false)
  if (item.kind === 'document') return <FileText className="size-3.5" />
  if (faviconFailed) return <Globe className="size-3.5" />
  return (
    <img
      alt=""
      className="size-3.5 object-contain"
      onError={() => setFaviconFailed(true)}
      src={`${new URL(item.url).origin}/favicon.ico`}
    />
  )
}

export function MessageProviderSources({ items }: { items: ProviderSourceItem[] }) {
  if (items.length === 0) return null
  return (
    <Sources className="my-2 mb-2 w-full max-w-xl text-muted-foreground">
      <SourcesTrigger
        aria-label={`展开 ${items.length} 个在线来源`}
        className="w-fit gap-1.5 rounded-full py-0.5 text-muted-foreground hover:text-foreground"
        count={items.length}
      >
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {items.slice(0, 5).map((item, index) => (
            <span
              className={`relative inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-background bg-surface text-muted-foreground shadow-xs ${index > 0 ? '-ml-2.5' : ''}`}
              key={`provider-source-icon-${item.id}`}
            >
              <ProviderSourceIcon item={item} />
            </span>
          ))}
        </span>
        <span className="shrink-0 font-medium text-xs">查看详情</span>
      </SourcesTrigger>
      <SourcesContent className="mt-2 w-full gap-1">
        {items.map((item) => {
          const detail = item.kind === 'url' ? item.host : (item.filename || item.mediaType)
          const content = (
            <>
              <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface text-muted-foreground shadow-xs">
                <ProviderSourceIcon item={item} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground text-xs">{item.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
              </span>
            </>
          )
          return item.kind === 'url' ? (
            <Source
              aria-label={`打开来源：${item.title}`}
              className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-foreground no-underline hover:bg-default/50"
              href={item.url}
              key={`provider-source-detail-${item.id}`}
            >
              {content}
              <ArrowUpRightFromSquare className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            </Source>
          ) : (
            <div
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
              key={`provider-source-detail-${item.id}`}
            >
              {content}
            </div>
          )
        })}
      </SourcesContent>
    </Sources>
  )
}

// ====== 出处（让用户能核对答案来源）======
export type SourceItem = { id: string; sessionId: string; localId?: number; time?: string; sender?: string; text: string }

/** 从助手消息的工具结果里抽出"被引用的真实消息"作为出处。 */
export function extractSources(parts: any[]): SourceItem[] {
  const items: SourceItem[] = []
  const seen = new Set<string>()
  const push = (it: SourceItem) => {
    if (!it.text || !it.sessionId || seen.has(it.id)) return
    seen.add(it.id)
    items.push(it)
  }
  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue
    const name = part.type.replace(/^tool-/, '')
    const out: any = part.output
    if (!out || out.error) continue
    if (Array.isArray(out.evidence)) {
      for (const item of out.evidence) {
        push({
          id: String(item.id || `${item.sessionId}:${item.localId ?? item.text ?? ''}`),
          sessionId: String(item.sessionId || ''),
          localId: item.localId,
          time: item.time,
          sender: item.sender,
          text: String(item.text || ''),
        })
      }
      continue
    }
    if (name === 'get_context' || name === 'get_timeline') {
      const sid = out.sessionId
      for (const m of out.messages || []) {
        push({ id: `${sid}:${m.localId}`, sessionId: sid, localId: m.localId, time: m.time, sender: m.sender, text: m.text })
      }
    } else if (name === 'search_messages' || name === 'semantic_search') {
      const arr = Array.isArray(out) ? out : out.hits || []
      for (const h of arr) {
        const lid = h?.anchor?.localId
        push({ id: `${h.sessionId}:${lid ?? h.excerpt ?? ''}`, sessionId: h.sessionId, localId: lid, time: h.time, sender: h.sender, text: h.excerpt || h.title })
      }
    }
  }
  return items.slice(0, 15)
}

export function MessageSources({
  items,
  nameOf,
}: {
  items: SourceItem[]
  nameOf: (sessionId: string) => string
}) {
  if (items.length === 0) return null
  const senderNameOf = (item: SourceItem) => item.sender || nameOf(item.sessionId)
  return (
    <Sources>
      <SourcesTrigger count={items.length}>
        <QuoteOpen className="size-3.5" />
        <span className="font-medium">聊天出处 {items.length} 条</span>
      </SourcesTrigger>
      <SourcesContent className="w-full flex-row flex-wrap gap-1.5">
        {items.map((it, index) => {
          const senderName = senderNameOf(it)
          return (
            <Tooltip closeDelay={80} delay={120} key={it.id}>
              <Tooltip.Trigger>
                <span className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <QuoteOpen className="size-3 shrink-0 opacity-70" />
                  <span className="shrink-0">{index + 1}</span>
                  <span className="truncate">{senderName}</span>
                </span>
              </Tooltip.Trigger>
              <Tooltip.Content className="w-80 text-xs" placement="top start">
                <div className="mb-1 font-medium text-[11px] text-muted-foreground">
                  {[senderName, it.time].filter(Boolean).join(' · ')}
                </div>
                <div className="max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{it.text}</div>
              </Tooltip.Content>
            </Tooltip>
          )
        })}
      </SourcesContent>
    </Sources>
  )
}
