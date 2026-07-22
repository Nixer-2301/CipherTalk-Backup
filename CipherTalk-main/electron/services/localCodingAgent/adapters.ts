import type {
  LocalCodingAgentDefinition,
  LocalCodingAgentKind,
  LocalCodingAgentRunMode,
} from './types'

export interface LocalCodingAgentCommand {
  command: string
  args: string[]
  display: string
}

// 密语注入给本地智能体的系统提示词。codex/opencode 以带分隔符的前缀塞进 prompt，claude 走 --append-system-prompt。
export const LOCAL_CODING_AGENT_SYSTEM_PROMPT = [
  '你是密语（CipherTalk）内置的本地编码智能体，运行在用户当前选中的代码工作区里。',
  '- 用中文回复。',
  '- 改动小而精准，只动与任务直接相关的代码，遵循仓库既有风格，不顺手重构无关代码。',
  '- 直接对工作区文件进行修改并说明改了什么，不要输出整段补丁让用户手动粘贴。',
  '- 需要时可以运行命令、读写文件来完成任务；先弄清问题再动手。',
].join('\n')

function withSystemPreamble(prompt: string): string {
  return `[密语系统指令]\n${LOCAL_CODING_AGENT_SYSTEM_PROMPT}\n\n---\n\n[用户任务]\n${prompt}`
}

export const DEFAULT_LOCAL_CODING_AGENT_CONFIG = {
  enabled: false,
  activeAgent: 'codex',
  agents: {
    codex: {
      kind: 'codex',
      name: 'Codex CLI',
      executablePath: '',
      timeoutMs: 1_800_000,
    },
    claude: {
      kind: 'claude-cli',
      name: 'Claude Code',
      executablePath: '',
      timeoutMs: 1_800_000,
    },
    opencode: {
      kind: 'opencode',
      name: 'OpenCode',
      executablePath: '',
      timeoutMs: 1_800_000,
    },
  },
} as const

export function commandNameForKind(kind: LocalCodingAgentKind): string {
  if (kind === 'claude-cli') return 'claude'
  if (kind === 'opencode') return 'opencode'
  if (kind === 'custom') return ''
  return 'codex'
}

function normalizeExecutable(agent: LocalCodingAgentDefinition): string {
  const configured = agent.executablePath.trim()
  if (configured) return configured
  return commandNameForKind(agent.kind)
}

function quoteForDisplay(value: string): string {
  if (!value) return '""'
  if (/[\s"]/g.test(value)) return `"${value.replace(/"/g, '\\"')}"`
  return value
}

function commandDisplay(command: string, args: string[]): string {
  return [command, ...args.map((arg) => arg.length > 120 ? `${arg.slice(0, 120)}...` : arg)]
    .map(quoteForDisplay)
    .join(' ')
}

function replaceTemplate(value: string, input: { prompt: string; cwd: string; mode: LocalCodingAgentRunMode; model?: string }): string {
  return value
    .replace(/\{\{prompt\}\}/g, input.prompt)
    .replace(/\{\{cwd\}\}/g, input.cwd)
    .replace(/\{\{mode\}\}/g, input.mode)
    .replace(/\{\{model\}\}/g, input.model || '')
}

export function buildLocalCodingAgentCommand(input: {
  agent: LocalCodingAgentDefinition
  prompt: string
  cwd: string
  mode: LocalCodingAgentRunMode
  model?: string
}): LocalCodingAgentCommand {
  const command = normalizeExecutable(input.agent)
  if (!command) throw new Error('未配置本地编码智能体可执行文件')

  if (input.agent.kind === 'custom') {
    const args = (input.agent.argsTemplate || ['{{prompt}}'])
      .map((arg) => replaceTemplate(arg, input))
      .filter((arg) => arg.length > 0)
    return { command, args, display: commandDisplay(command, args) }
  }

  if (input.agent.kind === 'codex') {
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--sandbox',
      input.mode === 'inspect' ? 'read-only' : 'workspace-write',
    ]
    if (input.model || input.agent.model) args.push('--model', input.model || input.agent.model || '')
    args.push(withSystemPreamble(input.prompt))
    return { command, args, display: commandDisplay(command, args) }
  }

  if (input.agent.kind === 'claude-cli') {
    const args = ['-p', input.prompt, '--append-system-prompt', LOCAL_CODING_AGENT_SYSTEM_PROMPT, '--output-format', 'stream-json', '--verbose']
    if (input.model || input.agent.model) args.push('--model', input.model || input.agent.model || '')
    return { command, args, display: commandDisplay(command, args) }
  }

  const args = ['run', '--format', 'json', '--dir', input.cwd]
  if (input.model || input.agent.model) args.push('--model', input.model || input.agent.model || '')
  if (input.mode !== 'inspect') args.push('--auto')
  args.push(withSystemPreamble(input.prompt))
  return { command, args, display: commandDisplay(command, args) }
}

export function extractStructuredText(value: unknown): { role: 'assistant' | 'tool' | 'system'; text: string } | null {
  if (!value || typeof value !== 'object') return null
  // claude stream-json / opencode 把文字放在 content[] 数组里，逐个下钻取第一条有文字的。
  if (Array.isArray(value)) {
    for (const element of value) {
      const nested = extractStructuredText(element)
      if (nested) return nested
    }
    return null
  }
  const item = value as Record<string, unknown>
  const role = item.role === 'tool' || item.type === 'tool' || item.type === 'tool_result'
    ? 'tool'
    : item.role === 'system' || item.type === 'system'
      ? 'system'
      : 'assistant'

  const candidates = [
    item.text,
    item.delta,
    item.content,
    item.message,
    item.summary,
    item.title,
    item.last_agent_message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return { role, text: candidate }
    }
    if (candidate && typeof candidate === 'object') {
      const nested = extractStructuredText(candidate)
      if (nested) return nested
    }
  }

  // codex exec --json 把正文包在 {type:"item.completed", item:{type:"agent_message", text:...}} 里，
  // 实际内容在 item 字段（app-server 协议才是 msg，两者都兼容一下）。
  const nestedContainer = item.message ?? item.item ?? item.msg
  if (nestedContainer && typeof nestedContainer === 'object') {
    const nested = extractStructuredText(nestedContainer)
    if (nested) return nested
  }
  return null
}

export interface LocalCodingAgentParsedEvent {
  message?: { role: 'assistant' | 'tool' | 'system'; text: string }
  activity?: { activity: 'reasoning' | 'tool'; toolName?: string; input?: unknown; output?: unknown; text?: string }
}

// codex exec --json 的每行是 ThreadEvent。只取终态 item.completed，映射成：
// agent_message → 回复正文；reasoning → 思考块；command_execution/file_change/mcp/web_search → 工具卡片。
// 字段名对照 codex-rs/exec/src/exec_events.rs。
export function parseCodexJsonEvent(value: unknown): LocalCodingAgentParsedEvent | null {
  if (!value || typeof value !== 'object') return null
  const evt = value as Record<string, unknown>
  if (evt.type !== 'item.completed' || !evt.item || typeof evt.item !== 'object') return null
  const item = evt.item as Record<string, unknown>
  const text = typeof item.text === 'string' ? item.text : ''
  switch (item.type) {
    case 'agent_message':
      return text.trim() ? { message: { role: 'assistant', text } } : null
    case 'reasoning':
      return text.trim() ? { activity: { activity: 'reasoning', text } } : null
    case 'command_execution':
      return { activity: { activity: 'tool', toolName: 'run_command', input: { command: item.command }, output: { output: item.aggregated_output, exit_code: item.exit_code, status: item.status } } }
    case 'file_change':
      return { activity: { activity: 'tool', toolName: 'file_change', input: { changes: item.changes }, output: { status: item.status } } }
    case 'mcp_tool_call':
      return { activity: { activity: 'tool', toolName: `mcp__${String(item.server || 'server')}__${String(item.tool || 'tool')}`, input: item.arguments, output: item.result ?? item.error } }
    case 'web_search':
      return { activity: { activity: 'tool', toolName: 'web_search', input: { query: item.query }, output: item.action } }
    default:
      return null
  }
}

function claudeContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// claude -p --output-format stream-json：assistant 消息的 content[] 里 text→正文、thinking→思考、tool_use→工具调用；
// user 消息的 content[] 里 tool_result 靠 tool_use_id 关联回工具输出。用 toolUses(按 job 维护)把 input+output 拼成一张卡。
// 一行可能含多个 content 块，故返回数组。
export function parseClaudeJsonEvent(
  value: unknown,
  toolUses: Map<string, { toolName: string; input: unknown }>,
): LocalCodingAgentParsedEvent[] {
  if (!value || typeof value !== 'object') return []
  const evt = value as Record<string, unknown>
  const message = evt.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: LocalCodingAgentParsedEvent[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (evt.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ message: { role: 'assistant', text: block.text } })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push({ activity: { activity: 'reasoning', text: block.thinking } })
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUses.set(block.id, { toolName: String(block.name || 'tool'), input: block.input })
      }
    } else if (evt.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = toolUses.get(block.tool_use_id)
      toolUses.delete(block.tool_use_id)
      out.push({ activity: { activity: 'tool', toolName: call?.toolName || 'tool', input: call?.input, output: claudeContentText(block.content) || block.content } })
    }
  }
  return out
}

// opencode run --format json：JSONL 流。text→正文；tool_use(工具完成时发，自带 input/output)→工具卡片。
export function parseOpencodeJsonEvent(value: unknown): LocalCodingAgentParsedEvent | null {
  if (!value || typeof value !== 'object') return null
  const evt = value as Record<string, unknown>
  const part = evt.part as Record<string, unknown> | undefined
  if (evt.type === 'text' && part && typeof part.text === 'string' && part.text.trim()) {
    return { message: { role: 'assistant', text: part.text } }
  }
  if (evt.type === 'tool_use' && part) {
    const state = (part.state as Record<string, unknown>) || {}
    return { activity: { activity: 'tool', toolName: String(part.tool || 'tool'), input: state.input, output: state.output ?? state.metadata } }
  }
  return null
}

