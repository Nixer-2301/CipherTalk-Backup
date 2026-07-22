/**
 * 克隆好友（数字分身）共享类型 —— 主进程与 AI 子进程都会引用，保持纯类型无副作用。
 */
import type { ModelMessage } from 'ai'
import type { AgentProviderConfig } from '../types'

/** 静态画像卡：LLM 从聊天语料中提炼的人设，组 system prompt 用。 */
export interface PersonaCard {
  /** 语气与说话风格描述（2-4 句） */
  tone: string
  /** 性格特征短语 */
  personalityTraits: string[]
  /** 口头禅 / 高频用语 */
  catchphrases: string[]
  /** 标点与排版习惯（如：不爱用句号、爱用~、连发短句） */
  punctuationStyle: string
  /** 对"我"的称呼习惯 */
  addressing: string
  /** 常聊话题 */
  topics: string[]
  /** 语音合成风格指令：播放克隆好友语音气泡时传给 TTS 模型。 */
  ttsInstructions: string
}

/** 黄金样本：从真实聊天里摘的问答对，replies 保留连发的逐条形态。 */
export interface PersonaFewShot {
  user: string
  replies: string[]
  /** 问句的前一轮话题（截断），接梗/回调类回复靠它还原语境；旧数据/黄金样本无此字段 */
  context?: string
}

/**
 * 深层画像：风格卡之外的"精髓层"，map-reduce 全量历史提炼。
 * 风格卡管"怎么说话"，这层管"是什么样的人、知道什么、遇事怎么反应"。
 */
export interface PersonaProfile {
  /** TA 的工作/家庭/生活事实（近况优先） */
  facts: string[]
  /** 你们关系的定位与相处模式（1-3 句） */
  relationship: string
  /** 「情境 → 典型反应」规则 */
  reactionPatterns: string[]
  /** 立场/雷点/回避话题/知识边界 */
  boundaries: string[]
  /** 你们的共同经历大事记 */
  sharedEvents: string[]
}

/** 真实问答对（检索式 few-shot 的索引单元）：「我」的一轮 → TA 的下一轮。 */
export interface PersonaPair {
  /** TA 回复轮的起始时间（秒），增量水位用 */
  time: number
  user: string
  replies: string[]
  /** user 的再前一轮（截断）：还原「接的是什么话」，旧数据无此字段 */
  context?: string
}

/**
 * TA 常用的一张表情包（克隆时从历史消息统计，私聊 + 群聊发言）。
 * contexts 是 TA 发这张表情前别人/自己说的话，给 LLM 判断这张表情的"语义"用。
 */
export interface PersonaSticker {
  md5: string
  cdnUrl: string
  productId?: string
  encryptUrl?: string
  aesKey?: string
  /** 历史上用过的次数 */
  count: number
  /** 使用情境示例（≤3 条短句） */
  contexts: string[]
}

/** 导演笔记：从克隆对话里反思出的纠正规则 + 分身自己的对话记忆。 */
export interface PersonaNotes {
  /** 用户对扮演的纠正/指示（必须遵守） */
  corrections: string[]
  /** 历次克隆对话的摘要（带日期），分身的 episodic memory */
  episodes: string[]
}

/** 本地统计出的风格指标（不经 LLM，组 prompt 时做长度/分条约束用）。 */
export interface PersonaStats {
  /** 参与分析的消息总数 */
  sourceMessageCount: number
  /** 其中对方（被克隆者）的消息数 */
  friendMessageCount: number
  /** 对方单条消息平均字数 */
  avgFriendMsgChars: number
  /** 对方平均一轮连发几条 */
  avgFriendBurst: number
  /** 对方语音消息占比（语音数 / (文本+语音)，含未转写语音）；旧记录无此值，重建后才有 */
  voiceRatio?: number
  /** 私聊语料不足时补充收集的群聊发言条数（仅喂风格卡/深层画像，不进问答对） */
  groupMessageCount?: number
  /** 群聊发言来自几个群 */
  groupSessionCount?: number
}

/** 数字分身绑定的专属 TTS 音色。密钥不落库，合成时读取全局服务商配置。 */
export interface PersonaTtsVoiceBinding {
  provider: 'volcengine' | 'xiaomi' | 'aliyun-qwen'
  protocol: 'volcengine-bidirectional' | 'xiaomi-mimo-tts' | 'aliyun-qwen-realtime'
  source: 'volcengine-voice-clone' | 'xiaomi-mimo-voice-clone' | 'aliyun-qwen-voice-clone'
  baseURL: string
  /** 豆包为 X-Api-Resource-Id；小米为 TTS voiceclone 模型 ID；通义为 target_model。 */
  model: string
  /** 豆包为 speaker_id；小米为本地样本 ID；通义为声音复刻返回的 voice。 */
  voice: string
  /** 使用端到端声音复刻接口时绑定的 App ID，用于防止跨 App 误用 Speaker。 */
  realtimeAppId?: string
  /** 端到端声音复刻资源，SC2.0 固定为 seed-icl-2.0。 */
  realtimeResourceId?: string
  displayName?: string
  sampleCount?: number
  sampleSeconds?: number
  sampleBytes?: number
  sampleMimeType?: string
  samplePath?: string
  sampleHash?: string
  modelType?: number
  fallbackMode?: boolean
  fallbackReason?: string
  createdAt: number
  updatedAt: number
}

export interface PersonaRecord {
  id: number
  accountId: string
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
  /** 深层画像；旧记录可能为 null（重建后才有） */
  profile: PersonaProfile | null
  /** TA 常用的表情包词典（旧记录为空数组，重建后才有） */
  stickers: PersonaSticker[]
  /** TA 的专属复刻音色；存在时分身语音优先使用它，不跟随全局当前 TTS 服务商。 */
  ttsVoice: PersonaTtsVoiceBinding | null
  /** 已蒸馏到的消息时间水位（createTime 秒），增量进化用 */
  corpusUntil: number
  modelProvider: string
  modelId: string
  createdAt: number
  updatedAt: number
}

/** 克隆角色：'friend' = 克隆好友（对方为被侧写者），'self' = 克隆我自己（"我"为被侧写者）。 */
export type PersonaRole = 'friend' | 'self'

/** 主进程 → AI 子进程的画像提取请求载荷。 */
export interface PersonaExtractInput {
  providerConfig: AgentProviderConfig
  /** 被克隆好友的显示名（保留旧字段名以减少改动；role='self' 时为 "我"） */
  friendName: string
  /** 克隆角色 */
  role: PersonaRole
  /** 被侧写者显示名（语料标签/prompt 主体用，friend=联系人名/self="我"） */
  subjectName: string
  /** 对话方显示名（语料标签用，friend="我"/self=联系人名） */
  otherName: string
  /** 渲染好的对话语料（轮次合并后，连发用 ／ 分隔） */
  corpusText: string
  /** 群聊补充语料（TA 在群里的发言节选）：只喂风格卡，不喂 few-shot 挖掘（群聊问答错位） */
  groupCorpusText?: string
  stats: PersonaStats
}

export interface PersonaExtractResult {
  card: PersonaCard
  fewShots: PersonaFewShot[]
}

/** 主进程 → AI 子进程：单块历史的深层画像提取（map 阶段）。 */
export interface PersonaProfileChunkInput {
  providerConfig: AgentProviderConfig
  friendName: string
  /** 克隆角色 */
  role: PersonaRole
  /** 被侧写者显示名 */
  subjectName: string
  /** 对话方显示名 */
  otherName: string
  chunkText: string
}

/** 主进程 → AI 子进程：多块部分画像合并（reduce 阶段）。 */
export interface PersonaProfileMergeInput {
  providerConfig: AgentProviderConfig
  friendName: string
  /** 克隆角色 */
  role: PersonaRole
  /** 被侧写者显示名 */
  subjectName: string
  /** 对话方显示名 */
  otherName: string
  parts: PersonaProfile[]
}

/** 主进程 → AI 子进程：增量修订（旧画像 + 新增真实聊天 → 修订后的画像）。 */
export interface PersonaReviseInput {
  providerConfig: AgentProviderConfig
  friendName: string
  card: PersonaCard
  profile: PersonaProfile | null
  /** 水位之后的新增对话语料 */
  newCorpusText: string
}

export interface PersonaReviseResult {
  card: PersonaCard
  profile: PersonaProfile
  /** 从新语料里挑的新黄金样本（追加用，可为空） */
  newFewShots: PersonaFewShot[]
}

/** 主进程 → AI 子进程：克隆对话反思（提炼纠正规则 + 对话摘要）。 */
export interface PersonaReflectInput {
  providerConfig: AgentProviderConfig
  friendName: string
  /** 渲染好的克隆对话文本（我 / 分身） */
  transcript: string
}

export interface PersonaReflectResult {
  corrections: string[]
  summary: string
}

/** 聊天引擎用到的画像子集（不带库表元数据）。 */
export interface PersonaChatPersona {
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
  profile?: PersonaProfile | null
  notes?: PersonaNotes
  /** TA 常用的表情包词典；模型按编号点播，引擎换成真实表情包气泡 */
  stickers?: PersonaSticker[]
  /** TA 的专属复刻音色；只影响语音气泡，不影响文本生成模型。 */
  ttsVoice?: PersonaTtsVoiceBinding | null
}

/** 主进程 → AI 子进程的克隆聊天请求载荷。 */
export interface PersonaChatInput {
  providerConfig: AgentProviderConfig
  persona: PersonaChatPersona
  messages: ModelMessage[]
  /** 输出场景：微信入口使用微信气泡分段标记，软件内聊天保持普通短消息文本。 */
  outputMode?: 'app' | 'wechat'
}

/** persona:buildProgress 推送事件。 */
export interface PersonaBuildProgress {
  sessionId: string
  stage: 'indexing' | 'corpus' | 'extracting' | 'saving' | 'done' | 'error'
  title: string
  percent: number
  detail?: string
}
