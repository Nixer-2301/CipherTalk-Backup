/**
 * 深层画像与自动进化的 LLM 调用 —— 跑在 AI utilityProcess 子进程（同 personaLlm.ts）。
 * - extractProfileChunk / mergeProfileParts：map-reduce 全量历史提炼"精髓层"（事实/关系/反应模式/边界/共同经历）；
 * - revisePersona：增量进化，旧画像 + 新增真实聊天 → 修订后的画像（人近况变了、新梗出现都能跟上）；
 * - reflectConversation：克隆对话反思，提炼用户纠正（导演笔记）+ 对话摘要（episodic memory）。
 * 复用 personaLlm 的 generateValidated（宽松 JSON 抽取 + zod 校验 + 失败重试一次）。
 */
import { z } from 'zod'
import { createLanguageModel } from '../provider'
import { generateValidated } from './personaLlm'
import type {
  PersonaProfile,
  PersonaProfileChunkInput,
  PersonaProfileMergeInput,
  PersonaReflectInput,
  PersonaReflectResult,
  PersonaReviseInput,
  PersonaReviseResult,
} from './personaTypes'

const stringArray = z.array(z.coerce.string()).catch([])

const profileSchema = z.object({
  facts: stringArray.default([]),
  relationship: z.coerce.string().default(''),
  reactionPatterns: stringArray.default([]),
  boundaries: stringArray.default([]),
  sharedEvents: stringArray.default([]),
})

// 注入 prompt 的体积上限：合并后各维度封顶
const PROFILE_CAPS: Record<keyof Omit<PersonaProfile, 'relationship'>, number> = {
  facts: 15,
  reactionPatterns: 10,
  boundaries: 8,
  sharedEvents: 10,
}

/** 深层画像 JSON 形状；代词与关系措辞随角色变化（friend=TA/你们，self=本人/我们与对方）。 */
function profileJsonShape(role: 'friend' | 'self', subjectName: string, otherName: string): string {
  const pronoun = role === 'self' ? '本人' : 'TA'
  const relSubject = role === 'self' ? `「${subjectName}」（本人）与「${otherName}」` : '你们'
  const reactTrigger = role === 'self' ? `「${otherName}」` : '对方'
  return `{
  "facts": ["${pronoun}的工作/家庭/生活事实，一条一项，具体（如'在杭州做后端开发''养了只叫咪咪的猫'）"],
  "relationship": "${relSubject}关系的定位与相处模式，1-3 句（如'大学室友，互损但有事真上'）",
  "reactionPatterns": ["「情境 → 典型反应」规则（如'${reactTrigger}抱怨工作时，先调侃两句再认真安慰'）"],
  "boundaries": ["${pronoun}的立场/雷点/回避的话题/明显不了解的领域"],
  "sharedEvents": ["${relSubject}的共同经历大事记，带大致时间（如'2024 年夏天一起去了青岛'）"]
}`
}

function capProfile(profile: PersonaProfile): PersonaProfile {
  return {
    facts: profile.facts.slice(0, PROFILE_CAPS.facts),
    relationship: profile.relationship,
    reactionPatterns: profile.reactionPatterns.slice(0, PROFILE_CAPS.reactionPatterns),
    boundaries: profile.boundaries.slice(0, PROFILE_CAPS.boundaries),
    sharedEvents: profile.sharedEvents.slice(0, PROFILE_CAPS.sharedEvents),
  }
}

/** map 阶段：从一块历史对话中提取部分深层画像。 */
export async function extractProfileChunk(input: PersonaProfileChunkInput, signal?: AbortSignal): Promise<PersonaProfile> {
  const { subjectName, otherName, role } = input
  const result = await generateValidated(
    {
      model: createLanguageModel(input.providerConfig),
      instructions:
        `你是人物侧写师。下面是「${otherName}」和「${subjectName}」的一段微信聊天记录（一行一轮，连发用「／」分隔）。` +
        `从中提取关于「${subjectName}」这个人的深层信息：生活事实、${role === 'self' ? `本人与「${otherName}」` : '你们'}的关系、${role === 'self' ? '本人' : 'TA'}在不同情境下的典型反应、立场与边界、共同经历。` +
        '只依据记录本身，不要臆造；没有依据的维度给空数组/空字符串。' +
        `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${profileJsonShape(role, subjectName, otherName)}`,
      prompt: input.chunkText,
      temperature: 0.2,
      signal,
    },
    profileSchema,
    '深层画像分块',
  )
  return result
}

/** reduce 阶段：合并多块部分画像（去重、近况优先、压缩到上限）。 */
export async function mergeProfileParts(input: PersonaProfileMergeInput, signal?: AbortSignal): Promise<PersonaProfile> {
  if (input.parts.length === 0) {
    return { facts: [], relationship: '', reactionPatterns: [], boundaries: [], sharedEvents: [] }
  }
  if (input.parts.length === 1) return capProfile(input.parts[0])

  const { subjectName, otherName, role } = input
  const result = await generateValidated(
    {
      model: createLanguageModel(input.providerConfig),
      instructions:
        `下面是从「${otherName}」和「${subjectName}」不同时间段的聊天里分别提取的多份部分画像（按时间正序，越靠后越新）。` +
        '请合并成一份：去重、矛盾时以更新的为准（如换了工作以新工作为准）、同类信息压缩合并；' +
        `facts 不超过 ${PROFILE_CAPS.facts} 条、reactionPatterns 不超过 ${PROFILE_CAPS.reactionPatterns} 条、` +
        `boundaries 不超过 ${PROFILE_CAPS.boundaries} 条、sharedEvents 不超过 ${PROFILE_CAPS.sharedEvents} 条。` +
        `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${profileJsonShape(role, subjectName, otherName)}`,
      prompt: input.parts.map((p, i) => `【第 ${i + 1} 份】\n${JSON.stringify(p, null, 1)}`).join('\n\n'),
      temperature: 0.2,
      signal,
    },
    profileSchema,
    '深层画像合并',
  )
  return capProfile(result)
}

const fewShotItemSchema = z.object({
  user: z.coerce.string(),
  replies: z.union([z.coerce.string(), z.array(z.coerce.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean)),
})

const reviseSchema = z.object({
  card: z.object({
    tone: z.coerce.string().default(''),
    personalityTraits: stringArray.default([]),
    catchphrases: stringArray.default([]),
    punctuationStyle: z.coerce.string().default(''),
    addressing: z.coerce.string().default(''),
    topics: stringArray.default([]),
    ttsInstructions: z.coerce.string().default(''),
  }),
  profile: profileSchema,
  newFewShots: z.array(fewShotItemSchema).catch([]),
})

/** 增量进化：旧画像 + 新增真实聊天 → 修订后的画像卡 + 深层画像 + 新黄金样本。好友画像专用。 */
export async function revisePersona(input: PersonaReviseInput, signal?: AbortSignal): Promise<PersonaReviseResult> {
  const emptyProfile: PersonaProfile = { facts: [], relationship: '', reactionPatterns: [], boundaries: [], sharedEvents: [] }
  const profileShape = profileJsonShape('friend', input.friendName, '我')
  const result = await generateValidated(
    {
      model: createLanguageModel(input.providerConfig),
      instructions:
        `你负责更新「${input.friendName}」的人物画像。给你 TA 的旧画像（说话风格卡 + 深层画像）和这之后新增的真实聊天记录。` +
        '请输出修订后的完整画像：风格没变就保留原描述，变了就更新；新事实/新近况/新梗补进深层画像，过时的（如已结束的状态）修正；' +
        'card.ttsInstructions 是给语音合成模型的自然语言指令，用来描述 TA 说语音时的语速、情绪、口语感、停顿和语气，不要包含具体要朗读的文本；' +
        '再从新聊天里挑 0-3 组最能体现 TA 说话风格的真实问答对（必须原样摘抄，没有就给空数组）。' +
        '\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式：' +
        '\n{ "card": {tone, personalityTraits, catchphrases, punctuationStyle, addressing, topics, ttsInstructions}, ' +
        `"profile": ${profileShape}, ` +
        '"newFewShots": [{ "user": "我说的", "replies": ["TA 回的，连发逐条"] }] }',
      prompt: [
        '【旧的说话风格卡】',
        JSON.stringify(input.card, null, 1),
        '',
        '【旧的深层画像】',
        JSON.stringify(input.profile || emptyProfile, null, 1),
        '',
        `【这之后新增的聊天记录】（一行一轮，「我」和「${input.friendName}」，连发用「／」分隔）`,
        input.newCorpusText,
      ].join('\n'),
      temperature: 0.3,
      signal,
    },
    reviseSchema,
    '画像修订',
  )
  return {
    card: result.card,
    profile: capProfile(result.profile),
    newFewShots: result.newFewShots.filter((e) => e.user && e.replies.length > 0).slice(0, 3),
  }
}

const reflectSchema = z.object({
  corrections: stringArray.default([]),
  summary: z.coerce.string().default(''),
})

/** 克隆对话反思：提炼用户对扮演的纠正（导演笔记）+ 这段对话的摘要。 */
export async function reflectConversation(input: PersonaReflectInput, signal?: AbortSignal): Promise<PersonaReflectResult> {
  const result = await generateValidated(
    {
      model: createLanguageModel(input.providerConfig),
      instructions:
        `下面是「我」和一个模仿「${input.friendName}」的 AI 分身的对话记录。请做两件事：` +
        `\n1. corrections：找出「我」对分身扮演效果的纠正、不满或指示（如"他才不会这么说""你太客气了""他喊我老张不是张哥"），` +
        '改写成指导下次扮演的通用规则，一条一项；没有就给空数组。只收与"怎么扮演"有关的，普通聊天内容不算。' +
        '\n2. summary：用 1-2 句概括这段对话聊了什么（给分身下次当作"我们之前聊过"的记忆）。' +
        '\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式：{ "corrections": ["规则"], "summary": "摘要" }',
      prompt: input.transcript,
      temperature: 0.2,
      signal,
    },
    reflectSchema,
    '对话反思',
  )
  return {
    corrections: result.corrections.map((c) => c.trim()).filter(Boolean).slice(0, 5),
    summary: result.summary.trim(),
  }
}
