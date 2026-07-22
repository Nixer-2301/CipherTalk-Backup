import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { stringify as csvStringifySync } from 'csv-stringify/sync'
import { dbError, invalidArgument, MiyuError } from '../../errors.js'
import { dataService } from '../dataService.js'
import type { DataService, ExportOptions, MessageRow } from '../types.js'
import type { RuntimeConfig } from '../../types.js'

export type ExportFormat = 'csv' | 'json' | 'md'

/**
 * 根据 --output 文件后缀推断导出格式。
 * 没有后缀（或目录用法）默认 json。
 */
export function inferFormatFromPath(output: string | undefined): ExportFormat {
  if (!output) return 'json'
  const ext = extname(output).toLowerCase()
  switch (ext) {
    case '.csv':
      return 'csv'
    case '.md':
    case '.markdown':
      return 'md'
    case '.json':
      return 'json'
    case '':
      return 'json'
    default:
      throw invalidArgument(`不支持的导出格式: ${ext}（仅支持 .csv / .json / .md）`)
  }
}

/**
 * 将一组消息序列化为 CSV 字符串。
 * 使用 csv-stringify 处理引号、逗号、换行等转义。
 */
export function renderCsv(messages: MessageRow[]): string {
  return csvStringifySync(
    messages.map((m) => ({
      localId: m.localId ?? '',
      serverId: m.serverId ?? '',
      createTime: m.createTime ?? '',
      sortSeq: m.sortSeq ?? '',
      direction: m.direction,
      senderUsername: m.senderUsername ?? '',
      type: m.type ?? '',
      content: m.content ?? ''
    })),
    {
      header: true,
      columns: ['localId', 'serverId', 'createTime', 'sortSeq', 'direction', 'senderUsername', 'type', 'content']
    }
  )
}

/**
 * 序列化为 JSON 字符串（带换行，便于阅读）。
 */
export function renderJson(messages: MessageRow[]): string {
  // 去掉 raw 字段，避免暴露大量底层 DB 行
  const cleaned = messages.map(({ raw: _raw, ...rest }) => rest)
  return JSON.stringify(cleaned, null, 2)
}

/**
 * 序列化为 Markdown 聊天记录。
 */
export function renderMarkdown(messages: MessageRow[], session: string): string {
  const header = `# 聊天记录：${session}\n\n` +
    `导出时间：${new Date().toISOString()}\n` +
    `消息条数：${messages.length}\n\n---\n`

  const body = messages.map((m) => {
    const time = formatTime(m.createTime)
    const sender = m.senderUsername || (m.direction === 'out' ? '我' : '对方')
    const arrow = m.direction === 'out' ? '->' : m.direction === 'in' ? '<-' : '--'
    const content = escapeMarkdown(m.content ?? '')
    return `**${sender}** ${arrow} _${time}_\n\n${content}\n`
  }).join('\n---\n\n')

  return header + '\n' + body
}

function formatTime(ts: number | undefined): string {
  if (!ts || Number.isNaN(Number(ts))) return ''
  const n = Number(ts)
  // 微信 create_time 多为秒级时间戳；如果是毫秒级（13 位）就直接用
  const ms = n > 1e12 ? n : n * 1000
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ts)
  }
}

function escapeMarkdown(text: string): string {
  // 仅对关键的转义：反斜杠、围栏代码块、HTML 注入符号
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
}

/**
 * 根据格式渲染消息。
 */
export function renderMessages(format: ExportFormat, messages: MessageRow[], session: string): string {
  switch (format) {
    case 'csv':
      return renderCsv(messages)
    case 'json':
      return renderJson(messages)
    case 'md':
      return renderMarkdown(messages, session)
  }
}

function fileExtension(format: ExportFormat): string {
  return format === 'md' ? '.md' : `.${format}`
}

function timestampFromOption(value: string | undefined): number | undefined {
  if (!value) return undefined
  // 数字时间戳直接返回
  const num = Number(value)
  if (!Number.isNaN(num) && num > 0) return num
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw invalidArgument(`无法解析时间参数: ${value}`)
  }
  // 默认按秒返回（与微信 create_time 一致）
  return Math.floor(parsed / 1000)
}

function inRange(createTime: number | undefined, from: number | undefined, to: number | undefined): boolean {
  if (from == null && to == null) return true
  if (createTime == null) return false
  if (from != null && createTime < from) return false
  if (to != null && createTime >= to) return false
  return true
}

interface OrchestratorDeps {
  service?: Pick<DataService, 'getMessages' | 'listSessions'>
  writer?: (path: string, contents: string) => Promise<void>
}

const DEFAULT_FETCH_LIMIT = 1000

async function defaultWriter(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

async function collectAllMessages(
  service: Pick<DataService, 'getMessages'>,
  config: RuntimeConfig,
  session: string,
  from: number | undefined,
  to: number | undefined
): Promise<MessageRow[]> {
  const out: MessageRow[] = []
  let cursor: string | undefined = undefined
  // 最多翻 200 页防止失控
  for (let page = 0; page < 200; page += 1) {
    const result = await service.getMessages(config, session, {
      limit: DEFAULT_FETCH_LIMIT,
      cursor
    })
    for (const msg of result.messages) {
      if (inRange(msg.createTime, from, to)) out.push(msg)
    }
    if (!result.cursor) break
    cursor = result.cursor
  }
  return out
}

/**
 * 导出聊天数据的主入口。
 * - 单会话：写入 opts.output（按扩展名推断格式）
 * - 全量：opts.output 视为目录，每个会话写入 `${sessionId}${ext}`
 */
export async function exportChat(
  config: RuntimeConfig,
  opts: ExportOptions,
  deps: OrchestratorDeps = {}
): Promise<{ path: string; count: number }> {
  if (opts.withMedia) {
    throw new MiyuError(
      'NOT_IMPLEMENTED',
      '--with-media 选项暂未实现：CLI 版尚不支持媒体文件导出。'
    )
  }

  if (!opts.session && !opts.all) {
    throw invalidArgument('请提供会话 ID 或使用 --all 导出全部会话')
  }
  if (!opts.output) {
    throw invalidArgument('请使用 --output 指定输出路径')
  }

  const service = deps.service ?? dataService
  const writer = deps.writer ?? defaultWriter

  const from = timestampFromOption(opts.from)
  const to = timestampFromOption(opts.to)

  if (opts.all) {
    // 目录模式：opts.output 当目录用，每个会话一个文件
    const format = pickFormatForDirectory(opts.output)
    const ext = fileExtension(format)
    const dir = opts.output
    if (!service.listSessions) {
      throw dbError('当前 DataService 不支持 listSessions，无法使用 --all')
    }
    const { sessions } = await service.listSessions(config, { limit: 1000 })
    let total = 0
    for (const session of sessions) {
      const messages = await collectAllMessages(service, config, session.sessionId, from, to)
      const rendered = renderMessages(format, messages, session.sessionId)
      const safeName = sanitizeFilename(session.sessionId)
      const target = join(dir, `${safeName}${ext}`)
      await writer(target, rendered)
      total += messages.length
    }
    return { path: dir, count: total }
  }

  const session = opts.session!
  const format = inferFormatFromPath(opts.output)
  const messages = await collectAllMessages(service, config, session, from, to)
  const rendered = renderMessages(format, messages, session)
  await writer(opts.output, rendered)
  return { path: opts.output, count: messages.length }
}

function pickFormatForDirectory(output: string): ExportFormat {
  // 当 --all 时 output 是目录；这里不去解析后缀，统一默认 json
  // 但如果用户写了 dir/.csv 这种异常路径，仍按推断走
  const ext = extname(output).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.md' || ext === '.markdown') return 'md'
  return 'json'
}

function sanitizeFilename(name: string): string {
  // 替换 Windows / Unix 上不允许的字符
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'unknown'
}
