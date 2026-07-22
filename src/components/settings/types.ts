export interface UpdateInfo {
  hasUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
  version?: string
  releaseNotes?: string
  title?: string
  message?: string
  minimumSupportedVersion?: string
  reason?: 'minimum-version' | 'blocked-version'
  checkedAt: number
  updateSource: 'r2' | 'github' | 'custom' | 'none'
  policySource: 'r2' | 'github' | 'custom' | 'none'
  diagnostics?: {
    phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
    strategy: 'unknown' | 'differential' | 'full'
    fallbackToFull: boolean
    lastError?: string
    lastEvent?: string
    progressPercent?: number
    downloadedBytes?: number
    totalBytes?: number
    targetVersion?: string
    lastUpdatedAt: number
  }
}
