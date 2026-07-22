/**
 * 表情包词典（主进程，纯计算无 LLM）—— 克隆时从历史消息统计 TA 常用的表情包。
 *
 * 语义难题的低成本解法：表情包是图、模型看不到内容，但 TA 发某张表情前别人/自己
 * 说的话就是这张表情的"使用情境"。把情境短句存进词典、连同使用次数列进提示词，
 * 让模型自己按编号点播（[表情:N]），语义判断交给模型而不是本地做模糊匹配。
 */
import { parseEmojiInfo } from '../../chat/contentParsers'
import type { ChatSearchMemoryMessage } from '../../search/chatSearchIndexService'
import { messageText } from './personaCorpus'
import type { PersonaSticker } from './personaTypes'

/** 词典容量：进提示词的表情包上限（每张占 1-2 行，太多反而稀释注意力） */
export const MAX_STICKERS = 8
const MAX_CONTEXTS = 3          // 每张表情保留的使用情境条数
const CONTEXT_CHAR_CAP = 30     // 情境短句字符上限
const EMOJI_LOCAL_TYPE = 47

function extractAttr(content: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(content)
  return match ? match[1].replace(/&amp;/g, '&') : undefined
}

/**
 * 从一段消息里统计某人发过的表情包（messages 需按时间正序）。
 * isFriendMessage 由调用方给：私聊是 isSend !== 1，群聊是 sender 等于 TA 的 wxid。
 */
export function collectStickers(
  messages: ChatSearchMemoryMessage[],
  isFriendMessage: (m: ChatSearchMemoryMessage) => boolean,
): PersonaSticker[] {
  const byKey = new Map<string, PersonaSticker>()
  let lastText = ''

  for (const m of messages) {
    if (m.localType === EMOJI_LOCAL_TYPE && isFriendMessage(m)) {
      const info = parseEmojiInfo(m.rawContent)
      const key = info.md5 || info.cdnUrl
      if (!key || (!info.cdnUrl && !info.md5)) continue
      let sticker = byKey.get(key)
      if (!sticker) {
        sticker = {
          md5: info.md5 || '',
          cdnUrl: info.cdnUrl || '',
          productId: info.productId,
          encryptUrl: extractAttr(m.rawContent, 'encrypturl'),
          aesKey: extractAttr(m.rawContent, 'aeskey'),
          count: 0,
          contexts: [],
        }
        byKey.set(key, sticker)
      }
      sticker.count += 1
      const context = lastText.slice(0, CONTEXT_CHAR_CAP)
      if (context && sticker.contexts.length < MAX_CONTEXTS && !sticker.contexts.includes(context)) {
        sticker.contexts.push(context)
      }
      continue
    }
    const text = messageText(m)
    if (text) lastText = text
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, MAX_STICKERS)
}

/** 合并多处来源（私聊 + 各群）的统计：按 md5/cdnUrl 累加次数、情境去重，重新取 top。 */
export function mergeStickers(...sources: PersonaSticker[][]): PersonaSticker[] {
  const byKey = new Map<string, PersonaSticker>()
  for (const source of sources) {
    for (const s of source) {
      const key = s.md5 || s.cdnUrl
      if (!key) continue
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...s, contexts: [...s.contexts] })
        continue
      }
      existing.count += s.count
      existing.cdnUrl = existing.cdnUrl || s.cdnUrl
      existing.encryptUrl = existing.encryptUrl || s.encryptUrl
      existing.aesKey = existing.aesKey || s.aesKey
      existing.productId = existing.productId || s.productId
      for (const c of s.contexts) {
        if (existing.contexts.length >= MAX_CONTEXTS) break
        if (!existing.contexts.includes(c)) existing.contexts.push(c)
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, MAX_STICKERS)
}
