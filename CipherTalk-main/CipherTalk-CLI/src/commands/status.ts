import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'
import { startInteractiveShell } from '../interactiveShell.js'
import type { GlobalCliOptions } from '../types.js'

export function registerStatusCommand(program: Command, context: CommandContext): void {
  const status = program
    .command('status')
    .description('检查配置和数据库连接状态')
    .action(async () => {
      const globalOptions = status.optsWithGlobals() as GlobalCliOptions
      // TTY + 未指定 --quiet / --format 时，跑完 /status 留在交互 shell 里继续操作；
      // 否则按纯命令模式打印 JSON 后退出（脚本场景）。
      const shouldEnterShell = (context.interactive || Boolean(globalOptions.ui)) && !globalOptions.quiet && !globalOptions.format
      if (shouldEnterShell) {
        await startInteractiveShell(context, globalOptions, { initialCommand: '/status' })
        return
      }

      await runCommand(status, context, async (config) => {
        const data = await context.services.data.getStatus(config)
        return { data }
      })
    })
}
