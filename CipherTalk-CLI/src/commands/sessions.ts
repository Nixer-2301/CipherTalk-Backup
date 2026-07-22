import type { Command } from 'commander'
import { parseLimit } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerSessionsCommand(program: Command, context: CommandContext): void {
  const sessions = program
    .command('sessions')
    .description('列出会话')
    .option('--type <type>', 'private | group | mp')
    .option('--offset <n>', '分页偏移')
    .action(async () => {
      await runCommand(sessions, context, async (config, options) => {
        const limit = parseLimit((sessions.optsWithGlobals() as { limit?: string }).limit, config.defaultLimit)
        const result = await context.services.data.listSessions(config, {
          type: typeof options.type === 'string' ? options.type : undefined,
          limit,
          offset: typeof options.offset === 'string' ? Number(options.offset) : undefined
        })
        return {
          data: { sessions: result.sessions },
          meta: { total: result.sessions.length, limit, hasMore: result.hasMore }
        }
      })
    })
}
