import { createProgram } from './cli.js'
import { createCommandContext } from './commandRunner.js'
import { startInteractiveShell } from './interactiveShell.js'
import { createDefaultServices } from './services/index.js'
import { processOutput } from './output.js'

// Node 22+ 默认会因 unhandled promise rejection 终止进程；交互 shell 用 `void execute()`
// 火地忘形调用 async 函数，需要进程级兜底以免命令执行抛错把 CLI 整死。
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason)
  process.stderr.write(`未捕获的异常: ${message}\n`)
})
process.on('uncaughtException', (error) => {
  process.stderr.write(`未捕获的异常: ${error.stack || error.message}\n`)
})

const argv = process.argv.slice(2)

// 无子命令 + TTY → 自动进入交互模式
const hasSubcommand = argv.length > 0 && !argv[0]?.startsWith('-')
const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY)

if (!hasSubcommand && isTty && !argv.includes('--quiet') && !argv.includes('-V') && !argv.includes('--version')) {
  const context = createCommandContext({
    output: processOutput,
    interactive: true
  })
  const globals: Record<string, any> = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=', 2)
      globals[key.replace(/-/g, '')] = val || true
    }
  }
  await startInteractiveShell(context, globals as any, {})
} else {
  createProgram().parseAsync(process.argv).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
