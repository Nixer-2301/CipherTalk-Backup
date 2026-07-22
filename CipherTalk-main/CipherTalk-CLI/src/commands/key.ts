import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerKeyCommand(program: Command, context: CommandContext): void {
  const key = program.command('key').description('密钥管理')

  const setup = key
    .command('setup')
    .description('显示密钥配置方式说明')
    .action(async () => {
      await runCommand(setup, context, async () => ({
        data: {
          message: '请在交互模式中执行 /key setup，然后选择自动获取或手动填写。',
          options: [
            '自动获取：miyu key get --save',
            '手动填写：miyu key set <64位十六进制密钥>'
          ]
        }
      }))
    })

  const set = key
    .command('set')
    .argument('<hex>', '64 位十六进制密钥')
    .description('保存密钥到 ~/.miyu/config.json')
    .action(async (hex: string) => {
      await runCommand(set, context, async () => {
        const result = await context.services.key.setKey(hex)
        return { data: result }
      })
    })

  const test = key
    .command('test')
    .description('测试当前密钥格式和连接')
    .action(async () => {
      await runCommand(test, context, async (config) => {
        const result = await context.services.key.testKey(config)
        return { data: result }
      })
    })

  const get = key
    .command('get')
    .description('从微信进程提取密钥')
    .option('--save', '获取后写入配置')
    .action(async () => {
      await runCommand(get, context, async (config, options) => {
        const result = await context.services.key.getKey(config, { save: Boolean(options.save) })
        return { data: result }
      })
    })
}
