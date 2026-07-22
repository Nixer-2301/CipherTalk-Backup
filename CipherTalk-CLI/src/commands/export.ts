import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerExportCommand(program: Command, context: CommandContext): void {
  const exportCommand = program
    .command('export')
    .argument('[session]', '会话 ID')
    .description('导出聊天数据')
    .option('--all', '导出全部会话')
    .option('--output <path>', '输出目录或文件')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .option('--with-media', '同步导出媒体文件')
    .action(async (session: string | undefined) => {
      await runCommand(exportCommand, context, async (config) => {
        const globals = exportCommand.optsWithGlobals() as Record<string, any>
        const result = await context.services.advanced.exportChat(config, {
          session: session,
          all: Boolean(globals.all),
          output: typeof globals.output === 'string' ? globals.output : undefined,
          from: typeof globals.from === 'string' ? globals.from : undefined,
          to: typeof globals.to === 'string' ? globals.to : undefined,
          withMedia: Boolean(globals.withMedia)
        })
        return { data: result }
      })
    })
}
