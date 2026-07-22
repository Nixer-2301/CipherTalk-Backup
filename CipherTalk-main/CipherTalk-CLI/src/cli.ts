import { Command } from 'commander'
import { processOutput, type OutputTarget } from './output.js'
import { createCommandContext } from './commandRunner.js'
import type { ServiceRegistry } from './services/types.js'
import { registerConfigCommand } from './commands/config.js'
import { registerContactsCommand } from './commands/contacts.js'
import { registerExportCommand } from './commands/export.js'
import { registerInitCommand } from './commands/init.js'
import { registerKeyCommand } from './commands/key.js'
import { registerMcpCommand } from './commands/mcp.js'
import { registerMessagesCommand } from './commands/messages.js'
import { registerMomentsCommand } from './commands/moments.js'
import { registerSearchCommand } from './commands/search.js'
import { registerSessionsCommand } from './commands/sessions.js'
import { registerStatusCommand } from './commands/status.js'

export interface CreateProgramOptions {
  services?: Partial<ServiceRegistry>
  output?: OutputTarget
  setExitCode?: (code: number) => void
  interactive?: boolean
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const program = new Command()
  const output = options.output || processOutput
  const context = createCommandContext({
    services: options.services,
    output,
    setExitCode: options.setExitCode,
    interactive: options.interactive ?? (output === processOutput && Boolean(process.stdin.isTTY && process.stdout.isTTY))
  })

  program
    .name('miyu')
    .description('CipherTalk-compatible WeChat data CLI')
    .version('0.1.0', '-V, --version')
    .option('--db-path <path>', '指定微信数据库根目录')
    .option('--key <hex>', '手动传入数据库密钥')
    .option('--wxid <wxid>', '指定微信账户 wxid')
    .option('--format <fmt>', '输出格式: json | jsonl | table | csv | markdown')
    .option('--limit <n>', '结果条数限制')
    .option('--ui', '强制进入交互界面')
    .option('--quiet', '仅输出数据，不打印状态信息')

  registerInitCommand(program, context)
  registerConfigCommand(program, context)
  registerStatusCommand(program, context)
  registerSessionsCommand(program, context)
  registerMessagesCommand(program, context)
  registerContactsCommand(program, context)
  registerKeyCommand(program, context)
  registerSearchCommand(program, context)
  registerExportCommand(program, context)
  registerMomentsCommand(program, context)
  registerMcpCommand(program, context)

  return program
}
