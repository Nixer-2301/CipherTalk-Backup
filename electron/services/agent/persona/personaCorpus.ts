/**
 * 画像语料构建（主进程，纯计算无 LLM）。
 *
 * 微信对话不是一问一答：同一人经常连发多条，必须先把连续消息合并成「轮次」，
 * 否则统计失真、few-shot 问答对全是错位的。这里负责：
 * 1. 过滤可用文本消息（文本 + 已转写语音）；
 * 2. 轮次合并（同一发言人、间隔 ≤ TURN_GAP_SECONDS 归一轮）；
 * 3. 统计风格指标（平均字数 / 平均连发条数）；
 * 4. 渲染成给 LLM 的对话文本（最近优先，按字符预算截断）。
 */
import type { ChatSearchMemoryMessage } from '../../search/chatSearchIndexService'
import { voiceTranscribeService } from '../../voiceTranscribeService'
import type { PersonaPair, PersonaStats } from './personaTypes'

/** 对方可用文本消息低于此数时拒绝克隆（语料太少画像必然失真） */
export const MIN_FRIEND_MESSAGES = 50

export const TURN_GAP_SECONDS = 3 * 60   // 同一人相邻消息间隔超过此值视为新一轮
export const MSG_CHAR_CAP = 200          // 单条消息进语料的字符上限（防超长消息撑爆）
const CORPUS_CHAR_BUDGET = 14000  // 渲染语料的总字符预算（最近的轮次优先）
const CORPUS_RECENT_BUDGET = 10000 // 其中留给最近连续对话的部分，其余从更早历史均匀抽样（近期没怎么聊时人格兜底）
export const BURST_JOINER = '／'         // 一轮内连发多条的分隔符（提示词里会说明）

// 深层画像 map-reduce：把全量历史切成块逐块提取，块数封顶控制成本
export const PROFILE_CHUNK_CHARS = 10000
export const PROFILE_MAX_CHUNKS = 12

// 检索式 few-shot 的问答对：单边文本上限 / 连发条数上限
const PAIR_TEXT_CAP = 160
const PAIR_MAX_REPLIES = 6

export interface PersonaTurn {
  /** true = 被侧写者说的（克隆好友时=对方，克隆我自己时="我"） */
  isFriend: boolean
  texts: string[]
  startTime: number
}

export interface PersonaCorpus {
  corpusText: string
  stats: PersonaStats
  turnCount: number
}

/** 取消息用于风格分析的文本：文本消息用解析内容，语音消息只收已转写的。 */
export function messageText(m: ChatSearchMemoryMessage): string {
  if (m.localType === 1) return m.parsedContent.trim()
  if (m.localType === 34) {
    return (voiceTranscribeService.getCachedTranscript(m.sessionId, m.createTime, m.localId) || '').trim()
  }
  return ''
}

/**
 * 合并连发为轮次。
 * @param subjectIsSend 被侧写者是不是"我"：friend 克隆=false（对方），self 克隆=true（"我"）
 */
export function mergeTurns(messages: ChatSearchMemoryMessage[], subjectIsSend = false): PersonaTurn[] {
  const turns: PersonaTurn[] = []
  let prevTime = 0
  for (const m of messages) {
    const text = messageText(m)
    if (!text) continue
    const isFriend = subjectIsSend ? m.isSend === 1 : m.isSend !== 1
    const last = turns[turns.length - 1]
    if (last && last.isFriend === isFriend && m.createTime - prevTime <= TURN_GAP_SECONDS) {
      last.texts.push(text.slice(0, MSG_CHAR_CAP))
    } else {
      turns.push({ isFriend, texts: [text.slice(0, MSG_CHAR_CAP)], startTime: m.createTime })
    }
    prevTime = m.createTime
  }
  return turns
}

function computeStats(turns: PersonaTurn[]): PersonaStats {
  let friendMsgs = 0
  let friendChars = 0
  let friendTurns = 0
  let total = 0
  for (const turn of turns) {
    total += turn.texts.length
    if (!turn.isFriend) continue
    friendTurns += 1
    friendMsgs += turn.texts.length
    for (const t of turn.texts) friendChars += t.length
  }
  return {
    sourceMessageCount: total,
    friendMessageCount: friendMsgs,
    avgFriendMsgChars: friendMsgs > 0 ? Math.round(friendChars / friendMsgs) : 0,
    avgFriendBurst: friendTurns > 0 ? Math.round((friendMsgs / friendTurns) * 10) / 10 : 0,
  }
}

/** 被侧写者语音消息占比：语音 / (文本 + 语音)，按原始消息数（含未转写语音），反映本人爱不爱用语音。 */
function computeVoiceRatio(messages: ChatSearchMemoryMessage[], subjectIsSend = false): number {
  let voice = 0
  let convo = 0
  for (const m of messages) {
    const isSubject = subjectIsSend ? m.isSend === 1 : m.isSend !== 1
    if (!isSubject) continue // 只看被侧写者
    if (m.localType === 1) convo += 1
    else if (m.localType === 34) { convo += 1; voice += 1 }
  }
  return convo > 0 ? Math.round((voice / convo) * 1000) / 1000 : 0
}

/**
 * 把轮次渲染成「subjectName: xxx／xxx」式对话文本，按时间正序输出。
 * 分层：最近的连续对话装满 CORPUS_RECENT_BUDGET，剩余预算从更早历史按轮次均匀抽样——
 * 人格不只由近期决定，且近期几乎没聊时（如长期单方面发消息）全靠抽样兜底。
 */
function renderCorpus(turns: PersonaTurn[], subjectName: string, otherName: string): { text: string; usedTurns: number } {
  const lineOf = (turn: PersonaTurn) => `${turn.isFriend ? subjectName : otherName}: ${turn.texts.join(BURST_JOINER)}`

  const recentLines: string[] = []
  let used = 0
  let i = turns.length - 1
  for (; i >= 0; i -= 1) {
    const line = lineOf(turns[i])
    if (used + line.length > CORPUS_RECENT_BUDGET && recentLines.length > 0) break
    recentLines.push(line)
    used += line.length
  }
  recentLines.reverse()

  const sampledLines: string[] = []
  if (i >= 0 && used < CORPUS_CHAR_BUDGET) {
    const olderLines = turns.slice(0, i + 1).map(lineOf)
    const olderChars = olderLines.reduce((sum, l) => sum + l.length, 0)
    let budget = CORPUS_CHAR_BUDGET - used
    // ponytail: 按字符比例定抽样步长，期望字符数≈预算，轻微超出无害（提示词预算本就不精确）
    const stride = Math.max(1, Math.round(olderChars / budget))
    for (let j = 0; j < olderLines.length && budget > 0; j += stride) {
      sampledLines.push(olderLines[j])
      budget -= olderLines[j].length
    }
  }

  const parts: string[] = []
  if (sampledLines.length > 0) {
    parts.push('（以下是更早历史的抽样片段，轮次之间不连续）', ...sampledLines, '', '（以下是最近的连续对话）')
  }
  parts.push(...recentLines)
  return { text: parts.join('\n'), usedTurns: sampledLines.length + recentLines.length }
}

export function buildPersonaCorpus(
  messages: ChatSearchMemoryMessage[],
  friendName: string,
  subjectIsSend = false,
): PersonaCorpus {
  const turns = mergeTurns(messages, subjectIsSend)
  const stats = computeStats(turns)
  stats.voiceRatio = computeVoiceRatio(messages, subjectIsSend)
  // friend 克隆：subject=对方(friendName)、other="我"
  // self 克隆：subject="我"、other=对方(friendName)
  const subjectName = subjectIsSend ? '我' : friendName
  const otherName = subjectIsSend ? friendName : '我'
  const { text } = renderCorpus(turns, subjectName, otherName)
  return { corpusText: text, stats, turnCount: turns.length }
}

/**
 * 深层画像语料：全部轮次按时间正序渲染后切成 ≤PROFILE_CHUNK_CHARS 的块。
 * 超过 PROFILE_MAX_CHUNKS 时保留最近的块（近期生活状态比远古历史更重要）。
 */
export function renderProfileChunks(turns: PersonaTurn[], friendName: string, subjectIsSend = false): string[] {
  const subjectName = subjectIsSend ? '我' : friendName
  const otherName = subjectIsSend ? friendName : '我'
  const chunks: string[] = []
  let current: string[] = []
  let chars = 0
  for (const turn of turns) {
    const line = `${turn.isFriend ? subjectName : otherName}: ${turn.texts.join(BURST_JOINER)}`
    if (chars + line.length > PROFILE_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
      chars = 0
    }
    current.push(line)
    chars += line.length
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks.slice(-PROFILE_MAX_CHUNKS)
}

/**
 * 抽取「对话方的一轮 → 被侧写者的下一轮」真实问答对（检索式 few-shot 的索引单元）。
 * 方向天然适配两种角色：
 *  - friend 克隆：被侧写者=对方，ask.isFriend=false(我问)、reply.isFriend=true(对方答) → 「我问→对方答」
 *  - self 克隆：  被侧写者="我"，ask.isFriend=false(联系人问)、reply.isFriend=true(我答) → 「联系人问→我答」
 * sinceTime > 0 时只取被侧写者回复轮晚于该水位的对（增量进化用）。
 */
export function extractPersonaPairs(turns: PersonaTurn[], sinceTime = 0): PersonaPair[] {
  const pairs: PersonaPair[] = []
  for (let i = 1; i < turns.length; i += 1) {
    const reply = turns[i]
    const ask = turns[i - 1]
    if (!reply.isFriend || ask.isFriend) continue
    if (sinceTime > 0 && reply.startTime <= sinceTime) continue
    const user = ask.texts.join(BURST_JOINER).slice(0, PAIR_TEXT_CAP)
    const replies = reply.texts.slice(0, PAIR_MAX_REPLIES).map((t) => t.slice(0, PAIR_TEXT_CAP))
    if (user.length < 2 || replies.length === 0) continue
    // 再往前带一轮语境：接梗/回调类回复离开上文就是断章取义
    const context = i >= 2 ? turns[i - 2].texts.join(BURST_JOINER).slice(0, PAIR_TEXT_CAP) : undefined
    pairs.push({ time: reply.startTime, user, replies, ...(context ? { context } : {}) })
  }
  return pairs
}
