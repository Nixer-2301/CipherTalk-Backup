import { AsyncLocalStorage } from 'async_hooks'
import type { AgentProgressEvent, AgentProgressReporter } from './types'

export type SubAgentProgressMeta = Pick<AgentProgressEvent, 'parentToolCallId' | 'subTaskId' | 'subTaskTitle'>

const progressStorage = new AsyncLocalStorage<AgentProgressReporter>()
const depthStorage = new AsyncLocalStorage<number>()
const subAgentMetaStorage = new AsyncLocalStorage<SubAgentProgressMeta>()

export async function withAgentProgress<T>(
  reporter: AgentProgressReporter | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!reporter) return fn()
  return progressStorage.run(reporter, fn)
}

/** 委托子 Agent 期间提升进度深度：其内工具进度带 depth≥1，前端据此标"子助手"。 */
export async function withSubAgentScope<T>(meta: SubAgentProgressMeta, fn: () => Promise<T>): Promise<T> {
  const depth = (depthStorage.getStore() ?? 0) + 1
  return depthStorage.run(depth, () => subAgentMetaStorage.run(meta, fn))
}

export function reportAgentProgress(event: Omit<AgentProgressEvent, 'at'>): void {
  const reporter = progressStorage.getStore()
  if (!reporter) return
  const meta = subAgentMetaStorage.getStore()
  reporter({ depth: depthStorage.getStore() ?? 0, ...meta, ...event, at: Date.now() })
}
