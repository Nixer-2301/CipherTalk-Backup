import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerMomentsCommand(program: Command, context: CommandContext): void {
  const moments = program
    .command('moments')
    .description('朋友圈数据')
    .option('--limit <n>', '返回条数（默认 20，上限 200）', '20')
    .option('--user <wxid>', '只查指定 wxid 的朋友圈')
    .option('--from <date>', '开始时间（ISO 字符串或 Unix 秒）')
    .option('--to <date>', '结束时间（ISO 字符串或 Unix 秒）')
    .action(async () => {
      await runCommand(moments, context, async (config, options) => {
        const limit = typeof options.limit === 'string' ? Number(options.limit) : undefined
        const result = await context.services.advanced.moments(config, {
          limit: Number.isFinite(limit) ? limit : undefined,
          user: typeof options.user === 'string' ? options.user : undefined,
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined
        })
        return {
          data: { entries: result.entries },
          meta: {
            total: result.total,
            limit: result.limit,
            ...(result.meta || {})
          }
        }
      })
    })
}
