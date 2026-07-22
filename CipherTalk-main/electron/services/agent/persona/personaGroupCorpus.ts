/**
 * 群聊补充语料（主进程）—— 私聊语料不足时，从 TA 所在群聊里收集 TA 的发言补充克隆语料。
 *
 * 用途分级（关键约束）：
 * - 风格卡 / 深层画像：可以吃群聊发言（风格提取只需要"TA 说过的话"，不依赖对话结构）；
 * - few-shot 问答对：绝不吃群聊（群里 TA 的回复多半在接别人的话茬，硬配对会产生错位问答，
 *   污染检索式 few-shot，比语料少更糟）——所以本模块只产出语料文本，不产出 PersonaPair。
 *
 * 流程：chatroom_member 反查 TA 所在群 → 按群活跃度排序 → 限量索引每个群的消息 →
 * 过滤出 TA 的发言并合并连发 → 渲染成「群友: 上文 / TA: 发言」的节选文本。
 */
import type { ChatSearchMemoryMessage } from '../../search/chatSearchIndexService'
import { BURST_JOINER, MSG_CHAR_CAP, PROFILE_CHUNK_CHARS, TURN_GAP_SECONDS, messageText } from './personaCorpus'
import { collectStickers, mergeStickers } from './personaStickers'
import type { PersonaSticker } from './personaTypes'

const MAX_GROUPS = 8                 // 最多扫描的群数（按最近活跃排序取前 N）
const PER_GROUP_INDEX_CAP = 1500     // 单个群最多索引的消息数（控制懒索引成本）
const TARGET_FRIEND_MESSAGES = 600   // 收集到这么多条 TA 的发言就提前收手
const CONTEXT_GAP_SECONDS = 10 * 60  // 上文有效窗口：TA 发言前这么久内的群友消息才算上文
const CONTEXT_CHAR_CAP = 80          // 上文行字符上限（上文只是辅助理解，不用全文）
const CORPUS_CHAR_BUDGET = 8000      // 给风格卡的补充语料预算（最近的发言优先）
const MAX_PROFILE_CHUNKS = 4         // 群聊画像块上限（私聊块优先占额度）

/** 每个群聊画像块的开头标记：告诉 LLM 这是群聊节选，别把群友当成「我」。 */
function chunkMarker(friendName: string): string {
  return `（以下为「${friendName}」在群聊中的发言节选；「群友」是群里其他人，不是「我」，「我」不一定在场，请只提取关于「${friendName}」本人的信息）`
}

export interface PersonaGroupCorpus {
  /** 给风格卡的补充语料（含群友上文行，按时间正序、预算内最近优先） */
  corpusText: string
  /** 给深层画像 map 阶段的块（每块带来源标记） */
  profileChunks: string[]
  /** 收集到的 TA 群聊发言条数 */
  friendMessageCount: number
  /** 实际取到发言的群数 */
  groupCount: number
  /** TA 在群里发过的表情包统计（与私聊统计合并后入词典） */
  stickers: PersonaSticker[]
}

/** TA 在群里的一轮连发 + 可选的上文（群友或「我」说的）。 */
interface GroupSnippet {
  startTime: number
  contextLabel: string
  contextText: string
  friendTexts: string[]
}

function normalizeId(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

/** 反查 TA 所在的群，按会话最近活跃降序。读原微信库（经 wcdb 代理）。 */
async function findFriendGroups(friendWxid: string): Promise<string[]> {
  const { dbAdapter } = await import('../../dbAdapter')
  const memberRows = await dbAdapter.all<{ username: string }>(
    'contact',
    '',
    `SELECT n2.username AS username
     FROM chatroom_member m
     JOIN name2id n2 ON m.room_id = n2.rowid
     WHERE m.member_id = (SELECT rowid FROM name2id WHERE username = ?)`,
    [friendWxid],
  )
  const memberOf = new Set(memberRows.map((r) => normalizeId(r.username)).filter(Boolean))
  if (memberOf.size === 0) return []

  const sessionRows = await dbAdapter.all<{ username: string; ts: number }>(
    'session',
    '',
    `SELECT username, COALESCE(sort_timestamp, last_timestamp, 0) AS ts
     FROM SessionTable
     WHERE username LIKE '%@chatroom'
     ORDER BY ts DESC`,
    [],
  )
  return sessionRows
    .filter((r) => memberOf.has(normalizeId(r.username)))
    .map((r) => r.username)
}

/** 从单个群的消息里抽出 TA 的连发轮次（带群友上文）。 */
function extractGroupSnippets(messages: ChatSearchMemoryMessage[], friendWxid: string): GroupSnippet[] {
  const friendKey = normalizeId(friendWxid)
  const snippets: GroupSnippet[] = []
  let lastOtherLabel = ''
  let lastOtherText = ''
  let lastOtherTime = 0
  let prevFriendTime = 0

  for (const m of messages) {
    const text = messageText(m)
    if (!text) continue
    if (m.isSend !== 1 && normalizeId(m.senderUsername) === friendKey) {
      const last = snippets[snippets.length - 1]
      if (last && m.createTime - prevFriendTime <= TURN_GAP_SECONDS) {
        last.friendTexts.push(text.slice(0, MSG_CHAR_CAP))
      } else {
        const hasContext = lastOtherText && m.createTime - lastOtherTime <= CONTEXT_GAP_SECONDS
        snippets.push({
          startTime: m.createTime,
          contextLabel: hasContext ? lastOtherLabel : '',
          contextText: hasContext ? lastOtherText.slice(0, CONTEXT_CHAR_CAP) : '',
          friendTexts: [text.slice(0, MSG_CHAR_CAP)],
        })
      }
      prevFriendTime = m.createTime
    } else {
      lastOtherLabel = m.isSend === 1 ? '我' : '群友'
      lastOtherText = text
      lastOtherTime = m.createTime
    }
  }
  return snippets
}

function renderSnippet(snippet: GroupSnippet, friendName: string): string {
  const lines: string[] = []
  if (snippet.contextText) lines.push(`${snippet.contextLabel}: ${snippet.contextText}`)
  lines.push(`${friendName}: ${snippet.friendTexts.join(BURST_JOINER)}`)
  return lines.join('\n')
}

/** 风格卡补充语料：全部节选按时间正序，从最新往回装满预算。 */
function renderCorpusText(snippets: GroupSnippet[], friendName: string): string {
  const blocks: string[] = []
  let used = 0
  for (let i = snippets.length - 1; i >= 0; i -= 1) {
    const block = renderSnippet(snippets[i], friendName)
    if (used + block.length > CORPUS_CHAR_BUDGET && blocks.length > 0) break
    blocks.push(block)
    used += block.length
  }
  return blocks.reverse().join('\n')
}

/** 深层画像块：节选按时间正序切块，每块带来源标记；超限保留最近的块。 */
function renderGroupProfileChunks(snippets: GroupSnippet[], friendName: string): string[] {
  const marker = chunkMarker(friendName)
  const chunks: string[] = []
  let current: string[] = [marker]
  let chars = marker.length
  for (const snippet of snippets) {
    const block = renderSnippet(snippet, friendName)
    if (chars + block.length > PROFILE_CHUNK_CHARS && current.length > 1) {
      chunks.push(current.join('\n'))
      current = [marker]
      chars = marker.length
    }
    current.push(block)
    chars += block.length
  }
  if (current.length > 1) chunks.push(current.join('\n'))
  return chunks.slice(-MAX_PROFILE_CHUNKS)
}

/**
 * 收集 TA 的群聊发言语料。单个群失败跳过不致命；没有可用群时返回零计数对象。
 * friendWxid 即私聊 sessionId（私聊会话 ID 就是好友 wxid）。
 */
export async function collectGroupCorpus(
  friendWxid: string,
  friendName: string,
  onProgress?: (detail: string) => void,
): Promise<PersonaGroupCorpus> {
  const empty: PersonaGroupCorpus = { corpusText: '', profileChunks: [], friendMessageCount: 0, groupCount: 0, stickers: [] }
  const groups = await findFriendGroups(friendWxid)
  if (groups.length === 0) return empty

  const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
  const friendKey = normalizeId(friendWxid)
  const allSnippets: GroupSnippet[] = []
  let stickers: PersonaSticker[] = []
  let friendMessageCount = 0
  let groupCount = 0

  for (const groupId of groups.slice(0, MAX_GROUPS)) {
    if (friendMessageCount >= TARGET_FRIEND_MESSAGES) break
    try {
      onProgress?.(`正在读取群聊 ${groupCount + 1}（已收集 ${friendMessageCount} 条发言）`)
      const messages = await chatSearchIndexService.listSessionMemoryMessages(groupId, undefined, PER_GROUP_INDEX_CAP)
      stickers = mergeStickers(
        stickers,
        collectStickers(messages, (m) => m.isSend !== 1 && normalizeId(m.senderUsername) === friendKey),
      )
      const snippets = extractGroupSnippets(messages, friendWxid)
      if (snippets.length === 0) continue
      groupCount += 1
      for (const s of snippets) friendMessageCount += s.friendTexts.length
      allSnippets.push(...snippets)
    } catch {
      /* 单个群索引/读取失败跳过 */
    }
  }
  if (allSnippets.length === 0) return { ...empty, stickers }

  allSnippets.sort((a, b) => a.startTime - b.startTime)
  return {
    corpusText: renderCorpusText(allSnippets, friendName),
    profileChunks: renderGroupProfileChunks(allSnippets, friendName),
    friendMessageCount,
    groupCount,
    stickers,
  }
}
