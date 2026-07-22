import type {
  LocalCodingAgentConfig,
  LocalCodingAgentDetectResult,
  LocalCodingAgentRunMode,
} from '@/types/electron'

export const LOCAL_CODING_AGENT_OPTIONS: Array<{ id: string; label: string; detail: string }> = [
  { id: 'codex', label: 'Codex CLI', detail: 'codex exec' },
  { id: 'claude', label: 'Claude Code', detail: 'claude -p' },
  { id: 'opencode', label: 'OpenCode', detail: 'opencode run' },
]

export const LOCAL_CODING_AGENT_MODE_OPTIONS: Array<{ id: LocalCodingAgentRunMode; label: string; detail: string }> = [
  { id: 'inspect', label: '只读分析', detail: '只读沙箱，不写入文件' },
  { id: 'propose', label: '生成补丁', detail: '临时副本内修改，确认后应用' },
]

export function defaultLocalCodingAgentConfig(): LocalCodingAgentConfig {
  return {
    enabled: false,
    activeAgent: 'codex',
    agents: {
      codex: { kind: 'codex', name: 'Codex CLI', executablePath: '', timeoutMs: 1_800_000 },
      claude: { kind: 'claude-cli', name: 'Claude Code', executablePath: '', timeoutMs: 1_800_000 },
      opencode: { kind: 'opencode', name: 'OpenCode', executablePath: '', timeoutMs: 1_800_000 },
    },
  }
}

export function normalizeLocalCodingAgentConfig(value?: LocalCodingAgentConfig | null): LocalCodingAgentConfig {
  const fallback = defaultLocalCodingAgentConfig()
  if (!value) return fallback
  return {
    enabled: Boolean(value.enabled),
    activeAgent: value.activeAgent || fallback.activeAgent,
    agents: {
      ...fallback.agents,
      ...(value.agents || {}),
    },
  }
}

export function getLocalCodingAgentLabel(config: LocalCodingAgentConfig | null | undefined, agentId?: string): string {
  const id = agentId || config?.activeAgent || 'codex'
  return config?.agents?.[id]?.name
    || LOCAL_CODING_AGENT_OPTIONS.find((option) => option.id === id)?.label
    || id
}

export function getLocalCodingAgentOptions(config: LocalCodingAgentConfig | null | undefined) {
  const known = new Set(LOCAL_CODING_AGENT_OPTIONS.map((option) => option.id))
  const custom = Object.entries(config?.agents || {})
    .filter(([id]) => !known.has(id))
    .map(([id, agent]) => ({ id, label: agent.name || id, detail: agent.kind }))
  return [...LOCAL_CODING_AGENT_OPTIONS, ...custom]
}

export function summarizeLocalCodingAgentDetection(results: LocalCodingAgentDetectResult[]): string {
  const found = results.filter((item) => item.found)
  if (found.length === 0) return '未探测到已安装的本地编码智能体'
  return `已探测到 ${found.map((item) => item.name).join('、')}`
}
