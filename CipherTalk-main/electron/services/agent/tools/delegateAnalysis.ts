/**
 * delegate_analysis —— 子 Agent 委托（见文档 §9.3 / D7）。
 *
 * 把「读大量消息」的子任务交给独立的 ToolLoopAgent 跑完，只把结论 + 出处回给主 Agent，
 * 子任务翻的原始消息不进主上下文（配合 compaction，进一步压住上下文体积）。
 * 支持一次传入最多 10 个互相独立的子任务并发执行；子 Agent 用 buildBaseTools（不含本工具，避免递归委托），带步数上限 + 死循环检测。
 * 出处：从子 Agent 各工具结果里聚合 evidence 回传，让主 Agent 也能给可点 Sources（带出处硬要求）。
 */
import { ToolLoopAgent, isStepCount, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { createLanguageModel } from '../provider'
import { buildSystemPrompt } from '../prompts'
import { buildReasoningOption } from '../cache'
import { loopGuardCondition } from '../guards'
import { compactMessages } from '../compaction'
import { reportAgentProgress, withSubAgentScope } from '../progress'
import { buildToolRuntimeContext } from '../toolPolicy'
import { describeToolError, type AgentEvidenceItem } from './shared'
import type { AgentProviderConfig, AgentScope } from '../types'

const SUB_AGENT_MAX_STEPS = 12
const MAX_DELEGATE_TASKS = 10
const DEFAULT_DELEGATE_CONCURRENCY = 10
const MAX_DELEGATED_EVIDENCE = 15
const DEFAULT_SUB_AGENT_TEMPERATURE = 0.2
const MAX_PROGRESS_DETAIL_LENGTH = 180

type DelegateTask = {
  id: string
  task: string
}

type DelegateTaskResult = {
  id: string
  task: string
  conclusion?: string
  error?: string
  steps: number
  evidence: AgentEvidenceItem[]
  elapsedMs: number
}

function summarizeProgressDetail(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > MAX_PROGRESS_DETAIL_LENGTH ? `${text.slice(0, MAX_PROGRESS_DETAIL_LENGTH)}...` : text
}

function dedupeEvidence(items: AgentEvidenceItem[], limit = MAX_DELEGATED_EVIDENCE): AgentEvidenceItem[] {
  const out: AgentEvidenceItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const id = item?.id
    const key = id || `${item?.sessionId || ''}:${item?.time || ''}:${item?.sender || ''}:${item?.text || ''}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= limit) return out
  }
  return out
}

/** 从子 Agent 的各步工具结果里聚合 evidence（去重、限量），供主 Agent 标注可点出处。 */
function collectEvidence(steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>): AgentEvidenceItem[] {
  const items: AgentEvidenceItem[] = []
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      const ev = (tr.output as { evidence?: unknown } | undefined)?.evidence
      if (!Array.isArray(ev)) continue
      for (const item of ev as AgentEvidenceItem[]) {
        if (item) items.push(item)
      }
    }
  }
  return dedupeEvidence(items)
}

function normalizeTaskId(value: string | undefined, index: number): string {
  const id = String(value || '').replace(/\s+/g, '-').replace(/[^\w-]/g, '').slice(0, 32)
  return id || `task-${index + 1}`
}

function assignUniqueTaskIds(tasks: DelegateTask[]): DelegateTask[] {
  const seen = new Map<string, number>()
  return tasks.map((task, index) => {
    const baseId = task.id || `task-${index + 1}`
    const count = seen.get(baseId) || 0
    seen.set(baseId, count + 1)
    return { ...task, id: count === 0 ? baseId : `${baseId}-${count + 1}` }
  })
}

function normalizeTasks(input: { task?: string; tasks?: Array<{ id?: string; task?: string }>; maxConcurrency?: number }) {
  const rawTasks = Array.isArray(input.tasks) && input.tasks.length > 0
    ? input.tasks.map((item, index) => ({
      id: normalizeTaskId(item?.id, index),
      task: String(item?.task || '').trim(),
    }))
    : [{
      id: 'task-1',
      task: String(input.task || '').trim(),
    }]
  const validTasks = assignUniqueTaskIds(rawTasks.filter((item) => item.task.length > 0))
  const truncated = validTasks.length > MAX_DELEGATE_TASKS
  const tasks = validTasks.slice(0, MAX_DELEGATE_TASKS)
  const requestedConcurrency = Number(input.maxConcurrency ?? DEFAULT_DELEGATE_CONCURRENCY)
  const maxConcurrency = Math.max(1, Math.min(
    Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : DEFAULT_DELEGATE_CONCURRENCY,
    DEFAULT_DELEGATE_CONCURRENCY,
    Math.max(tasks.length, 1)
  ))
  return { tasks, maxConcurrency, truncated }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }))

  return results
}

function buildAggregateConclusion(results: DelegateTaskResult[], truncated: boolean): string {
  if (results.length === 0) return '（没有可执行的子任务）'
  if (results.length === 1) {
    const only = results[0]
    return only.conclusion || `（子助手分析失败：${only.error || '未知错误'}）`
  }

  const succeeded = results.filter((item) => !item.error).length
  const lines = [
    `并行子助手完成 ${succeeded}/${results.length} 个子任务。`,
    ...results.map((item, index) => {
      const label = item.id || `task-${index + 1}`
      if (item.error) return `- ${label}：失败：${item.error}`
      return `- ${label}：${item.conclusion || '未得出明确结论'}`
    }),
  ]
  if (truncated) lines.push(`已达到单次最多 ${MAX_DELEGATE_TASKS} 个子任务的限制，超出的任务未执行。`)
  return lines.join('\n')
}

const DELEGATE_SUFFIX =
  '\n\n你现在是被主助手委托的【子助手】：只专注完成下面这一个子任务，' +
  '用工具查到的真实数据得出结论，简洁作答并在结论里标注关键出处（时间 + 发送者）。' +
  '不要寒暄、不要复述任务，直接给结论。' +
  '你自己没有 delegate_analysis、update_plan、记忆工具或 MCP 工具，请直接用读/查/统计工具完成，不要尝试再委托或规划。'

export function createDelegateAnalysis(opts: {
  providerConfig: AgentProviderConfig
  scope: AgentScope
  /** 子 Agent 用的工具集（应为 buildBaseTools 结果，不含 delegate_analysis）。 */
  buildSubTools: () => ToolSet
}) {
  return tool({
    description:
      '把需要读大量消息的一个或多个独立子任务委托给子助手并发分析，只回结论（原始消息不进你的上下文）。' +
      `适合「总结某人某段时间都聊了啥 / 梳理某话题的来龙去脉」这类要翻很多条的重活；最多 ${MAX_DELEGATE_TASKS} 个子任务，默认 ${DEFAULT_DELEGATE_CONCURRENCY} 并发。` +
      '单任务用 task；多任务用 tasks，每个 task 写清范围（会话 username / 时间段）和期望结论形式。' +
      '简单精确查询直接用 search_messages / chat_stats，别委托。',
    inputSchema: z.object({
      task: z.string().optional().describe('兼容旧调用的单个委托任务。批量分析时优先使用 tasks。'),
      tasks: z.array(z.object({
        id: z.string().optional().describe('子任务短 ID，例如 Q1、topic-1、person-a；用于进度分组。'),
        task: z.string().describe('子任务：分析什么、范围（会话 username / 时间段）、期望结论形式。'),
      })).optional().describe(`批量委托任务；超过 ${MAX_DELEGATE_TASKS} 个时只执行前 ${MAX_DELEGATE_TASKS} 个并在结果中说明。`),
      maxConcurrency: z.number().int().min(1).max(DEFAULT_DELEGATE_CONCURRENCY).optional().describe(`最大并发子助手数，默认 ${DEFAULT_DELEGATE_CONCURRENCY}。`),
    }),
    execute: async (input, { abortSignal, toolCallId }) => {
      const { tasks, maxConcurrency, truncated } = normalizeTasks(input)
      const parentToolCallId = typeof toolCallId === 'string' ? toolCallId : undefined

      if (tasks.length === 0) {
        return { error: 'delegate_analysis 至少需要一个非空 task 或 tasks[].task' }
      }

      const runTask = async (taskItem: DelegateTask): Promise<DelegateTaskResult> => withSubAgentScope({
        parentToolCallId,
        subTaskId: taskItem.id,
        subTaskTitle: summarizeProgressDetail(taskItem.task),
      }, async () => {
        const startedAt = Date.now()
        reportAgentProgress({
          stage: 'run_started',
          title: '子助手开始分析',
          detail: summarizeProgressDetail(taskItem.task),
        })
        try {
          const tools = opts.buildSubTools()
          const subAgent = new ToolLoopAgent({
            model: createLanguageModel(opts.providerConfig),
            instructions: buildSystemPrompt(opts.scope) + DELEGATE_SUFFIX,
            tools,
            temperature: DEFAULT_SUB_AGENT_TEMPERATURE,
            reasoning: buildReasoningOption(opts.providerConfig),
            stopWhen: [isStepCount(SUB_AGENT_MAX_STEPS), loopGuardCondition()],
            prepareStep: ({ messages, steps }) => {
              const runtimeContext = buildToolRuntimeContext(steps)
              return {
                messages: compactMessages(messages),
                runtimeContext,
                toolsContext: { query_sql: runtimeContext } as any,
              }
            },
          })
          const result = await subAgent.generate({ prompt: taskItem.task, abortSignal })
          const conclusion = result.text.trim()
          reportAgentProgress({
            stage: 'run_finished',
            title: '子助手分析完成',
            detail: conclusion ? summarizeProgressDetail(conclusion) : '未得出明确结论',
            elapsedMs: Date.now() - startedAt,
          })
          return {
            id: taskItem.id,
            task: taskItem.task,
            conclusion: conclusion || '（子助手未得出结论，可能任务过大或数据不足，建议缩小范围重试）',
            steps: result.steps.length,
            evidence: collectEvidence(result.steps),
            elapsedMs: Date.now() - startedAt,
          }
        } catch (e) {
          const message = describeToolError(e, '子助手分析失败')
          reportAgentProgress({
            stage: 'error',
            title: '子助手分析失败',
            detail: message,
            elapsedMs: Date.now() - startedAt,
          })
          return {
            id: taskItem.id,
            task: taskItem.task,
            error: message,
            steps: 0,
            evidence: [],
            elapsedMs: Date.now() - startedAt,
          }
        }
      })

      const results = await runWithConcurrency(tasks, maxConcurrency, runTask)
      const evidence = dedupeEvidence(results.flatMap((result) => result.evidence))
      const failedTasks = results.filter((result) => result.error).length
      const succeededTasks = results.length - failedTasks

      return {
        conclusion: buildAggregateConclusion(results, truncated),
        results,
        evidence,
        totalTasks: results.length,
        succeededTasks,
        failedTasks,
        maxConcurrency,
        truncated,
      }
    },
  })
}
