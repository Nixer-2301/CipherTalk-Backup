import * as readline from 'node:readline'
import { clearConfig, patchConfig, parseLimit, readConfig, resolveRuntimeConfig } from './config.js'
import { errorEnvelope, successEnvelope, writeEnvelope } from './output.js'
import type { CommandContext } from './commandRunner.js'
import type { ConfigFile } from './config.js'
import { OUTPUT_FORMATS, type GlobalCliOptions, type OutputFormat, type RuntimeConfig } from './types.js'
import type { StatusData } from './services/types.js'

export interface InteractiveCommand {
  name: string
  usage: string
  description: string
}

export interface InteractiveShellOptions {
  initialCommand?: string
}

const COMMANDS: InteractiveCommand[] = [
  { name: '/status', usage: '/status', description: '检查配置和数据库连接状态' },
  { name: '/config', usage: '/config [show|set|clear]', description: '配置向导（直接回车进入），或 show/set/clear 子命令' },
  { name: '/sessions', usage: '/sessions [--limit 20] [--type private|group|mp]', description: '列出会话' },
  { name: '/messages', usage: '/messages <会话> [--limit 50] [--cursor n]', description: '查询会话消息' },
  { name: '/contacts', usage: '/contacts [--limit 50] [--type friend|group|mp]', description: '列出联系人' },
  { name: '/contact', usage: '/contact <wxid或名称>', description: '查看联系人详情' },
  { name: '/key', usage: '/key setup|get|test|set <hex>', description: '密钥管理' },
  { name: '/search', usage: '/search <关键词>', description: '全文搜索' },
  { name: '/export', usage: '/export <会话> [--output path]', description: '导出聊天数据' },
  { name: '/moments', usage: '/moments [--limit 20]', description: '朋友圈数据' },
  { name: '/mcp', usage: '/mcp serve', description: '独立 MCP Server 模式' },
  { name: '/help', usage: '/help', description: '显示命令列表' },
  { name: '/exit', usage: '/exit', description: '退出交互模式' }
]

type ParsedInteractiveInput = { command: string; args: string[] }

type ParsedOptions = {
  options: Record<string, string | boolean>
  positional: string[]
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[38;5;51m',
  blue: '\x1b[38;5;39m',
  teal: '\x1b[38;5;43m',
  mint: '\x1b[38;5;121m',
  white: '\x1b[97m',
  gray: '\x1b[38;5;245m'
} as const

function paint(text: string, ...codes: string[]): string {
  if (process.env.NO_COLOR) return text
  return `${codes.join('')}${text}${ANSI.reset}`
}

export function renderWelcomeScreen(): string {
  return [
    paint('┌──────────────────────────────────────────────┐', ANSI.cyan),
    `${paint('│', ANSI.cyan)}  ${paint('Welcome to CipherTalk CLI', ANSI.bold, ANSI.white)}                   ${paint('│', ANSI.cyan)}`,
    `${paint('│', ANSI.cyan)}  ${paint('欢迎使用密语命令行工具', ANSI.mint)}                      ${paint('│', ANSI.cyan)}`,
    paint('└──────────────────────────────────────────────┘', ANSI.cyan),
    '',
    paint(' ██████╗ ██╗ ██████╗  ██╗  ██╗ ███████╗ ██████╗  ████████╗  █████╗  ██╗      ██╗  ██╗', ANSI.blue),
    paint('██╔════╝ ██║ ██╔══██╗ ██║  ██║ ██╔════╝ ██╔══██╗ ╚══██╔══╝ ██╔══██╗ ██║      ██║ ██╔╝', ANSI.blue),
    paint('██║      ██║ ██████╔╝ ███████║ █████╗   ██████╔╝    ██║    ███████║ ██║      █████╔╝', ANSI.teal),
    paint('██║      ██║ ██╔═══╝  ██╔══██║ ██╔══╝   ██╔══██╗    ██║    ██╔══██║ ██║      ██╔═██╗', ANSI.teal),
    paint('╚██████╗ ██║ ██║      ██║  ██║ ███████╗ ██║  ██║    ██║    ██║  ██║ ███████╗ ██║  ██╗', ANSI.cyan),
    paint(' ╚═════╝ ╚═╝ ╚═╝      ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝    ╚═╝    ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝', ANSI.cyan, ANSI.dim),
    '',
    paint('本地微信数据命令行工作台', ANSI.gray),
    ''
  ].join('\n')
}

export function getInteractiveCommands(): InteractiveCommand[] {
  return [...COMMANDS]
}

export function parseSlashInput(input: string): ParsedInteractiveInput {
  const tokens = splitArgs(input.trim())
  const command = tokens[0] || ''
  return { command, args: tokens.slice(1) }
}

export function filterInteractiveCommands(input: string): InteractiveCommand[] {
  const normalized = input.trim().toLowerCase()
  if (!normalized.startsWith('/')) return []
  const query = normalized.slice(1)
  return COMMANDS.filter((command) => command.name.slice(1).toLowerCase().startsWith(query))
}

function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function parseOptions(args: string[]): ParsedOptions {
  const options: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue
      continue
    }

    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      options[rawName] = next
      index += 1
    } else {
      options[rawName] = true
    }
  }

  return { options, positional }
}

function showCommandList(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length))
  return [
    '可用命令：',
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.description}`)
  ].join('\n')
}

/** 带编号的命令菜单：进入界面即展示，输入编号回车即可选择。 */
function showNumberedMenu(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length))
  return [
    '选择命令（输入编号回车，或输入 / 浏览命令）：',
    ...COMMANDS.map((command, index) => `  ${String(index + 1).padStart(2)}. ${command.usage.padEnd(width)}  ${command.description}`)
  ].join('\n')
}

/** 该命令是否还需要补充参数（用法里除可选 [..] 外还剩必填内容，如 <会话> / serve）。 */
export function needsCompletion(command: InteractiveCommand): boolean {
  const rest = command.usage.slice(command.name.length).replace(/\[[^\]]*\]/g, '').trim()
  return rest.length > 0
}

function shellFormat(config: RuntimeConfig, globals: GlobalCliOptions, options: Record<string, string | boolean>): OutputFormat {
  const explicit = asString(options.format) || globals.format
  if (explicit === 'json' || explicit === 'jsonl' || explicit === 'csv' || explicit === 'markdown' || explicit === 'table') {
    return explicit
  }
  return config.defaultFormat === 'json' ? 'table' : config.defaultFormat
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function commandLimit(options: Record<string, string | boolean>, fallback: number): number {
  return parseLimit(asString(options.limit), fallback)
}

function formatShellValue(value: unknown): string {
  if (value === true) return '是'
  if (value === false) return '否'
  if (value === null || value === undefined || value === '') return '未配置'
  return String(value)
}

function statusRows(data: StatusData): Array<{ 项目: string; 内容: string }> {
  const rows = [
    { 项目: '配置状态', 内容: data.configured ? '已配置' : '未配置' },
    { 项目: '配置文件', 内容: formatShellValue(data.configPath) },
    { 项目: '数据库路径', 内容: formatShellValue(data.dbPath) },
    { 项目: '微信账号', 内容: formatShellValue(data.wxid) },
    { 项目: '原生模块目录', 内容: formatShellValue(data.nativeRoot) },
    { 项目: '数据库文件数', 内容: String(data.databaseFiles) }
  ]

  if (data.connection) {
    rows.push(
      { 项目: '连接状态', 内容: data.connection.ok ? '正常' : '失败' },
      { 项目: '会话数量', 内容: formatShellValue(data.connection.sessionCount) }
    )
    if (data.connection.error) rows.push({ 项目: '连接错误', 内容: data.connection.error })
  }

  return rows
}

function statusHint(data: StatusData): string | null {
  if (data.configured) return null
  return [
    '尚未配置数据库路径或密钥。',
    '可执行：/config set --db-path "<微信Msg目录>" --wxid "<wxid>"',
    '然后执行：/key setup 选择自动获取或手动填写密钥'
  ].join('\n')
}

async function askLine(promptText: string): Promise<string> {
  const input = process.stdin
  const output = process.stdout
  input.setRawMode?.(true)
  input.resume()
  output.write(promptText)

  return new Promise<string>((resolve) => {
    let line = ''
    const handler = (char: string | undefined, key: readline.Key | undefined) => {
      const name = key?.name
      if (name === 'return' || name === 'enter') {
        input.off('keypress', handler)
        output.write('\n')
        resolve(line.trim())
        return
      }
      if (key?.ctrl && name === 'c') {
        input.off('keypress', handler)
        output.write('\n')
        resolve('')
        return
      }
      if (name === 'backspace') {
        if (line.length > 0) {
          line = line.slice(0, -1)
          output.write('\b \b')
        }
        return
      }
      if (!char) return
      if (char === '\r' || char === '\n') {
        input.off('keypress', handler)
        output.write('\n')
        resolve(line.trim())
        return
      }
      if (char < ' ' || char === '\x7f') return
      line += char
      output.write(char)
    }
    input.on('keypress', handler)
  })
}

async function runKeySetup(context: CommandContext, config: RuntimeConfig, format: OutputFormat): Promise<void> {
  context.output.stdout([
    '请选择密钥配置方式：',
    '  1. 自动获取：从正在运行的微信进程提取密钥',
    '  2. 手动填写：粘贴 64 位十六进制密钥',
    ''
  ].join('\n'))

  const choice = await askLine('请输入 1 或 2：')
  if (choice === '1') {
    const result = await context.services.key.getKey(config, { save: true })
    writeEnvelope(context.output, successEnvelope(result), format)
    return
  }
  if (choice === '2') {
    const hex = await askLine('请输入 64 位十六进制密钥：')
    const result = await context.services.key.setKey(hex)
    writeEnvelope(context.output, successEnvelope(result), format)
    return
  }
  throw new Error('已取消：请输入 1 选择自动获取，或输入 2 选择手动填写')
}

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function maskKey(hex: string | undefined): string {
  if (!hex) return '未配置'
  if (hex.length < 12) return '已设置'
  return `${hex.slice(0, 8)}...${hex.slice(-4)} (已设置)`
}

type ConfigItem = {
  key: 'dbPath' | 'wxid' | 'keyHex' | 'defaultFormat' | 'defaultLimit' | 'cacheDir'
  label: string
  display: string
  kind: 'path' | 'string' | 'key' | 'enum' | 'number'
}

function buildConfigItems(current: ConfigFile): ConfigItem[] {
  return [
    { key: 'dbPath',        label: '数据库路径',     display: formatShellValue(current.dbPath),        kind: 'path' },
    { key: 'wxid',          label: '微信账号 wxid',  display: formatShellValue(current.wxid),          kind: 'string' },
    { key: 'keyHex',        label: '密钥 keyHex',    display: maskKey(current.keyHex),                  kind: 'key' },
    { key: 'defaultFormat', label: '默认输出格式',   display: formatShellValue(current.defaultFormat), kind: 'enum' },
    { key: 'defaultLimit',  label: '默认条数限制',   display: formatShellValue(current.defaultLimit),  kind: 'number' },
    { key: 'cacheDir',      label: '缓存目录',       display: formatShellValue(current.cacheDir),      kind: 'path' }
  ]
}

async function runConfigWizard(context: CommandContext, config: RuntimeConfig, format: OutputFormat): Promise<void> {
  while (true) {
    const items = buildConfigItems(readConfig())
    const width = Math.max(...items.map((item) => item.label.length))
    const lines = ['当前配置：']
    items.forEach((item, index) => {
      lines.push(`  ${String(index + 1)}. ${item.label.padEnd(width)}  ${item.display}`)
    })
    lines.push('')
    lines.push('  c. 清空全部配置')
    lines.push('  q. 退出（直接回车也可）')
    lines.push('')
    context.output.stdout(lines.join('\n'))

    const choice = (await askLine('请输入编号选择要修改的项：')).trim()
    if (!choice || choice === 'q' || choice === 'Q') return

    if (choice === 'c' || choice === 'C') {
      const confirm = (await askLine('确认清空全部配置？(y/N)：')).trim().toLowerCase()
      if (confirm === 'y' || confirm === 'yes') {
        const saved = clearConfig()
        writeEnvelope(context.output, successEnvelope({ 已清空: saved, 配置文件: config.configPath }), format)
      } else {
        context.output.stdout('已取消')
      }
      continue
    }

    const idx = Number(choice) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
      context.output.stderr(`无效的编号：${choice}`)
      continue
    }

    const item = items[idx]
    if (item.kind === 'key') {
      await runKeySetup(context, config, format)
      continue
    }

    let promptText = `请输入新的 ${item.label}（直接回车取消）：`
    if (item.kind === 'path') {
      promptText = `把文件夹拖到此处或粘贴绝对路径（直接回车取消）：`
    } else if (item.kind === 'enum') {
      promptText = `可选值：${OUTPUT_FORMATS.join(' | ')}\n请输入（直接回车取消）：`
    } else if (item.kind === 'number') {
      promptText = `请输入正整数（直接回车取消）：`
    }

    const raw = await askLine(promptText)
    if (!raw) {
      context.output.stdout('已取消')
      continue
    }
    const value = stripWrappingQuotes(raw)

    try {
      const patch: ConfigFile = {}
      if (item.key === 'defaultLimit') {
        const n = Number(value)
        if (!Number.isInteger(n) || n <= 0) throw new Error(`必须是正整数：${value}`)
        patch.defaultLimit = n
      } else if (item.key === 'defaultFormat') {
        if (!(OUTPUT_FORMATS as readonly string[]).includes(value)) {
          throw new Error(`无效格式：${value}（可选 ${OUTPUT_FORMATS.join('|')}）`)
        }
        patch.defaultFormat = value as OutputFormat
      } else {
        patch[item.key] = value
      }
      const saved = patchConfig(patch)
      writeEnvelope(context.output, successEnvelope({ 已保存: saved }), format)
    } catch (error) {
      writeEnvelope(context.output, errorEnvelope(error), format)
    }
  }
}

async function runShellCommand(line: string, context: CommandContext, globals: GlobalCliOptions): Promise<boolean> {
  const parsed = parseSlashInput(line)
  if (!parsed.command) return true
  if (!parsed.command.startsWith('/')) {
    context.output.stderr('交互模式命令需要以 / 开头，例如 /status。')
    return true
  }

  const { options, positional } = parseOptions(parsed.args)
  const config = resolveRuntimeConfig({ ...globals, limit: asString(options.limit) || globals.limit })
  const format = shellFormat(config, globals, options)

  try {
    switch (parsed.command) {
      case '/':
      case '/help':
        context.output.stdout(showCommandList())
        return true
      case '/exit':
      case '/quit':
        return false
      case '/status': {
        const data = await context.services.data.getStatus(config)
        const hint = statusHint(data)
        writeEnvelope(context.output, successEnvelope({ 状态: statusRows(data) }, { hint }), format)
        if (hint && format === 'table') context.output.stdout(`\n${hint}`)
        return true
      }
      case '/config': {
        const action = positional[0] || 'wizard'
        if (action === 'wizard') {
          await runConfigWizard(context, config, format)
          return true
        }
        if (action === 'show') {
          writeEnvelope(context.output, successEnvelope({
            配置: readConfig(),
            配置文件: config.configPath
          }), format)
          return true
        }
        if (action === 'set') {
          const patch = {
            ...(typeof options['db-path'] === 'string' ? { dbPath: options['db-path'] } : {}),
            ...(typeof options.wxid === 'string' ? { wxid: options.wxid } : {}),
            ...(typeof options.key === 'string' ? { keyHex: options.key.toLowerCase() } : {}),
            ...(typeof options.format === 'string' ? { defaultFormat: options.format as any } : {}),
            ...(typeof options.limit === 'string' ? { defaultLimit: Number(options.limit) } : {}),
            ...(typeof options['cache-dir'] === 'string' ? { cacheDir: options['cache-dir'] } : {})
          }
          const saved = patchConfig(patch)
          writeEnvelope(context.output, successEnvelope({ 已保存: saved, 配置文件: config.configPath }), format)
          return true
        }
        if (action === 'clear') {
          const keys = positional.slice(1).map((key) => key === 'key' ? 'keyHex' : key) as any[]
          const saved = clearConfig(keys.length > 0 ? keys : undefined)
          writeEnvelope(context.output, successEnvelope({ 已保存: saved, 配置文件: config.configPath }), format)
          return true
        }
        throw new Error('用法: /config | /config show | /config set --key value | /config clear [字段...]')
      }
      case '/sessions': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listSessions(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ sessions: result.sessions }, { total: result.sessions.length, limit, hasMore: result.hasMore }), format)
        return true
      }
      case '/messages': {
        const session = positional[0]
        if (!session) throw new Error('用法: /messages <会话> [--limit 50]')
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.getMessages(config, session, {
          limit,
          cursor: asString(options.cursor),
          direction: asString(options.direction),
          type: asString(options.type),
          from: asString(options.from),
          to: asString(options.to)
        })
        writeEnvelope(context.output, successEnvelope({ messages: result.messages }, { total: result.messages.length, limit, cursor: result.cursor }), format)
        return true
      }
      case '/contacts': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listContacts(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ contacts: result.contacts }, { total: result.contacts.length, limit }), format)
        return true
      }
      case '/contact': {
        const contact = positional[0]
        if (!contact) throw new Error('用法: /contact <wxid或名称>')
        const data = await context.services.data.getContactInfo(config, contact)
        writeEnvelope(context.output, successEnvelope({ contact: data }, { total: data ? 1 : 0 }), format)
        return true
      }
      case '/key': {
        const action = positional[0]
        if (!action || action === 'setup') {
          await runKeySetup(context, config, format)
          return true
        }
        if (action === 'set') {
          const hex = positional[1]
          if (!hex) throw new Error('用法: /key set <hex>')
          writeEnvelope(context.output, successEnvelope(await context.services.key.setKey(hex)), format)
          return true
        }
        if (action === 'test') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.testKey(config)), format)
          return true
        }
        if (action === 'get') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.getKey(config, { save: true })), format)
          return true
        }
        throw new Error('用法: /key setup|get|test|set <hex>')
      }
      case '/search': {
        const keyword = positional.join(' ')
        if (!keyword) throw new Error('用法: /search <关键词>')
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.advanced.search(config, keyword, {
          limit,
          session: asString(options.session)
        })
        writeEnvelope(context.output, successEnvelope({ messages: result.messages }, { total: result.total, keyword, limit }), format)
        return true
      }
      case '/export': {
        const result = await context.services.advanced.exportChat(config, {
          session: positional[0],
          all: options.all === true,
          output: asString(options.output),
          from: asString(options.from),
          to: asString(options.to),
          withMedia: options['with-media'] === true
        })
        writeEnvelope(context.output, successEnvelope(result), format)
        return true
      }
      case '/moments': {
        const limit = commandLimit(options, 20)
        const result = await context.services.advanced.moments(config, {
          limit,
          user: asString(options.user),
          from: asString(options.from),
          to: asString(options.to)
        })
        writeEnvelope(context.output, successEnvelope({ entries: result.entries }, {
          total: result.total,
          limit: result.limit,
          ...(result.meta || {})
        }), format)
        return true
      }
      case '/mcp':
        if (positional[0] === 'serve') {
          await context.services.advanced.mcpServe()
          return true
        }
        throw new Error('用法: /mcp serve')
      default:
        context.output.stderr(`未知命令: ${parsed.command}\n输入 / 查看所有命令。`)
        return true
    }
  } catch (error) {
    writeEnvelope(context.output, errorEnvelope(error), format)
    return true
  }
}

export async function startInteractiveShell(
  context: CommandContext,
  globals: GlobalCliOptions,
  options: InteractiveShellOptions = {}
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    context.output.stderr('当前终端不支持交互界面。请在真实终端中运行，或使用 --format json 输出脚本结果。')
    return
  }

  const input = process.stdin
  const output = process.stdout
  const prompt = 'miyu> '
  let buffer = ''
  let closed = false
  let selectedSuggestion = 0

  readline.emitKeypressEvents(input)
  input.setRawMode?.(true)
  input.resume()

  const enterScreen = () => {
    // 启用 alternate screen buffer + 光标可见（之前是 ?25l 隐藏光标用于欢迎屏，现在直接显示）
    output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h')
  }

  const leaveScreen = () => {
    output.write('\x1b[?25h\x1b[?1049l')
  }

  const renderHeader = () => {
    output.write([
      'CipherTalk CLI 工作台',
      '输入编号选择命令，或输入 / 浏览命令，/exit 退出。',
      '────────────────────────────────────────────────────────',
      ''
    ].join('\n'))
  }

  // 在提示符上方打印带编号的命令菜单，方便随时输入编号选择。
  const printMenu = () => {
    output.write(`${showNumberedMenu()}\n`)
  }

  const currentSuggestions = () => filterInteractiveCommands(buffer)

  const render = () => {
    // 假定光标停在提示符所在行：\r 回到行首，\x1b[J 清掉光标到屏幕末，
    // 这样既能擦掉旧的提示符行 + suggestions，又不会动上方已经打印过的命令输出。
    output.write('\r\x1b[J')
    output.write(`${prompt}${buffer}`)

    const suggestions = currentSuggestions()
    if (!buffer.startsWith('/') || suggestions.length === 0) return

    const limit = Math.min(suggestions.length, 8)
    const width = Math.max(...suggestions.slice(0, limit).map((command) => command.usage.length))
    let rows = 0
    for (let index = 0; index < limit; index += 1) {
      const command = suggestions[index]
      const prefix = index === selectedSuggestion ? '›' : ' '
      output.write(`\n${prefix} ${command.usage.padEnd(width)}  ${command.description}`)
      rows += 1
    }
    if (suggestions.length > limit) {
      output.write(`\n  还有 ${suggestions.length - limit} 个命令，继续输入可缩小范围`)
      rows += 1
    }
    // 把光标移回提示符行末，方便继续输入
    output.write(`\x1b[${rows}A\r\x1b[${(prompt + buffer).length}C`)
  }

  const printList = () => {
    output.write(`\n${showCommandList()}\n`)
    render()
  }

  enterScreen()

  await new Promise<void>((resolve) => {
    const close = () => {
      if (closed) return
      closed = true
      input.off('keypress', onKeypress)
      input.setRawMode?.(false)
      input.pause()
      leaveScreen()
      resolve()
    }

    const bootstrap = async () => {
      output.write(renderWelcomeScreen())
      output.write('\n')
      renderHeader()
      if (options.initialCommand) {
        await runShellCommand(options.initialCommand, context, globals)
        output.write('\n')
      }
      printMenu()
      render()
    }

    const execute = async () => {
      let line = buffer.trim()
      // 数字选择：把纯数字映射成对应命令。需要参数的命令只把命令名填进输入行等补全，不直接执行。
      if (/^\d+$/.test(line)) {
        const picked = COMMANDS[Number(line) - 1]
        if (picked) {
          if (needsCompletion(picked)) {
            buffer = `${picked.name} `
            selectedSuggestion = 0
            render()
            return
          }
          line = picked.name
        }
      }
      buffer = ''
      output.write('\n')
      input.off('keypress', onKeypress)
      let shouldContinue = true
      try {
        shouldContinue = await runShellCommand(line, context, globals)
      } catch (error) {
        // execute() 是 `void execute()` 火地忘形调用，若 promise reject
        // 在 Node 22+ 默认会作为 unhandled rejection 终止进程。
        // 在此兜底所有异常，把消息打出来后继续 shell 循环。
        const message = error instanceof Error ? (error.stack || error.message) : String(error)
        context.output.stderr(`命令执行异常: ${message}`)
      }
      if (!shouldContinue) {
        close()
        return
      }
      input.on('keypress', onKeypress)
      // 命令输出末尾换一行，重新显示编号菜单，提示符画在其下方
      output.write('\n')
      printMenu()
      render()
    }

    const onKeypress = (char: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        close()
        return
      }

      if (key.name === 'return' || key.name === 'enter') {
        const suggestions = currentSuggestions()
        const isOnlySlashCommand = /^\/[^\s]*$/.test(buffer)
        if (isOnlySlashCommand && suggestions.length > 0) {
          const selected = suggestions[Math.min(selectedSuggestion, suggestions.length - 1)]
          if (selected.name === buffer || buffer === '/exit' || buffer === '/quit' || buffer === '/help') {
            void execute()
          } else {
            buffer = selected.name
            selectedSuggestion = 0
            render()
          }
          return
        }
        void execute()
        return
      }
      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1)
        selectedSuggestion = 0
        render()
        return
      }
      if (key.name === 'up') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion - 1 + suggestions.length) % suggestions.length
          render()
        }
        return
      }
      if (key.name === 'down') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion + 1) % suggestions.length
          render()
        }
        return
      }
      if (key.name === 'tab') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          const selected = suggestions[Math.min(selectedSuggestion, suggestions.length - 1)]
          buffer = selected.name
          selectedSuggestion = 0
          render()
        } else {
          printList()
        }
        return
      }
      if (key.name === 'escape') return
      if (!char) return

      buffer += char
      selectedSuggestion = 0
      render()
    }

    input.on('keypress', onKeypress)
    void bootstrap()
  })
}
