import type { Command } from 'commander'
import { patchConfig, readConfig } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerInitCommand(program: Command, context: CommandContext): void {
  const init = program
    .command('init')
    .description('初始化 miyu 配置')
    .option('--cache-dir <path>', '缓存目录')
    .action(async () => {
      await runCommand(init, context, async (_config, options) => {
        const globals = init.optsWithGlobals() as { dbPath?: string; key?: string; wxid?: string; format?: string; limit?: string }
        const patch = {
          ...(globals.dbPath ? { dbPath: globals.dbPath } : {}),
          ...(globals.key ? { keyHex: globals.key.toLowerCase() } : {}),
          ...(globals.wxid ? { wxid: globals.wxid } : {}),
          ...(globals.format ? { defaultFormat: globals.format as any } : {}),
          ...(globals.limit ? { defaultLimit: Number(globals.limit) } : {}),
          ...(typeof options.cacheDir === 'string' ? { cacheDir: options.cacheDir } : {})
        }
        const saved = patchConfig({ ...readConfig(), ...patch })
        return { data: { saved, configPath: _config.configPath } }
      })
    })
}
