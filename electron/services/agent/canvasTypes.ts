/**
 * Agent Canvas（对话内可编辑产物）类型定义。
 * 见 Docs/Agent-Canvas画布对接开发文档.md §5。
 * 与 WebGL 动画组件 AgentReasoningCanvas 无关。
 */

export type AgentCanvasKind = 'document' | 'code'
export type AgentCanvasStatus = 'active' | 'archived'
export type AgentCanvasSource = 'user' | 'agent' | 'restore'
export type AgentCanvasAction = 'created' | 'updated' | 'renamed' | 'archived' | 'restored'

/** 存储限制（主进程为准，渲染端/工具入参只做前置校验） */
export const CANVAS_MAX_CONTENT_CHARS = 200_000
export const CANVAS_MAX_TITLE_CHARS = 120
export const CANVAS_MAX_EDITS = 50
export const CANVAS_KEEP_REVISIONS = 50

export interface AgentCanvasRecord {
  id: string
  conversationId: number
  kind: AgentCanvasKind
  title: string
  language?: string
  content: string
  revision: number
  status: AgentCanvasStatus
  createdBy: 'user' | 'agent'
  createdAt: number
  updatedAt: number
}

/** 版本列表条目：不携带正文，正文按需走 getRevision。 */
export interface AgentCanvasRevisionMeta {
  canvasId: string
  revision: number
  source: AgentCanvasSource
  contentLength: number
  createdAt: number
}

export interface AgentCanvasRevision extends AgentCanvasRevisionMeta {
  content: string
}

/** 消息流里的 data-canvas 引用（不含正文）。 */
export interface AgentCanvasRefData {
  canvasId: string
  conversationId: number
  kind: AgentCanvasKind
  title: string
  revision: number
  action: 'created' | 'updated' | 'renamed' | 'restored'
}

export interface AgentCanvasConflict {
  code: 'REVISION_CONFLICT'
  canvasId: string
  expectedRevision: number
  actualRevision: number
  current: AgentCanvasRecord
}

/** revision 乐观锁冲突：抛错携带结构化冲突，上层转成 { success:false, conflict }。 */
export class AgentCanvasConflictError extends Error {
  readonly conflict: AgentCanvasConflict

  constructor(conflict: AgentCanvasConflict) {
    super(`Canvas revision 冲突：期望 ${conflict.expectedRevision}，当前 ${conflict.actualRevision}`)
    this.conflict = conflict
  }
}

export interface AgentCanvasUpdatedEvent {
  canvasId: string
  conversationId: number
  revision: number
  action: AgentCanvasAction
  originClientId?: string | null
  updatedAt: number
}

/** agent:run 附带的会话 Canvas 上下文（主进程校验后进入 AgentRunInput）。 */
export interface AgentCanvasRunContext {
  conversationId: number
  activeCanvasId?: string
  activeRevision?: number
}

export interface CreateCanvasInput {
  conversationId: number
  kind: AgentCanvasKind
  title: string
  language?: string
  content: string
  createdBy: 'user' | 'agent'
  originClientId?: string | null
}

export interface UpdateCanvasInput {
  canvasId: string
  baseRevision: number
  content: string
  source: AgentCanvasSource
  originClientId?: string | null
}

export interface RenameCanvasInput {
  canvasId: string
  baseRevision: number
  title: string
  source: AgentCanvasSource
  originClientId?: string | null
}

export interface ArchiveCanvasInput {
  canvasId: string
  baseRevision: number
  originClientId?: string | null
}

export interface RestoreCanvasInput {
  canvasId: string
  baseRevision: number
  revision: number
  originClientId?: string | null
}
