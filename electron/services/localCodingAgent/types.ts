import type { CodeWorkspaceRef } from '../agent/codeWorkspaceTypes'

export type LocalCodingAgentKind = 'codex' | 'claude-cli' | 'opencode' | 'custom'
export type LocalCodingAgentRunMode = 'inspect' | 'propose' | 'direct'
export type LocalCodingAgentJobStatus = 'running' | 'finished' | 'failed' | 'canceled'

export interface LocalCodingAgentDefinition {
  kind: LocalCodingAgentKind
  name: string
  executablePath: string
  argsTemplate?: string[]
  env?: Record<string, string>
  timeoutMs: number
  model?: string
}

export interface LocalCodingAgentConfig {
  enabled: boolean
  activeAgent: string
  agents: Record<string, LocalCodingAgentDefinition>
}

export interface LocalCodingAgentRunInput {
  agentId: string
  mode: LocalCodingAgentRunMode
  prompt: string
  workspace: CodeWorkspaceRef
  model?: string
}

export type LocalCodingAgentEvent =
  | { type: 'started'; jobId: string; agentId: string; mode: LocalCodingAgentRunMode; cwd: string; at: number }
  | { type: 'stdout'; jobId: string; text: string; at: number }
  | { type: 'stderr'; jobId: string; text: string; at: number }
  | { type: 'message'; jobId: string; role: 'assistant' | 'tool' | 'system'; text: string; at: number }
  | { type: 'activity'; jobId: string; activity: 'reasoning' | 'tool'; toolName?: string; input?: unknown; output?: unknown; text?: string; at: number }
  | { type: 'diff'; jobId: string; patch: string; changedPaths: string[]; at: number }
  | { type: 'finished'; jobId: string; exitCode: number | null; durationMs: number; at: number }
  | { type: 'error'; jobId: string; error: string; at: number }

export interface LocalCodingAgentJob {
  id: string
  agentId: string
  mode: LocalCodingAgentRunMode
  prompt: string
  workspaceRoot: string
  runRoot: string
  shadowRoot?: string
  patchPath?: string
  patch?: string
  changedPaths: string[]
  status: LocalCodingAgentJobStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  error?: string
}

export interface LocalCodingAgentDetectResult {
  id: string
  kind: LocalCodingAgentKind
  name: string
  executablePath: string
  found: boolean
  version?: string
  error?: string
}

export interface LocalCodingAgentRunResult {
  success: boolean
  jobId?: string
  error?: string
}

export interface LocalCodingAgentPatchResult {
  success: boolean
  changedPaths?: string[]
  error?: string
}

