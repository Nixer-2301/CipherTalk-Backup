import type { Command } from 'commander'
import { readConfig, resolveRuntimeConfig } from './config.js'
import { errorEnvelope, successEnvelope, writeEnvelope, type OutputTarget } from './output.js'
import { createDefaultServices } from './services/index.js'
import type { ServiceRegistry } from './services/types.js'
import type { CommandMeta, CommandResult, GlobalCliOptions, OutputFormat, RuntimeConfig } from './types.js'

export interface CommandContext {
  services: ServiceRegistry
  output: OutputTarget
  setExitCode: (code: number) => void
  interactive: boolean
}

export interface CreateContextOptions {
  services?: Partial<ServiceRegistry>
  output: OutputTarget
  setExitCode?: (code: number) => void
  interactive?: boolean
}

export function createCommandContext(options: CreateContextOptions): CommandContext {
  const defaults = createDefaultServices()
  return {
    services: {
      data: options.services?.data || defaults.data,
      key: options.services?.key || defaults.key,
      advanced: options.services?.advanced || defaults.advanced
    },
    output: options.output,
    setExitCode: options.setExitCode || ((code) => {
      process.exitCode = code
    }),
    interactive: options.interactive ?? false
  }
}

function getRawOptions(command: Command): GlobalCliOptions {
  return command.optsWithGlobals() as GlobalCliOptions
}

function getFallbackFormat(command: Command): OutputFormat {
  const raw = getRawOptions(command)
  const configured = readConfig().defaultFormat
  const candidate = raw.format || process.env.MIYU_FORMAT || configured || 'json'
  return candidate === 'jsonl' || candidate === 'table' || candidate === 'csv' || candidate === 'markdown' ? candidate : 'json'
}

export async function runCommand<T>(
  command: Command,
  context: CommandContext,
  handler: (config: RuntimeConfig, rawOptions: Record<string, unknown>) => Promise<CommandResult<T> | T>
): Promise<void> {
  const started = Date.now()
  let format: OutputFormat = 'json'
  try {
    const config = resolveRuntimeConfig(getRawOptions(command))
    format = config.defaultFormat
    const result = await handler(config, command.opts())
    const normalized: CommandResult<T> = result && typeof result === 'object' && 'data' in result
      ? result as CommandResult<T>
      : { data: result as T }
    const meta: CommandMeta = {
      ...(normalized.meta || {}),
      took_ms: Date.now() - started
    }
    writeEnvelope(context.output, successEnvelope(normalized.data, meta), format)
  } catch (error) {
    format = getFallbackFormat(command)
    writeEnvelope(context.output, errorEnvelope(error), format)
    context.setExitCode(1)
  }
}
