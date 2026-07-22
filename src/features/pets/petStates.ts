/**
 * petdex 宠物精灵图动画状态表（与 Codex Pets 同一约定）。
 * 精灵图固定 8 列 × 9 行，每帧 192×208，每行一个状态，从第 0 帧起播 frames 帧。
 */

export type PetStateId =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export const PET_STATE_IDS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
] as const satisfies readonly PetStateId[]

export type PetStateSpec = {
  row: number
  frames: number
  durationMs: number
}

export const PET_STATES: Record<PetStateId, PetStateSpec> = {
  idle: { row: 0, frames: 6, durationMs: 1100 },
  'running-right': { row: 1, frames: 8, durationMs: 1060 },
  'running-left': { row: 2, frames: 8, durationMs: 1060 },
  waving: { row: 3, frames: 4, durationMs: 700 },
  jumping: { row: 4, frames: 5, durationMs: 840 },
  failed: { row: 5, frames: 8, durationMs: 1220 },
  waiting: { row: 6, frames: 6, durationMs: 1010 },
  running: { row: 7, frames: 6, durationMs: 820 },
  review: { row: 8, frames: 6, durationMs: 1030 },
}

/** Agent 运行状态 → 宠物动画状态 */
export type PetAgentState = 'idle' | 'running' | 'failed' | 'done'

export function petStateForAgent(state: PetAgentState): PetStateId {
  switch (state) {
    case 'running': return 'running'
    case 'failed': return 'failed'
    case 'done': return 'waving'
    default: return 'idle'
  }
}
