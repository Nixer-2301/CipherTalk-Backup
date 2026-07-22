/**
 * 编排护栏 —— 防死循环 + 防工具卡死（见 Docs 文档 §9.2）。
 *
 * 1. loopGuardCondition：做成 stopWhen 条件，检测连续 N 步相同的工具调用指纹（toolName+input），
 *    命中即让 ToolLoopAgent「优雅停止」（不抛 AbortError，已产出的内容照常返回）。
 * 2. withToolTimeouts：给每个工具 execute 套 Promise.race 超时，超时返回 {error} 不挂住对话。
 *    首次触发重建的工具（semantic_search 嵌入 / search_messages 建 FTS 索引）给更长超时，避免误杀。
 *
 * 报错兜底（工具一律返回 {error} 不抛）已在各 tool 的 execute try/catch 内实现，此处不重复。
 */
import type { StepResult, StopCondition, Tool, ToolSet } from 'ai'
import { reportAgentProgress } from './progress'

/** 连续这么多步出现相同工具调用指纹 → 判定死循环，停止。 */
const MAX_IDENTICAL_TOOL_REPEATS = 3
/** 工具执行默认超时（毫秒）。本地 SQLite 工具远快于此，超时即视为卡死。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
/** 首次会触发重建（嵌入 / FTS 索引）或本身跑子 Agent 的重工具，给更宽松超时。 */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  semantic_search: 240_000,
  search_messages: 240_000,
  transcribe_voice_message: 600_000, // 本地大模型首次加载或在线转写可能耗时较长
  delegate_analysis: 600_000, // 子 Agent 批量整轮（最多 4 个并发子任务 + 可能触发首次重建），给更长上限
  search_stickers: 240_000, // 首次构建表情包词典可能触发最近会话补建索引
  search_media: 240_000, // 首次搜索历史媒体可能触发最近会话补建索引
  search_moment_media: 240_000, // 朋友圈媒体检索可能触发 XML 解析和媒体元数据整理
  search_similar_media: 120_000, // 以图找图只向量化本轮上传图，并搜索已有历史图片向量
  inspect_media_image: 600_000, // 历史媒体解密 + 额外一次视觉模型调用
  send_random_image: 240_000, // 同上 + 图片解密
  send_media_from_history: 240_000, // 历史图片/表情包解密与落盘
  generate_image: 3_600_000, // 慢速作图模型经常超过 1 分钟，跟作图服务默认超时保持一致
  export_chat: 3_600_000, // 导出可能包含媒体复制/解密，交给独立导出进程长跑
  index_local_files: 600_000,
  search_local_files: 300_000,
  find_files: 120_000,
  add_knowledge_source: 300_000,
  search_knowledge: 120_000,
  remove_knowledge_source: 120_000,
  create_artifact: 300_000,
  create_task: 120_000,
  list_tasks: 120_000,
  update_task: 120_000,
  cancel_task: 120_000,
  run_task_now: 120_000,
  list_audit_logs: 120_000,
  rollback_operation: 300_000,
  desktop_screenshot: 120_000,
  desktop_ocr: 120_000,
  audit_memories: 120_000,
  apply_memory_fix: 300_000,
  canvas_create: 120_000,
  canvas_read: 120_000,
  canvas_edit: 120_000,
  canvas_replace: 600_000, // 可能等待用户审批
  canvas_rename: 120_000,
  code_read_file: 120_000,
  code_list_files: 120_000,
  code_workspace_status: 120_000,
  code_replace_in_file: 600_000, // 可能等待用户审批
  code_write_file: 600_000,
  code_delete_file: 600_000,
  code_run_command: 600_000,
  code_start_dev_server: 600_000,
  code_stop_dev_server: 120_000,
  code_get_dev_server_logs: 120_000,
}

function stepFingerprint(step: StepResult<ToolSet>): string | null {
  if (!step.toolCalls || step.toolCalls.length === 0) return null
  return step.toolCalls
    .map((c) => {
      let input = ''
      try {
        input = JSON.stringify(c.input)
      } catch {
        input = '<unserializable>'
      }
      return `${c.toolName}:${input}`
    })
    .sort()
    .join('|')
}

/** 最近连续步骤是否陷入相同工具调用；引擎可据此保留一个禁用工具的最终答复步骤。 */
export function hasRepeatedToolCallLoop(steps: StepResult<ToolSet>[]): boolean {
  if (steps.length < MAX_IDENTICAL_TOOL_REPEATS) return false
  const recent = steps.slice(-MAX_IDENTICAL_TOOL_REPEATS).map(stepFingerprint)
  const first = recent[0]
  return first !== null && recent.every((fingerprint) => fingerprint === first)
}

/** 死循环检测：最近 N 步工具调用指纹完全相同（且非空）→ 停止。 */
export function loopGuardCondition(): StopCondition<ToolSet> {
  return ({ steps }) => hasRepeatedToolCallLoop(steps)
}

/** 给每个工具的 execute 套超时，超时返回 {error}（不抛、不挂住循环）。 */
export function withToolTimeouts(tools: ToolSet, defaultMs = DEFAULT_TOOL_TIMEOUT_MS): ToolSet {
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    const orig = t.execute
    if (typeof orig !== 'function') {
      out[name] = t
      continue
    }
    const ms = TOOL_TIMEOUT_OVERRIDES[name] ?? defaultMs
    out[name] = {
      ...t,
      execute: (input: unknown, options) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const startedAt = Date.now()
        const toolCallId = typeof options?.toolCallId === 'string' ? options.toolCallId : undefined
        reportAgentProgress({
          stage: 'tool_started',
          title: `调用工具 ${name}`,
          toolName: name,
          toolCallId,
        })
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ error: `工具 ${name} 执行超时（>${ms}ms）` }), ms)
        })
        return Promise.race([Promise.resolve(orig(input, options)), timeout])
          .then((result) => {
            const error = result && typeof result === 'object' && 'error' in result
              ? String((result as { error?: unknown }).error || '')
              : ''
            reportAgentProgress({
              stage: error ? 'error' : 'tool_finished',
              title: error ? `工具 ${name} 返回错误` : `工具 ${name} 完成`,
              detail: error || undefined,
              toolName: name,
              toolCallId,
              elapsedMs: Date.now() - startedAt,
            })
            return result
          })
          .finally(() => {
            if (timer) clearTimeout(timer)
          })
      },
    } as Tool
  }
  return out
}
