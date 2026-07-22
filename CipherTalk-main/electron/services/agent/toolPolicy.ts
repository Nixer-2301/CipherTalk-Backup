import type { StepResult, ToolSet } from 'ai'

/**
 * query_sql 门控：只有当模型已经实际用过结构化检索/统计工具后，才把 query_sql 放进
 * activeTools 解锁。防止主/子 Agent 一上来绕过专用工具直接写 SQL。
 */
const SQL_GATE_UNLOCK_TOOLS = new Set([
  'search_messages',
  'semantic_search',
  'chat_stats',
  'get_timeline',
  'get_context',
  'list_groups',
  'group_members',
  'group_member_ranking',
  'search_moments',
  'moments_stats',
])

export interface AgentToolRuntimeContext {
  querySqlUnlocked: boolean
}

export function isQuerySqlUnlocked(steps: ReadonlyArray<StepResult<ToolSet>>): boolean {
  return steps.some((step) => step.toolCalls.some((call) => SQL_GATE_UNLOCK_TOOLS.has(call.toolName)))
}

export function buildToolRuntimeContext(steps: ReadonlyArray<StepResult<ToolSet>>): AgentToolRuntimeContext {
  return { querySqlUnlocked: isQuerySqlUnlocked(steps) }
}

export function readToolRuntimeContext(value: unknown): AgentToolRuntimeContext {
  const context = value && typeof value === 'object' ? value as Partial<AgentToolRuntimeContext> : {}
  return { querySqlUnlocked: context.querySqlUnlocked === true }
}
