export type CodeWorkspaceApprovalKind = 'write' | 'delete' | 'command' | 'dev-server' | 'sensitive-read'
export type CodeWorkspaceApprovalRisk = 'low' | 'medium' | 'high'
export type CodeWorkspaceApprovalDecision = 'approved' | 'rejected'
export type CodeWorkspaceApprovalPolicy = 'on-request' | 'risk-based' | 'full-access'

export interface CodeWorkspaceRef {
  id: string
  root: string
  approvalPolicy: CodeWorkspaceApprovalPolicy
}

export interface CodeWorkspaceDevServerState {
  running: boolean
  command?: string
  pid?: number
  startedAt?: number
  previewUrl?: string
}

export interface CodeWorkspaceState {
  workspace: CodeWorkspaceRef | null
  devServer: CodeWorkspaceDevServerState
  recentLogs: string[]
}

export interface CodeWorkspaceFileItem {
  path: string
  type: 'file' | 'dir'
  sizeBytes?: number
}

export interface CodeWorkspaceListFilesResult {
  success: boolean
  root?: string
  items?: CodeWorkspaceFileItem[]
  truncated?: boolean
  error?: string
}

export type CodeWorkspaceBrowserDiagnosticKind =
  | 'console'
  | 'page-error'
  | 'load-failed'
  | 'render-process-gone'
  | 'navigation'

export interface CodeWorkspaceBrowserDiagnostic {
  kind: CodeWorkspaceBrowserDiagnosticKind
  level?: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
  line?: number
  url?: string
  at: number
}

export interface CodeWorkspaceBrowserDiagnosticsResult {
  success: boolean
  url?: string
  diagnostics?: CodeWorkspaceBrowserDiagnostic[]
  hasErrors?: boolean
  error?: string
}

export interface CodeWorkspaceApprovalRequest {
  requestId: string
  kind: CodeWorkspaceApprovalKind
  workspaceRoot: string
  targetPath?: string
  command?: string
  diffPreview?: string
  risk: CodeWorkspaceApprovalRisk
  summary: string
  createdAt: number
}

export interface CodeWorkspaceEvent {
  type: 'state' | 'log' | 'preview-url' | 'approval-resolved' | 'files-changed'
  state?: CodeWorkspaceState
  log?: string
  previewUrl?: string
  requestId?: string
  decision?: CodeWorkspaceApprovalDecision
  changedPaths?: string[]
  at: number
}

export interface CodeWorkspaceToolCall {
  method: string
  args?: Record<string, unknown>
  workspace?: CodeWorkspaceRef | null
}
