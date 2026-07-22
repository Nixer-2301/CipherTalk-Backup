/**
 * canvas_* 工具 —— Agent 对会话 Canvas 的创建/读取/局部编辑/全文替换/重命名。
 * 见 Docs/Agent-Canvas画布对接开发文档.md §8。
 *
 * 跑在 AI utility process；Canvas 数据库只能由主进程写，全部经 capability proxy 代理。
 * conversationId 一律取自主进程校验过的 canvasContext，不接受模型指定（防跨会话访问）。
 * 写操作成功后发一个 data-canvas 引用 chunk（不含正文），落进当前助手消息并随会话持久化。
 */
import { tool, type ToolSet, type UIMessageChunk } from 'ai'
import { z } from 'zod'
import { proxyAgentCapabilityCall } from '../agentCapabilityProxyClient'
import type { AgentCanvasRunContext } from '../canvasTypes'

type CanvasToolResult = {
  success?: boolean
  canvasId?: string
  conversationId?: number
  kind?: 'document' | 'code'
  title?: string
  revision?: number
}

function callCanvas(method: string, args: Record<string, unknown>): Promise<CanvasToolResult> {
  return proxyAgentCapabilityCall<CanvasToolResult>(method, args).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }) as CanvasToolResult)
}

function emitCanvasRef(
  emitChunk: ((chunk: UIMessageChunk) => void) | undefined,
  result: CanvasToolResult,
  action: 'created' | 'updated' | 'renamed',
): void {
  if (!emitChunk || result.success !== true || !result.canvasId) return
  try {
    emitChunk({
      type: 'data-canvas',
      id: `canvas-${result.canvasId}-${result.revision}`,
      data: {
        canvasId: result.canvasId,
        conversationId: result.conversationId,
        kind: result.kind,
        title: result.title,
        revision: result.revision,
        action,
      },
    } as UIMessageChunk)
  } catch {
    // 引用 chunk 发送失败不影响工具结果；Canvas 本身已落库，可从面板恢复
  }
}

export function createCanvasTools(
  context: AgentCanvasRunContext | undefined,
  emitChunk?: (chunk: UIMessageChunk) => void,
): ToolSet {
  if (!context || !Number.isInteger(context.conversationId) || context.conversationId <= 0) return {}
  const conversationId = context.conversationId

  return {
    canvas_create: tool({
      description:
        '创建一个会话 Canvas（画布）：持久化、用户可继续编辑的 Markdown 文档或单文件代码。' +
        '用户要求"起草/写一份放到画布/可编辑的文档或代码"时用它；普通回答不要建画布。创建后画布会自动展示，不要再把全文贴回聊天。',
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('画布标题'),
        kind: z.enum(['document', 'code']).describe('document=Markdown 文档；code=单文件代码'),
        language: z.string().max(40).optional().describe('kind=code 时的语言标识，如 typescript/python'),
        content: z.string().max(200_000).describe('初始正文'),
      }),
      execute: async (args) => {
        const result = await callCanvas('canvas_create', { ...args, conversationId })
        emitCanvasRef(emitChunk, result, 'created')
        return result
      },
    }),

    canvas_read: tool({
      description:
        '读取 Canvas 的最新正文和 revision。修改画布前必须先读，拿到最新 baseRevision；' +
        '用户说"继续修改画布/这篇文档/这段代码"时优先读当前活动画布。',
      inputSchema: z.object({
        canvasId: z.string().min(1),
      }),
      execute: async (args) => callCanvas('canvas_read', { ...args, conversationId }),
    }),

    canvas_edit: tool({
      description:
        '对 Canvas 做局部查找替换（优先于 canvas_replace，避免整篇重写）。' +
        'search 必须唯一命中（多处命中请给更长上下文或 replaceAll=true）；任一 edit 失败整次回滚。' +
        '返回 REVISION_CONFLICT 时必须先 canvas_read 再重试。',
      inputSchema: z.object({
        canvasId: z.string().min(1),
        baseRevision: z.number().int().positive().describe('canvas_read 返回的最新 revision'),
        edits: z.array(z.object({
          search: z.string().min(1).describe('要查找的原文片段（唯一命中）'),
          replace: z.string().describe('替换后的内容'),
          replaceAll: z.boolean().default(false).describe('是否替换所有命中'),
        })).min(1).max(50),
      }),
      execute: async (args) => {
        const result = await callCanvas('canvas_edit', { ...args, conversationId })
        emitCanvasRef(emitChunk, result, 'updated')
        return result
      },
    }),

    canvas_replace: tool({
      description:
        '全文重写 Canvas。只在用户明确要求整篇重写、或改动范围大到局部编辑不划算时用；小改动一律用 canvas_edit。' +
        '返回 REVISION_CONFLICT 时必须先 canvas_read 再重试，不得覆盖用户的新编辑。',
      inputSchema: z.object({
        canvasId: z.string().min(1),
        baseRevision: z.number().int().positive(),
        content: z.string().max(200_000),
      }),
      execute: async (args) => {
        const result = await callCanvas('canvas_replace', { ...args, conversationId })
        emitCanvasRef(emitChunk, result, 'updated')
        return result
      },
    }),

    canvas_rename: tool({
      description: '重命名 Canvas 标题。',
      inputSchema: z.object({
        canvasId: z.string().min(1),
        baseRevision: z.number().int().positive(),
        title: z.string().min(1).max(120),
      }),
      execute: async (args) => {
        const result = await callCanvas('canvas_rename', { ...args, conversationId })
        emitCanvasRef(emitChunk, result, 'renamed')
        return result
      },
    }),
  }
}
