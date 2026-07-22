import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerMcpCommand(program: Command, context: CommandContext): void {
  const mcp = program.command('mcp').description('MCP server mode')
  const serve = mcp
    .command('serve')
    .description('启动独立 MCP Server')
    .action(async () => {
      await runCommand(serve, context, async () => context.services.advanced.mcpServe())
    })
}
