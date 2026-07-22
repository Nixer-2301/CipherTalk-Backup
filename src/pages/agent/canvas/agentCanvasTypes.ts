/**
 * Agent Canvas 渲染端类型 —— 统一 re-export 主进程契约类型（见 src/types/electron.d.ts），
 * 外加只属于渲染端的 UI 状态类型。
 */
import type {
  AgentCanvasAction,
  AgentCanvasConflictInfo,
  AgentCanvasKind,
  AgentCanvasListItem,
  AgentCanvasRecord,
  AgentCanvasRefData,
  AgentCanvasRevisionInfo,
  AgentCanvasRevisionMeta,
  AgentCanvasSource,
  AgentCanvasStatus,
  AgentCanvasUpdatedEvent,
} from '@/types/electron'

export type {
  AgentCanvasAction,
  AgentCanvasConflictInfo,
  AgentCanvasKind,
  AgentCanvasListItem,
  AgentCanvasRecord,
  AgentCanvasRefData,
  AgentCanvasRevisionInfo,
  AgentCanvasRevisionMeta,
  AgentCanvasSource,
  AgentCanvasStatus,
  AgentCanvasUpdatedEvent,
}

/** 面板保存状态（工具栏展示用） */
export type AgentCanvasSaveStatus = 'saved' | 'dirty' | 'saving' | 'save-failed' | 'conflict'

export interface AgentCanvasUiState {
  open: boolean
  activeCanvasId: string | null
  record: AgentCanvasRecord | null
  draft: string
  savedContent: string
  loading: boolean
  saving: boolean
  conflict: AgentCanvasConflictInfo | null
  error: string | null
}

/** agent:run 携带的活动画布上下文（transport getCanvasContext 用） */
export interface AgentCanvasRunContextInput {
  activeCanvasId?: string
  activeRevision?: number
}
