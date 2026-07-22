import type { Command } from 'commander'
import { parseLimit } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerMessagesCommand(program: Command, context: CommandContext): void {
  const messages = program
    .command('messages')
    .argument('<session>', 'session id or fuzzy name')
    .description('查询会话消息')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .option('--type <type>', 'text | image | voice | video | file')
    .option('--direction <direction>', 'in | out')
    .option('--cursor <sortSeq>', '游标')
    .option('--offset <n>', '分页偏移')
    .action(async (session: string) => {
      await runCommand(messages, context, async (config, options) => {
        const limit = parseLimit((messages.optsWithGlobals() as { limit?: string }).limit, config.defaultLimit)
        const result = await context.services.data.getMessages(config, session, {
          limit,
          offset: typeof options.offset === 'string' ? Number(options.offset) : undefined,
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined,
          type: typeof options.type === 'string' ? options.type : undefined,
          direction: typeof options.direction === 'string' ? options.direction : undefined,
          cursor: typeof options.cursor === 'string' ? options.cursor : undefined
        })
        return {
          data: { messages: result.messages },
          meta: { total: result.messages.length, limit, cursor: result.cursor }
        }
      })
    })
}
