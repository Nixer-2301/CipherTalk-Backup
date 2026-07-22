/**
 * update_plan —— 轻量规划工具（见文档 §7 / §8 "复杂问题先 update_plan"）。
 *
 * 复杂/多步问题让模型先externalize一份步骤清单，随进展重发更新。
 * 纯"内存态"：本工具不做任何副作用，只校验 + 回显计划——计划随工具调用进入对话历史，
 * 模型每次更新都重发整份（最新一份总在近端，compaction 不会裁掉），并由前端 Tool 气泡展示给用户。
 */
import { tool } from 'ai'
import { z } from 'zod'

export const updatePlan = tool({
  description:
    '把复杂任务拆成步骤清单并随进展更新。跨多人/长时间跨度/要综合多轮的复杂问题，先用它列计划再动手，' +
    '每推进一步就重发整份更新后的清单（标 done/in_progress/pending）。简单一步到位的问题别用。',
  inputSchema: z.object({
    steps: z
      .array(
        z.object({
          step: z.string().describe('步骤的简短描述'),
          status: z.enum(['pending', 'in_progress', 'done']).describe('步骤状态'),
        }),
      )
      .min(1)
      .max(12)
      .describe('完成任务的步骤清单（含状态）；每次推进重发整份更新后的清单'),
  }),
  execute: async ({ steps }) => {
    const done = steps.filter((s) => s.status === 'done').length
    return { acknowledged: true, total: steps.length, done, steps }
  },
})
