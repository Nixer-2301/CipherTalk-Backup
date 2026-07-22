import type { Command } from 'commander'
import { parseLimit } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerSearchCommand(program: Command, context: CommandContext): void {
  const search = program
    .command('search')
    .argument('<keyword>', '搜索关键词')
    .description('全文搜索聊天记录')
    .option('--session <session>', '限定会话 ID')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .action(async (keyword: string) => {
      await runCommand(search, context, async (config, options) => {
        const limit = parseLimit((search.optsWithGlobals() as { limit?: string }).limit, config.defaultLimit)
        const result = await context.services.advanced.search(config, keyword, {
          session: typeof options.session === 'string' ? options.session : undefined,
          limit,
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined
        })
        return {
          data: { messages: result.messages, sessionId: result.sessionId },
          meta: { total: result.total, keyword, limit }
        }
      })
    })
}
