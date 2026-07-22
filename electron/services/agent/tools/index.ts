/**
 * 工具装配。按 scope 返回 ToolSet 给 ToolLoopAgent。
 * 工具职责与串联见文档 §7 / prompts.ts。summarize_period（按需摘要）后置。
 * buildBaseTools 为主 Agent 的基础读/查工具；buildSubAgentTools 为子 Agent 收窄后的读/查工具。
 * buildTools 在基础工具上加记忆工具、MCP 工具与 delegate_analysis（子 Agent，需 providerConfig）。
 */
import type { ToolSet, UIMessageChunk } from 'ai'
import type { AgentMcpToolDescriptor, AgentProviderConfig, AgentScope, AgentUploadedMediaContext } from '../types'
import type { AgentCanvasRunContext } from '../canvasTypes'
import type { CodeWorkspaceRef } from '../codeWorkspaceTypes'
import { withToolTimeouts } from '../guards'
import { listContacts } from './listContacts'
import { searchMessages } from './searchMessages'
import { semanticSearch } from './semanticSearch'
import { getContext } from './getContext'
import { getTimeline } from './getTimeline'
import { transcribeVoiceMessage } from './transcribeVoiceMessage'
import { chatStats } from './chatStats'
import { listGroups } from './listGroups'
import { groupMembers } from './groupMembers'
import { groupMemberRanking } from './groupMemberRanking'
import { querySql } from './querySql'
import { updatePlan } from './updatePlan'
import { searchMoments, momentsStats } from './moments'
import { createRemember, createRecall, createListMemories, createForget, createConsolidate } from './memory'
import { createDelegateAnalysis } from './delegateAnalysis'
import { buildMcpTools } from './mcpExternal'
import { generateImage } from './generateImage'
import { searchStickers, sendSticker } from './stickers'
import { sendRandomImage } from './sendRandomImage'
import { createInspectMediaImage, createSearchSimilarMedia, searchMedia, searchMomentMedia, sendMediaFromHistory } from './mediaHistory'
import { sendWechatFile } from './sendWechatFile'
import { personaControl } from './personaControl'
import { sendWechatMedia } from './wechatMedia'
import { createCanvasTools } from './canvas'
import { createCodeWorkspaceTools } from './codeWorkspace'
import { exportChat } from './exportChat'
import { createAgentCapabilityTools } from './capabilities'

/** 基础读/查工具（不含 delegate_analysis），主 Agent 与子 Agent 共用。 */
export function buildBaseTools(_scope: AgentScope): ToolSet {
  return {
    list_contacts: listContacts,
    search_messages: searchMessages,
    semantic_search: semanticSearch,
    get_context: getContext,
    get_timeline: getTimeline,
    transcribe_voice_message: transcribeVoiceMessage,
    chat_stats: chatStats,
    list_groups: listGroups,
    group_members: groupMembers,
    group_member_ranking: groupMemberRanking,
    search_moments: searchMoments,
    moments_stats: momentsStats,
    search_moment_media: searchMomentMedia,
    search_media: searchMedia,
    send_media_from_history: sendMediaFromHistory,
    send_random_image: sendRandomImage,
    query_sql: querySql,
    update_plan: updatePlan,
  }
}

/** 子 Agent 只保留干活需要的读/查/统计工具；不带 update_plan，避免委托任务里继续规划。 */
export function buildSubAgentTools(_scope: AgentScope): ToolSet {
  return {
    list_contacts: listContacts,
    search_messages: searchMessages,
    semantic_search: semanticSearch,
    get_context: getContext,
    get_timeline: getTimeline,
    transcribe_voice_message: transcribeVoiceMessage,
    chat_stats: chatStats,
    list_groups: listGroups,
    group_members: groupMembers,
    group_member_ranking: groupMemberRanking,
    search_moments: searchMoments,
    moments_stats: momentsStats,
    search_moment_media: searchMomentMedia,
    query_sql: querySql,
  }
}

/** 计划模式只保留轻量解析工具，避免计划轮直接读取/统计/总结用户数据。 */
export function buildPlanModeTools(_scope: AgentScope, codeWorkspace?: CodeWorkspaceRef | null): ToolSet {
  return {
    list_contacts: listContacts,
    list_groups: listGroups,
    ...createCodeWorkspaceTools(codeWorkspace, { readOnly: true }),
  }
}

export interface BuildChatToolsOptions {
  allowWechatReplyMedia?: boolean
  uploadedMediaContext?: AgentUploadedMediaContext
  /** 会话 Canvas 上下文；存在时挂载 canvas_* 工具（chat/hybrid profile）。 */
  canvasContext?: AgentCanvasRunContext
  /** 工具直发 UIMessageChunk 的出口（canvas 工具用它发 data-canvas 引用）。 */
  emitChunk?: (chunk: UIMessageChunk) => void
}

function createWechatReplyMediaTools(): ToolSet {
  return {
    search_stickers: searchStickers,
    send_sticker: sendSticker,
    send_random_image: sendRandomImage,
    send_wechat_media: sendWechatMedia,
    send_wechat_file: sendWechatFile,
  }
}

export function buildChatTools(
  scope: AgentScope,
  providerConfig: AgentProviderConfig,
  mcpTools: AgentMcpToolDescriptor[] = [],
  enableImageGen = false,
  options: BuildChatToolsOptions = {},
): ToolSet {
  return {
    ...buildBaseTools(scope),
    inspect_media_image: createInspectMediaImage(providerConfig),
    search_similar_media: createSearchSimilarMedia(options.uploadedMediaContext),
    ...createAgentCapabilityTools(),
    ...createCanvasTools(options.canvasContext, options.emitChunk),
    ...buildMcpTools(mcpTools),
    ...(enableImageGen ? { generate_image: generateImage } : {}),
    ...(options.allowWechatReplyMedia ? createWechatReplyMediaTools() : {}),
    export_chat: exportChat,
    persona_control: personaControl,
    remember: createRemember(scope),
    recall: createRecall(scope),
    list_memories: createListMemories(scope),
    forget: createForget(),
    consolidate_memory: createConsolidate(),
    delegate_analysis: createDelegateAnalysis({
      providerConfig,
      scope,
      // 子 Agent 工具也套超时；用收窄工具集避免再次委托/规划/写记忆
      buildSubTools: () => withToolTimeouts(buildSubAgentTools(scope)),
    }),
  }
}

export function buildCodeOnlyTools(
  codeWorkspace: CodeWorkspaceRef | null | undefined,
  enableImageGen = false,
): ToolSet {
  return {
    ...createCodeWorkspaceTools(codeWorkspace),
    ...(enableImageGen ? { generate_image: generateImage } : {}),
  }
}

export function buildTools(
  scope: AgentScope,
  providerConfig: AgentProviderConfig,
  mcpTools: AgentMcpToolDescriptor[] = [],
  enableImageGen = false,
  codeWorkspace?: CodeWorkspaceRef | null,
  options: BuildChatToolsOptions = {},
): ToolSet {
  return {
    ...buildChatTools(scope, providerConfig, mcpTools, enableImageGen, options),
    ...createCodeWorkspaceTools(codeWorkspace),
  }
}
