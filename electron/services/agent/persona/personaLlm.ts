/**
 * 画像提取的 LLM 调用 —— 跑在 AI utilityProcess 子进程内（同 engine.ts，'ai' 依赖已 asarUnpack）。
 * 两路并行：① 画像卡（侧写）② 黄金样本（few-shot 问答对）。
 *
 * 不用 generateObject：openai-compatible 系供应商（deepseek/智谱/ollama 等）常把 JSON
 * 包进 ```json 围栏或带前后缀文字，SDK 严格解析会报 "No object generated"。
 * 改为 generateText + 宽松抽取 JSON + zod 校验，失败自动重试一次。
 */
import { generateText } from 'ai'
import { z } from 'zod'
import { createLanguageModel } from '../provider'
import type { PersonaExtractInput, PersonaExtractResult } from './personaTypes'

const stringArray = z.array(z.coerce.string()).catch([])

const personaCardSchema = z.object({
  tone: z.coerce.string().default(''),
  personalityTraits: stringArray.default([]),
  catchphrases: stringArray.default([]),
  punctuationStyle: z.coerce.string().default(''),
  addressing: z.coerce.string().default(''),
  topics: stringArray.default([]),
  ttsInstructions: z.coerce.string().default(''),
})

// replies 兼容模型偷懒返回单个字符串的情况
const fewShotSchema = z.object({
  examples: z.array(z.object({
    user: z.coerce.string(),
    replies: z.union([z.coerce.string(), z.array(z.coerce.string())])
      .transform((v) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean)),
  })).catch([]),
})

/** 从模型输出里宽松抠出 JSON：剥 ``` 围栏，再取首个 { 到末个 } 之间。 */
function extractJson(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t)
}

/** generateText + 宽松解析 + zod 校验；解析失败重试一次，再失败抛带原始输出片段的错误。 */
export async function generateValidated<T>(
  opts: { model: ReturnType<typeof createLanguageModel>; instructions: string; prompt: string; temperature: number; signal?: AbortSignal },
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  let lastRaw = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generateText({
      model: opts.model,
      instructions: opts.instructions,
      prompt: attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\n注意：上一次输出无法解析为 JSON，请严格只输出一个合法 JSON 对象，不要任何解释、前后缀或代码围栏。`,
      temperature: opts.temperature,
      abortSignal: opts.signal,
      telemetry: { functionId: `persona-${label}` },
    })
    lastRaw = result.text
    try {
      return schema.parse(extractJson(result.text))
    } catch {
      /* 重试一次 */
    }
  }
  throw new Error(`${label}解析失败，模型输出不是合法 JSON：${lastRaw.slice(0, 200)}`)
}

function corpusPreamble(input: PersonaExtractInput): string {
  const { subjectName, otherName, stats } = input
  return [
    `下面是「${otherName}」和「${subjectName}」的微信聊天记录（按时间正序，一行一轮；同一人连发多条时用「／」分隔）。`,
    `已知统计：${subjectName} 共 ${stats.friendMessageCount} 条消息，单条平均 ${stats.avgFriendMsgChars} 字，平均一轮连发 ${stats.avgFriendBurst} 条。`,
    '',
    input.corpusText,
  ].join('\n')
}

/** 风格卡专用：私聊语料 + 群聊发言节选（few-shot 挖掘不用这份——群聊问答是错位的）。 */
function cardCorpus(input: PersonaExtractInput): string {
  const base = corpusPreamble(input)
  if (!input.groupCorpusText) return base
  return [
    base,
    '',
    `【补充语料】以下是「${input.subjectName}」在群聊中的发言节选（共 ${input.stats.groupMessageCount || 0} 条，来自 TA 所在的群）。`,
    `「群友」是群里其他人，不是「${input.otherName}」；这部分只用于分析「${input.subjectName}」的说话风格与性格，注意群聊语气可能比私聊更随意。`,
    input.groupCorpusText,
  ].join('\n')
}

/** 画像卡 JSON 形状；addressing 里要称呼的"聊天对象"在 self 克隆时是联系人，不是"我"。 */
function cardJsonShape(otherName: string): string {
  return `{
  "tone": "语气与说话风格，2-4 句中文描述",
  "personalityTraits": ["性格特征短语", "..."],
  "catchphrases": ["口头禅/高频用语，没有就给空数组"],
  "punctuationStyle": "标点与排版习惯，如：几乎不用句号、爱用~和省略号、习惯连发短句",
  "addressing": "对聊天对象（语料中的「${otherName}」）的称呼习惯，没有特别称呼就写'无特别称呼'",
  "topics": ["常聊话题", "..."],
  "ttsInstructions": "给语音合成模型的自然语言指令，描述 TA 说语音时的语速、情绪、口语感、停顿和语气；不要包含具体要朗读的文本"
}`
}

/** few-shot 问答对形状：user=对话方说的，replies=被侧写者回的。 */
function fewshotJsonShape(otherName: string, subjectName: string): string {
  return `{
  "examples": [
    { "user": "「${otherName}」说的内容（一轮内多条可合并成一句）", "replies": ["${subjectName === '我' ? '我' : '对方'}的回复，连发的保持逐条、一条一项，必须摘自原文"] }
  ]
}`
}

export async function extractPersona(input: PersonaExtractInput, signal?: AbortSignal): Promise<PersonaExtractResult> {
  const model = createLanguageModel(input.providerConfig)
  const corpus = corpusPreamble(input)
  const { subjectName, otherName } = input

  const [card, fewShot] = await Promise.all([
    generateValidated(
      {
        model,
        instructions:
          '你是一名语言风格侧写师。根据聊天记录总结目标人物的说话风格与性格，' +
          '只依据记录本身，不要臆造；描述要具体可执行（能直接指导模仿其说话），避免空泛形容词。' +
          `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${cardJsonShape(otherName)}`,
        prompt: `${cardCorpus(input)}\n\n请侧写「${subjectName}」，按要求输出 JSON。`,
        temperature: 0.3,
        signal,
      },
      personaCardSchema,
      '画像',
    ),
    generateValidated(
      {
        model,
        instructions:
          '你是对话样本挖掘器。从聊天记录中挑选最能体现目标人物说话风格的真实问答对：' +
          `「${otherName}」说了什么、「${subjectName}」怎么回的。必须原样摘抄原文（可去掉无关上下文），不许改写、不许编造。` +
          '优先挑风格鲜明（口头禅、玩笑、典型语气）且不含隐私敏感内容（金额、地址、证件号）的样本。' +
          `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${fewshotJsonShape(otherName, subjectName)}`,
        prompt: `${corpus}\n\n请从中挑选 5-8 组「${otherName} → ${subjectName}」的代表性问答对，按要求输出 JSON。`,
        temperature: 0.2,
        signal,
      },
      fewShotSchema,
      '对话样本',
    ),
  ])

  return {
    card: {
      tone: card.tone,
      personalityTraits: card.personalityTraits,
      catchphrases: card.catchphrases,
      punctuationStyle: card.punctuationStyle,
      addressing: card.addressing,
      topics: card.topics,
      ttsInstructions: card.ttsInstructions,
    },
    fewShots: fewShot.examples.filter((e) => e.user && e.replies.length > 0).slice(0, 10),
  }
}
