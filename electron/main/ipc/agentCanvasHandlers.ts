/**
 * Agent Canvas IPC —— 渲染端只经这里读写 Canvas（主进程单写者）。
 * 见 Docs/Agent-Canvas画布对接开发文档.md §7。
 * 所有入参在此重新校验：conversationId 正整数、canvasId 归属当前会话库、长度限制；
 * revision 冲突返回 { success:false, conflict }，由渲染端进入冲突处理流程。
 */
import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import {
  AgentCanvasConflictError,
  CANVAS_MAX_CONTENT_CHARS,
  CANVAS_MAX_TITLE_CHARS,
  type AgentCanvasKind,
} from '../../services/agent/canvasTypes'
import { agentCanvasStore, setAgentCanvasChangeBroadcaster } from '../../services/agent/agentCanvasStore'

function fail(error: unknown): { success: false; error?: string; conflict?: unknown } {
  if (error instanceof AgentCanvasConflictError) {
    return { success: false, error: error.message, conflict: error.conflict }
  }
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

function parseCanvasId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!id || id.length > 80) throw new Error('canvasId 无效')
  return id
}

function parseConversationId(value: unknown): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error('conversationId 必须是正整数')
  return id
}

function parseRevision(value: unknown): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision <= 0) throw new Error('revision 必须是正整数')
  return revision
}

function parseTitle(value: unknown): string {
  const title = String(value ?? '').trim()
  if (!title || title.length > CANVAS_MAX_TITLE_CHARS) throw new Error(`标题必须为 1-${CANVAS_MAX_TITLE_CHARS} 字符`)
  return title
}

function parseContent(value: unknown): string {
  const content = String(value ?? '')
  if (content.length > CANVAS_MAX_CONTENT_CHARS) throw new Error(`正文超过上限（${CANVAS_MAX_CONTENT_CHARS} 字符）`)
  return content
}

function parseKind(value: unknown): AgentCanvasKind {
  if (value !== 'document' && value !== 'code') throw new Error('kind 只支持 document/code')
  return value
}

function parseOriginClientId(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 80) : null
}

export function registerAgentCanvasHandlers(ctx: MainProcessContext): void {
  setAgentCanvasChangeBroadcaster((event) => ctx.broadcastToWindows('agentCanvas:updated', event))

  ipcMain.handle('agentCanvas:create', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.create({
        conversationId: parseConversationId(payload?.conversationId),
        kind: parseKind(payload?.kind),
        title: parseTitle(payload?.title),
        language: typeof payload?.language === 'string' ? payload.language.slice(0, 40) : undefined,
        content: parseContent(payload?.content),
        createdBy: 'user',
        originClientId: parseOriginClientId(payload?.originClientId),
      })
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:get', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.get(parseCanvasId(payload?.canvasId))
      if (!canvas) return { success: false, error: 'Canvas 不存在' }
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:list', async (_event, payload: any) => {
    try {
      return { success: true, canvases: agentCanvasStore.list(parseConversationId(payload?.conversationId)) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:update', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.update({
        canvasId: parseCanvasId(payload?.canvasId),
        baseRevision: parseRevision(payload?.baseRevision),
        content: parseContent(payload?.content),
        source: 'user',
        originClientId: parseOriginClientId(payload?.originClientId),
      })
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:rename', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.rename({
        canvasId: parseCanvasId(payload?.canvasId),
        baseRevision: parseRevision(payload?.baseRevision),
        title: parseTitle(payload?.title),
        source: 'user',
        originClientId: parseOriginClientId(payload?.originClientId),
      })
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:archive', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.archive({
        canvasId: parseCanvasId(payload?.canvasId),
        baseRevision: parseRevision(payload?.baseRevision),
        originClientId: parseOriginClientId(payload?.originClientId),
      })
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:listRevisions', async (_event, payload: any) => {
    try {
      return { success: true, revisions: agentCanvasStore.listRevisions(parseCanvasId(payload?.canvasId)) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:getRevision', async (_event, payload: any) => {
    try {
      const revision = agentCanvasStore.getRevision(parseCanvasId(payload?.canvasId), parseRevision(payload?.revision))
      if (!revision) return { success: false, error: '历史版本不存在' }
      return { success: true, revision }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agentCanvas:restore', async (_event, payload: any) => {
    try {
      const canvas = agentCanvasStore.restore({
        canvasId: parseCanvasId(payload?.canvasId),
        baseRevision: parseRevision(payload?.baseRevision),
        revision: parseRevision(payload?.revision),
        originClientId: parseOriginClientId(payload?.originClientId),
      })
      return { success: true, canvas }
    } catch (error) {
      return fail(error)
    }
  })
}
