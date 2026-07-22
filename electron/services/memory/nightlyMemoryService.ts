import type { MainProcessContext } from '../../main/context'
import { chatService } from '../chatService'
import { isSystemContactUsername } from '../chat/constants'
import type { ChatSession, Message } from '../chat/types'

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 90_000
const UNREAD_SESSION_LIMIT = 12
const UNREAD_MESSAGES_PER_SESSION = 8
const DAY_SESSION_LIMIT = 16
const DAY_MESSAGES_PER_SESSION = 24
const DAY_SESSION_SCAN_LIMIT = 100

const NOISE_SESSION_KEYWORDS = [
  '招商银行',
  '信用卡',
  '银行',
  '账单',
  '消费记录',
  '还款',
  '支付助手',
  '微信支付',
  '财付通',
  '企业微信客服',
  '企业微信团队',
  '企业微信服务',
  '服务通知',
  '系统通知',
  '订阅号',
  '服务号',
  '公众号',
  '客户服务',
  '在线客服',
  '客服消息',
  '小助手',
  '机器人',
  '快递',
  '物流',
  '外卖',
  '订单通知',
  '营销',
  '广告',
  '推广',
  '优惠券',
  '积分商城',
  '会员中心',
  '新闻',
  '资讯'
]

const NOISE_MESSAGE_KEYWORDS = [
  '开通微信提醒',
  '消费记录',
  '交易提醒',
  '信用卡',
  '账单',
  '还款',
  '支付成功',
  '扣款',
  '验证码',
  '点击查看',
  '优惠',
  '广告',
  '营销',
  '订阅',
  '发票',
  '订单已',
  '快递',
  '物流',
  '欢迎使用企业微信',
  '企业微信邀请'
]

const SIGNAL_SESSION_KEYWORDS = [
  '工作',
  '项目',
  '医院',
  '科室',
  '病区',
  '门诊',
  '值班',
  '排班',
  '会议',
  '任务',
  '需求',
  '客户',
  '研发',
  '产品',
  '运营'
]

const SIGNAL_MESSAGE_KEYWORDS = [
  '今天',
  '明天',
  '需要',
  '安排',
  '处理',
  '跟进',
  '确认',
  '会议',
  '任务',
  '项目',
  '需求',
  '问题',
  '报错',
  '线上',
  '发布',
  '医院',
  '科室',
  '病区',
  '门诊',
  '值班',
  '排班',
  '患者',
  '病人',
  '医生',
  '护士',
  '主任',
  '检查',
  '手术',
  '处方',
  '医嘱'
]

type DayDiaryBlock = {
  mine: boolean
  group: boolean
  count: number
  score: number
  text: string
}

function normalizeMatchText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/\s+/g, '')
}

function includesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(normalizeMatchText(keyword)))
}

function sessionMatchText(session: ChatSession): string {
  return normalizeMatchText([
    session.username,
    session.displayName,
    session.summary,
    session.weComCorp
  ].filter(Boolean).join(' '))
}

function sessionIdentityText(session: ChatSession): string {
  return normalizeMatchText([
    session.username,
    session.displayName,
    session.weComCorp
  ].filter(Boolean).join(' '))
}

function messageMatchText(message: Message): string {
  return normalizeMatchText([message.parsedContent, message.rawContent, message.fileName].filter(Boolean).join(' '))
}

function isGroupSession(session: ChatSession): boolean {
  return String(session.username || '').toLowerCase().includes('@chatroom')
}

function isLowValueMessage(message: Message): boolean {
  const text = messageMatchText(message)
  return Boolean(text) && includesAnyKeyword(text, NOISE_MESSAGE_KEYWORDS)
}

function hasSignalText(session: ChatSession, messages: Message[]): boolean {
  const sessionText = sessionMatchText(session)
  const messagesText = normalizeMatchText(messages.map(messageMatchText).join(' '))
  return includesAnyKeyword(sessionText, SIGNAL_SESSION_KEYWORDS) || includesAnyKeyword(messagesText, SIGNAL_MESSAGE_KEYWORDS)
}

function isLowValueServiceSession(session: ChatSession): boolean {
  const username = String(session.username || '').trim()
  const lower = username.toLowerCase()
  if (!username || isSystemContactUsername(lower)) return true
  if (lower.startsWith('gh_')) return true
  if (session.isFoldGroup || session.isOfficialFolder || session.isOfficialAccount) return true
  if (Number(session.type) === 3) return true
  if (includesAnyKeyword(sessionIdentityText(session), NOISE_SESSION_KEYWORDS)) return true
  return !isGroupSession(session) && includesAnyKeyword(sessionMatchText(session), NOISE_SESSION_KEYWORDS)
}

function isDiaryConversationSession(session: ChatSession): boolean {
  const username = String(session.username || '').trim()
  const lower = username.toLowerCase()
  if (!username || isSystemContactUsername(lower)) return false
  if (lower.startsWith('gh_')) return false
  if (session.isFoldGroup || session.isOfficialFolder || session.isOfficialAccount) return false
  if (Number(session.type) === 3) return false
  if (isLowValueServiceSession(session)) return false
  return true
}

function formatDiaryTime(timestamp: number): string {
  if (!timestamp) return '未知时间'
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function messageText(message: Message): string {
  const text = String(message.parsedContent || message.rawContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 220)
  if (message.voiceDuration) return `[语音 ${message.voiceDuration} 秒]`
  if (message.videoDuration) return `[视频 ${message.videoDuration} 秒]`
  if (message.fileName) return `[文件 ${message.fileName}]`
  if (message.imageMd5 || message.imageDatName) return '[图片]'
  if (message.emojiMd5 || message.emojiCdnUrl) return '[表情]'
  return '[非文本消息]'
}

function isPrivateDiarySession(session: ChatSession): boolean {
  return isDiaryConversationSession(session) && !isGroupSession(session)
}

function diarySender(session: ChatSession, message: Message, displayName: string): string {
  if (message.isSend) return '我'
  if (isGroupSession(session)) return message.senderUsername || '群成员'
  return displayName
}

function readableSummary(session: ChatSession): string {
  const summary = String(session.summary || '').replace(/\s+/g, ' ').trim()
  if (!summary || includesAnyKeyword(normalizeMatchText(summary), NOISE_MESSAGE_KEYWORDS)) return ''
  return summary
}

function shouldKeepDayMessages(session: ChatSession, messages: Message[]): boolean {
  if (messages.length === 0) return false
  const mine = messages.some((message) => Boolean(message.isSend))
  const meaningfulCount = messages.filter((message) => !isLowValueMessage(message)).length
  const hasSignal = hasSignalText(session, messages)
  if (meaningfulCount === 0 && !mine && !hasSignal) return false
  if (!isGroupSession(session)) return true
  if (mine || hasSignal) return true
  return meaningfulCount >= 3
}

function scoreDayMessages(session: ChatSession, messages: Message[]): number {
  const mine = messages.some((message) => Boolean(message.isSend))
  const group = isGroupSession(session)
  let score = Math.min(messages.length, 30)
  if (mine) score += 100
  if (!group) score += 30
  if (hasSignalText(session, messages)) score += 45
  score += messages.filter((message) => !isLowValueMessage(message)).length
  if (group && !mine && messages.length <= 2 && !hasSignalText(session, messages)) score -= 30
  return score
}

export async function readUnreadDiarySource(): Promise<string> {
  const sessionsResult = await chatService.getSessions(0, 300)
  if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) return ''
  const unreadSessions = sessionsResult.sessions
    .filter((session) => Number(session.unreadCount || 0) > 0)
    .filter(isPrivateDiarySession)
    .sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0) || Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
    .slice(0, UNREAD_SESSION_LIMIT)
  if (unreadSessions.length === 0) return ''

  const blocks: string[] = []
  for (const session of unreadSessions) {
    const messages = (await readUnreadSessionMessages(session)).filter((message) => !isLowValueMessage(message))
    const summary = readableSummary(session)
    if (messages.length === 0 && !summary) continue
    const displayName = session.displayName || session.username
    blocks.push([
      `### ${displayName}（未读 ${session.unreadCount} 条）`,
      summary ? `最近摘要：${summary}` : '',
      ...messages.map((message) => {
        const sender = diarySender(session, message, displayName)
        return `- ${formatDiaryTime(message.createTime)} ${sender}：${messageText(message)}`
      })
    ].filter(Boolean).join('\n'))
  }
  return blocks.join('\n\n').slice(0, 12_000)
}

async function readUnreadSessionMessages(session: ChatSession): Promise<Message[]> {
  const limit = Math.max(1, Math.min(UNREAD_MESSAGES_PER_SESSION, Number(session.unreadCount || 0)))
  const result = await chatService.getMessages(session.username, 0, limit)
  if (!result.success || !Array.isArray(result.messages)) return []
  return [...result.messages].sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
}

/**
 * 目标日的真实聊天摘要（读没读都算）：日记的主素材。
 * 未读消息只反映"没点开的推送"，用户自己参与过的对话才是这一天的生活。
 */
export async function readTodayChatDiarySource(date: string): Promise<string> {
  const dayStartMs = new Date(`${date}T00:00:00`).getTime()
  if (!Number.isFinite(dayStartMs)) return ''
  const dayStartSec = Math.floor(dayStartMs / 1000)
  const dayEndSec = dayStartSec + 24 * 3600

  const sessionsResult = await chatService.getSessions(0, 300)
  if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) return ''
  const candidates = sessionsResult.sessions
    .filter(isDiaryConversationSession)
    .filter((session) => Number(session.lastTimestamp || 0) >= dayStartSec)
    .sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
    .slice(0, DAY_SESSION_SCAN_LIMIT) // 多取候选，窗口内没消息或低价值的会被丢掉

  const blocks: DayDiaryBlock[] = []
  for (const session of candidates) {
    const result = await chatService.getMessagesByTimeRangeForSummary(session.username, {
      startTime: dayStartSec,
      endTime: dayEndSec - 1,
      limit: DAY_MESSAGES_PER_SESSION
    })
    if (!result.success || !Array.isArray(result.messages)) continue
    const dayMessages = result.messages
      .filter((m) => Number(m.createTime || 0) >= dayStartSec && Number(m.createTime || 0) < dayEndSec)
      .sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
    if (!shouldKeepDayMessages(session, dayMessages)) continue
    const displayName = session.displayName || session.username
    const mine = dayMessages.some((m) => Boolean(m.isSend))
    const group = isGroupSession(session)
    const label = group ? `群聊${mine ? '，我参与了' : '，我没发言'}` : (mine ? '私聊，我参与了' : '私聊，只有对方在说')
    blocks.push({
      mine,
      group,
      count: dayMessages.length,
      score: scoreDayMessages(session, dayMessages),
      text: [
        `### ${displayName}（${label}）`,
        ...dayMessages.map((m) => `- ${formatDiaryTime(m.createTime)} ${diarySender(session, m, displayName)}：${messageText(m)}`)
      ].join('\n')
    })
  }
  // 我参与过、或群名/内容明显像工作事项的对话排前面。
  blocks.sort((a, b) => b.score - a.score || Number(b.mine) - Number(a.mine) || b.count - a.count)
  return blocks.slice(0, DAY_SESSION_LIMIT).map((b) => b.text).join('\n\n').slice(0, 12_000)
}

class NightlyMemoryService {
  private ctx: MainProcessContext | null = null
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private running = false

  init(ctx: MainProcessContext): void {
    if (this.timer) return
    this.ctx = ctx
    this.timer = setInterval(() => {
      void this.check()
    }, CHECK_INTERVAL_MS)
    this.startupTimer = setTimeout(() => {
      void this.check()
    }, STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ctx = null
  }

 private async check(): Promise<void> {
   if (this.running) return
   const config = this.ctx?.getConfigService()
   if (!config) return
   if (!String(config.get('myWxid') || '').trim()) return
   const provider = config.getAICurrentProvider()
   if (!String(config.getAIProviderConfig(provider)?.apiKey || '').trim()) return
    if (config.get('diaryEnabled') === false) return
   const summaryHour = Number(config.get('diarySummaryHour') ?? 2)
    const customPrompt = String(config.get('diaryCustomPrompt') || '').trim()
    this.running = true
    try {
      const [{ resolveProviderConfig }, { maybeRunDailyConsolidation }, { memoryDatabase }] = await Promise.all([
        import('../agent/resolveProviderConfig'),
        import('../agent/tools/memory'),
        import('./memoryDatabase')
      ])
      // 先确认到点要写哪天的日记，没到点就不白读聊天库
      const date = memoryDatabase.getDailyConsolidationTarget(undefined, summaryHour)
      if (!date) return
      const [unreadMessages, dayMessages] = await Promise.all([
        readUnreadDiarySource().catch(() => ''),
        readTodayChatDiarySource(date).catch(() => '')
      ])
      await maybeRunDailyConsolidation(resolveProviderConfig(), undefined, { unreadMessages, dayMessages, summaryHour, customPrompt })
      this.ctx?.getLogService()?.info('NightlyMemory', '夜间记忆整理检查完成')
    } catch (error) {
      this.ctx?.getLogService()?.warn('NightlyMemory', '夜间记忆整理跳过', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }
}

export const nightlyMemoryService = new NightlyMemoryService()
