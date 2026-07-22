import type { UIMessage } from 'ai'

export type PromptOptimizeContextMessage = {
  role: 'user' | 'assistant'
  text: string
}

export const PROMPT_OPTIMIZE_CONTEXT_ROUNDS = 2
export const PROMPT_OPTIMIZE_CONTEXT_MESSAGE_MAX_CHARS = 1000

function textOnly(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return ''
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

/** 最近两轮完整问答；忽略工具、推理、附件以及末尾尚未得到回复的用户消息。 */
export function buildPromptOptimizeContext(
  messages: UIMessage[],
  maxRounds = PROMPT_OPTIMIZE_CONTEXT_ROUNDS,
): PromptOptimizeContextMessage[] {
  const rounds: PromptOptimizeContextMessage[][] = []
  let userMessage: PromptOptimizeContextMessage | null = null
  let assistantTexts: string[] = []

  const commitRound = () => {
    if (!userMessage || assistantTexts.length === 0) return
    rounds.push([
      userMessage,
      { role: 'assistant', text: assistantTexts.join('\n\n') },
    ])
  }

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOnly(message)
    if (!text) continue

    if (message.role === 'user') {
      commitRound()
      userMessage = { role: 'user', text }
      assistantTexts = []
      continue
    }

    if (userMessage) assistantTexts.push(text)
  }
  commitRound()

  const roundLimit = Math.max(0, Math.floor(maxRounds))
  if (roundLimit === 0) return []
  return rounds
    .slice(-roundLimit)
    .flat()
    .map((message) => ({
      ...message,
      text: message.text.slice(0, PROMPT_OPTIMIZE_CONTEXT_MESSAGE_MAX_CHARS),
    }))
}
