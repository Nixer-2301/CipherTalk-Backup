import type { Command } from 'commander'
import { clearConfig, patchConfig, readConfig } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerConfigCommand(program: Command, context: CommandContext): void {
  const config = program.command('config').description('配置管理')

  const show = config
    .command('show')
    .description('查看当前配置')
    .action(async () => {
      await runCommand(show, context, async (_runtime) => ({
        data: { config: readConfig(), configPath: _runtime.configPath }
      }))
    })

  const set = config
    .command('set')
    .description('写入配置')
    .option('--db-path <path>', '微信数据库根目录')
    .option('--wxid <wxid>', '微信账号 wxid')
    .option('--key <hex>', '64 位十六进制数据库密钥')
    .option('--format <format>', '默认输出格式')
    .option('--limit <n>', '默认结果数量')
    .option('--cache-dir <path>', '缓存目录')
    .action(async () => {
      await runCommand(set, context, async (_runtime, options) => {
        const patch = {
          ...(typeof options.dbPath === 'string' ? { dbPath: options.dbPath } : {}),
          ...(typeof options.wxid === 'string' ? { wxid: options.wxid } : {}),
          ...(typeof options.key === 'string' ? { keyHex: options.key.toLowerCase() } : {}),
          ...(typeof options.format === 'string' ? { defaultFormat: options.format as any } : {}),
          ...(typeof options.limit === 'string' ? { defaultLimit: Number(options.limit) } : {}),
          ...(typeof options.cacheDir === 'string' ? { cacheDir: options.cacheDir } : {})
        }
        const saved = patchConfig(patch)
        return { data: { saved, configPath: _runtime.configPath } }
      })
    })

  const clear = config
    .command('clear')
    .description('清空全部配置')
    .argument('[keys...]', '可选：只清空指定字段，如 dbPath keyHex wxid')
    .action(async (keys: string[]) => {
      await runCommand(clear, context, async (_runtime) => {
        const normalized = keys.map((key) => key === 'key' ? 'keyHex' : key) as any[]
        const saved = clearConfig(normalized.length > 0 ? normalized : undefined)
        return { data: { saved, configPath: _runtime.configPath } }
      })
    })
}
