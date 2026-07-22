import type { AgentMcpToolDescriptor, AgentProviderConfig, AgentProviderConfigOverride, AgentScope, AgentSkillContextItem, AgentToolProfile } from './types'
import type { CodeWorkspaceRef } from './codeWorkspaceTypes'
import { resolveProviderConfig } from './resolveProviderConfig'
import { refreshResolvedProxyUrl } from '../ai/proxyFetch'
import { codeWorkspaceService } from './codeWorkspaceService'
import { mcpClientService } from '../mcpClientService'
import { buildReadOnlyMcpToolDescriptors } from './mcpToolPolicy'
import { skillManagerService } from '../skillManagerService'
import {
  fingerprintMcpToolSchemas,
  fingerprintSkills,
  getCachedMcpToolDescriptors,
  getCachedSkillSelection,
  setCachedMcpToolDescriptors,
  setCachedSkillSelection,
} from './runtimeCache'

export type AgentProfileMode = 'app' | 'wechat-bot'

const PROXY_REFRESH_TTL_MS = 30_000
let proxyRefreshPromise: Promise<string | null> | null = null
let proxyRefreshAt = 0

async function refreshProxyCached(): Promise<string | null> {
  const current = Date.now()
  if (proxyRefreshPromise && current - proxyRefreshAt < PROXY_REFRESH_TTL_MS) return proxyRefreshPromise
  proxyRefreshAt = current
  proxyRefreshPromise = refreshResolvedProxyUrl().catch(() => null)
  return proxyRefreshPromise
}

export interface AgentProfileRequest {
  mode: AgentProfileMode
  scope?: AgentScope
  modelConfig?: AgentProviderConfigOverride | null
  toolProfile?: AgentToolProfile
  codeWorkspace?: CodeWorkspaceRef | null
  ensureCodeWorkspace?: boolean
  includeMcpSkills?: boolean
  queryText?: string
}

export interface ResolvedAgentProfile {
  providerConfig: AgentProviderConfig
  scope: AgentScope
  toolProfile: AgentToolProfile
  codeWorkspace: CodeWorkspaceRef | null
  mcpTools: AgentMcpToolDescriptor[]
  skills: AgentSkillContextItem[]
  allowWechatReplyMedia: boolean
  logMeta: {
    readOnlyMcpToolCount: number
    selectedMcpTools: string[]
    selectedSkills: string[]
    mcpSelectionMode: 'all' | 'disabled'
    skillSelectionMode: 'selected' | 'disabled'
  }
}

export class AgentProfileService {
  async resolve(request: AgentProfileRequest): Promise<ResolvedAgentProfile> {
    await refreshProxyCached()
    const providerConfig = resolveProviderConfig(request.modelConfig)
    let codeWorkspace = request.codeWorkspace && typeof request.codeWorkspace.root === 'string'
      ? request.codeWorkspace
      : null

    if (request.ensureCodeWorkspace) {
      await codeWorkspaceService.ensureWorkspaceInitialized()
      codeWorkspace = codeWorkspaceService.getState().workspace
    }

    const toolProfile: AgentToolProfile = request.toolProfile === 'chat' || request.toolProfile === 'code' || request.toolProfile === 'hybrid'
      ? request.toolProfile
      : codeWorkspace ? 'hybrid' : 'chat'
    const includeMcpSkills = request.includeMcpSkills !== false
    const mcpTools = includeMcpSkills ? this.getReadOnlyMcpTools() : []
    const skills = includeMcpSkills ? this.selectSkills(request.queryText || '') : []

    return {
      providerConfig,
      scope: request.scope ?? { kind: 'global' },
      toolProfile,
      codeWorkspace,
      mcpTools,
      skills,
      allowWechatReplyMedia: request.mode === 'wechat-bot',
      logMeta: {
        readOnlyMcpToolCount: mcpTools.length,
        selectedMcpTools: mcpTools.map((tool) => `${tool.serverName}/${tool.toolName}`),
        selectedSkills: skills.map((skill) => skill.name),
        mcpSelectionMode: includeMcpSkills ? 'all' : 'disabled',
        skillSelectionMode: includeMcpSkills ? 'selected' : 'disabled',
      },
    }
  }

  private selectSkills(queryText: string): AgentSkillContextItem[] {
    const skillList = skillManagerService.listSkills()
    const version = fingerprintSkills(skillList)
    const cached = getCachedSkillSelection(queryText, version)
    if (cached) return cached
    const selected = skillManagerService.selectSkillsForAgentPrompt(queryText)
    setCachedSkillSelection(queryText, version, selected)
    return selected
  }

  private getReadOnlyMcpTools(): AgentMcpToolDescriptor[] {
    const connectedMcpToolSchemas = mcpClientService.getConnectedToolSchemas()
    const mcpToolVersion = fingerprintMcpToolSchemas(connectedMcpToolSchemas)
    let readOnlyMcpTools = getCachedMcpToolDescriptors(mcpToolVersion)
    if (!readOnlyMcpTools) {
      readOnlyMcpTools = buildReadOnlyMcpToolDescriptors(connectedMcpToolSchemas)
      setCachedMcpToolDescriptors(mcpToolVersion, readOnlyMcpTools)
    }
    return readOnlyMcpTools
  }
}

export const agentProfileService = new AgentProfileService()
