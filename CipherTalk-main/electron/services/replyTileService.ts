import { chatService } from './chatService'
import { isPrivateSession } from './notifyService'
import { voiceTranscribeService } from './voiceTranscribeService'
import type { MainProcessContext, ReplyTileBatch, ReplyTileEntry } from '../main/context'
import type { ChatSession, Message } from './chat/types'

/**
 * 磁贴后台生成（主进程）：为「参与磁贴」的会话在收到新消息时生成回复建议，推给磁贴窗口。
 * 参与 = replySuggestSessions[username].enabled && .tile。当前正在软件里打开的会话交给渲染端全保真生成，这里跳过。
 * 挂在 chatService 'dbChange' 事件上（复用监控桥，不新增轮询），思路与 notifyService 一致。
 * 上下文与渲染端 replySuggest.ts 对齐：语音换转写缓存、对方待回复图片、likeme/deep 画像，全保真。
 */

const DEBOUNCE_MS = 800
const REPLY_QUIET_MS = 5000
const REPLY_GENERATE_TIMEOUT_MS = 90_000
const SESSION_QUERY_LIMIT = 200
const FRESH_SECONDS = 10 * 60
const REPLY_SUGGEST_CONFIG_KEY = 'replySuggestSessions'
const SUGGEST_IMAGE_MAX_BASE64 = 6 * 1024 * 1024
const SUGGEST_IMAGE_MAX = 3

type SessionSnap = { lastTs: number; unread: number }
type PerSession = { enabled?: boolean; tile?: boolean; style?: string; count?: number; deep?: boolean }
type ReplyTarget = { targetKey: string; quote: string; createTime: number }
type PendingGenerate = { sessionName: string; settings: PerSession; targetKey: string; quote: string }
type ReplaceSuggestionTarget = { batchId: string; suggestionIndex: number }

const VALID_STYLES = new Set(['natural', 'short', 'formal', 'humorous', 'warm', 'likeme'])

function quoteFromMessage(message: Message): string {
  const text = message.parsedContent?.trim()
  if (text) return text.slice(0, 120)
  if (message.localType === 3) return '[图片]'
  if (message.localType === 34) return '[语音]'
  return '最新一条消息'
}

function targetCreateTime(targetKey: string): number | null {
  const parts = targetKey.split(':')
  const raw = parts[parts.length - 1]
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function isFreshTarget(target: ReplyTarget): boolean {
  return Date.now() / 1000 - target.createTime <= FRESH_SECONDS
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 上下文：取最近文本消息（从旧到新），语音换转写缓存文字。等价渲染端 buildSuggestContext。 */
function buildContext(sessionId: string, messages: Message[], deep: boolean): Array<{ fromMe: boolean; text: string }> {
  const take = deep ? 120 : 30
  return messages.filter((m) => m.parsedContent?.trim()).slice(-take).map((m) => {
    let text = m.parsedContent.trim()
    if (m.localType === 34) {
      try {
        const t = voiceTranscribeService.getCachedTranscript(sessionId, m.createTime, m.localId)
        if (t) text = `[语音] ${t}`
      } catch { /* 无转写保持占位 */ }
    }
    return { fromMe: m.isSend === 1, text }
  })
}

/** 对方在我上次回复之后连发、正等我回的图片，解密成 base64、时间正序。等价渲染端 collectPendingImages。 */
async function collectPendingImages(sessionId: string, messages: Message[]): Promise<Array<{ base64: string }>> {
  const refs: Message[] = []
  for (let i = messages.length - 1; i >= 0 && refs.length < SUGGEST_IMAGE_MAX; i -= 1) {
    const m = messages[i]
    if (m.isSend === 1) break
    if (m.localType === 3) refs.push(m)
  }
  if (refs.length === 0) return []
  const out: Array<{ base64: string }> = []
  for (const m of refs.reverse()) {
    try {
      const res = await chatService.getImageData(sessionId, String(m.localId), m.createTime)
      if (res.success && res.data && res.data.length <= SUGGEST_IMAGE_MAX_BASE64) out.push({ base64: res.data })
    } catch { /* 单张失败跳过 */ }
  }
  return out
}

function buildMyRecentTexts(messages: Message[]): string[] {
  return messages.filter((m) => m.isSend === 1)
    .map((m) => m.parsedContent?.trim() || '')
    .filter((t) => t && !/^\[.+\]$/.test(t)).slice(-20)
}

/** "像我"画像卡渲染成提示文本（等价渲染端 buildMyPersonaContext） */
function buildMyPersonaContext(p: any): string {
  const lines: string[] = []
  const { card, fewShots } = p
  if (card.tone) lines.push(`- 语气风格：${card.tone}`)
  if (card.personalityTraits?.length) lines.push(`- 性格特征：${card.personalityTraits.join('、')}`)
  if (card.catchphrases?.length) lines.push(`- 口头禅/高频用语：${card.catchphrases.join('、')}`)
  if (card.punctuationStyle) lines.push(`- 标点排版习惯：${card.punctuationStyle}`)
  if (card.addressing) lines.push(`- 称呼习惯：${card.addressing}`)
  if (card.topics?.length) lines.push(`- 常聊话题：${card.topics.join('、')}`)
  if (fewShots?.length) {
    lines.push('- 真实问答示例（模仿"我"的回复）：')
    for (const shot of fewShots.slice(0, 6)) {
      lines.push(`  · 对方：${shot.user}`)
      lines.push(`    我：${shot.replies.join('／')}`)
    }
  }
  return lines.join('\n')
}

/** 对方画像渲染成提示文本（等价渲染端 buildFriendPersonaContext） */
function buildFriendPersonaContext(p: any): string {
  const lines: string[] = []
  const { card, profile } = p
  if (card.tone) lines.push(`- TA 的语气风格：${card.tone}`)
  if (card.personalityTraits?.length) lines.push(`- TA 的性格：${card.personalityTraits.join('、')}`)
  if (card.topics?.length) lines.push(`- 你们常聊：${card.topics.join('、')}`)
  if (profile?.relationship) lines.push(`- 你们的关系：${profile.relationship}`)
  if (profile?.boundaries?.length) lines.push(`- TA 的雷区/别碰的话题：${profile.boundaries.join('、')}`)
  if (profile?.reactionPatterns?.length) {
    lines.push('- TA 在不同情境下的典型反应：')
    for (const r of profile.reactionPatterns.slice(0, 4)) lines.push(`  · ${r}`)
  }
  return lines.join('\n')
}

class ReplyTileService {
  private ctx: MainProcessContext | null = null
  private attached = false
  private running = false
  private debounceTimer: NodeJS.Timeout | null = null
  private checking = false
  private snapshot = new Map<string, SessionSnap>()
  private participants = new Set<string>()
  private generating = new Set<string>()
  private generateTimers = new Map<string, NodeJS.Timeout>()
  private generationSeq = new Map<string, number>()
  private latestTargetKey = new Map<string, string>()
  private pendingContinue = new Map<string, PendingGenerate>()
  private batches = new Map<string, ReplyTileBatch[]>()
  private nameCache = new Map<string, string>()
  private avatarCache = new Map<string, string>()

  init(ctx: MainProcessContext): void {
    this.ctx = ctx
    if (this.attached) return
    this.attached = true
    chatService.on('dbChange', (payload: { table?: string }) => {
      const table = String(payload?.table || '')
      if (table !== 'Session' && table !== 'Message') return
      this.ctx?.getLogService()?.warn('ReplyTile', '收到数据库变更，准备检查磁贴回复建议', { table, running: this.running })
      this.scheduleCheck()
    })
  }

  /** 全局磁贴开关联动：开→播种 + 推参与列表；关→清状态（窗口由 windowManager 关闭） */
  setRunning(on: boolean): void {
    if (on === this.running) return
    this.running = on
    this.ctx?.getLogService()?.warn('ReplyTile', '磁贴后台服务状态变更', { running: on })
    if (on) {
      void this.refresh()
    } else {
      this.snapshot.clear()
      this.participants.clear()
      this.generating.clear()
      for (const timer of this.generateTimers.values()) clearTimeout(timer)
      this.generateTimers.clear()
      this.generationSeq.clear()
      this.latestTargetKey.clear()
      this.pendingContinue.clear()
      this.batches.clear()
    }
  }

  /** 参与集/显示名即时同步（会话开关变动时由 IPC 调用）：新增推 pending，移除推 gone */
  async refresh(): Promise<void> {
    if (!this.running) return
    try {
      const res = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      const sessions = res.success && Array.isArray(res.sessions) ? res.sessions : []
      this.cacheSessions(sessions)
      const next = this.computeParticipating()
      const current = chatService.getCurrentSessionId()
      this.ctx?.getLogService()?.warn('ReplyTile', '刷新磁贴参与会话', {
        success: res.success,
        sessionCount: sessions.length,
        participantCount: next.size,
        current,
      })
      for (const id of next) {
        if (!this.participants.has(id)) {
          // 当前会话的条目由渲染端全保真推送，主进程别推 pending 覆盖
          if (id !== current) this.emit({ sessionId: id, sessionName: this.nameOf(id), avatarUrl: this.avatarOf(id), state: 'pending' })
          // 播种基线：用当前快照，避免开启后把历史最后一条当成新消息补生成
          const snap = this.snapFromSessions(sessions, id)
          if (snap) this.snapshot.set(id, snap)
        }
      }
      for (const id of this.participants) {
        if (!next.has(id)) {
          this.emit({ sessionId: id, sessionName: this.nameOf(id), avatarUrl: this.avatarOf(id), state: 'gone' })
          this.snapshot.delete(id)
          this.clearSessionGeneration(id)
        }
      }
      this.participants = next
    } catch (e) {
      this.ctx?.getLogService()?.warn('ReplyTile', '刷新磁贴参与会话失败，等待 dbChange 重试', { error: String(e) })
    }
  }

  isParticipating(sessionId: string): boolean {
    const s = this.readSettingsMap()[sessionId]
    return s?.enabled === true && s.tile === true
  }

  private computeParticipating(): Set<string> {
    const map = this.readSettingsMap()
    const set = new Set<string>()
    for (const [id, s] of Object.entries(map)) {
      if (s && s.enabled === true && s.tile === true) set.add(id)
    }
    return set
  }

  private readSettingsMap(): Record<string, PerSession> {
    const raw = this.ctx?.getConfigService()?.get(REPLY_SUGGEST_CONFIG_KEY)
    return raw && typeof raw === 'object' ? (raw as Record<string, PerSession>) : {}
  }

  private nameOf(id: string): string {
    return this.nameCache.get(id) || id
  }

  private avatarOf(id: string): string | undefined {
    return this.avatarCache.get(id)
  }

  private cacheSessions(sessions: ChatSession[]): void {
    for (const s of sessions) {
      this.nameCache.set(s.username, s.displayName || s.username)
      if (s.avatarUrl) this.avatarCache.set(s.username, s.avatarUrl)
    }
  }

  private snapFromSessions(sessions: ChatSession[], id: string): SessionSnap | null {
    const s = sessions.find((x) => x.username === id)
    if (!s) return null
    return { lastTs: Number(s.lastTimestamp || s.sortTimestamp || 0), unread: Number(s.unreadCount || 0) }
  }

  private scheduleCheck(): void {
    if (!this.running) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.ctx?.getLogService()?.warn('ReplyTile', '安排磁贴回复建议检查', { debounceMs: DEBOUNCE_MS })
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.check()
    }, DEBOUNCE_MS)
  }

  private async check(): Promise<void> {
    if (!this.running || this.checking) return
    this.checking = true
    try {
      const res = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      if (!res.success || !Array.isArray(res.sessions)) {
        this.ctx?.getLogService()?.warn('ReplyTile', '磁贴检查读取会话失败', { error: res.error })
        return
      }
      this.cacheSessions(res.sessions)

      const participating = this.computeParticipating()
      this.syncParticipantList(participating)

      const map = this.readSettingsMap()
      const current = chatService.getCurrentSessionId()
      this.ctx?.getLogService()?.warn('ReplyTile', '开始磁贴回复建议检查', {
        sessionCount: res.sessions.length,
        participantCount: participating.size,
        current,
      })
      for (const session of res.sessions) {
        const id = String(session.username || '')
        if (!participating.has(id)) continue

        const cur: SessionSnap = {
          lastTs: Number(session.lastTimestamp || session.sortTimestamp || 0),
          unread: Number(session.unreadCount || 0),
        }
        const prev = this.snapshot.get(id)
        this.snapshot.set(id, cur)

        if (!isPrivateSession(session)) {
          this.ctx?.getLogService()?.warn('ReplyTile', '跳过非私聊会话', { sessionId: id })
          continue
        }
        if (id === current) {
          this.ctx?.getLogService()?.warn('ReplyTile', '跳过当前聊天窗口会话，由渲染端生成', { sessionId: id })
          continue
        }
        if (prev && cur.lastTs <= prev.lastTs) {
          this.ctx?.getLogService()?.warn('ReplyTile', '跳过无新消息会话', { sessionId: id, prevLastTs: prev.lastTs, curLastTs: cur.lastTs })
          continue
        }
        // 不能依赖 unread 判断：微信当前打开该会话时，对方新消息也可能 unread=0。
        // 直接看最后一条消息是否对方发来，避免漏生成，同时避免我自己发消息后误生成。
        const sessionName = this.nameOf(id) || session.displayName || id
        const target = await this.latestIncomingMessageTarget(id)
        if (!target) {
          this.ctx?.getLogService()?.warn('ReplyTile', '最后一条不是对方消息，跳过生成', { sessionId: id, prevLastTs: prev?.lastTs, curLastTs: cur.lastTs })
          this.clearSessionGeneration(id)
          this.emit({ sessionId: id, sessionName, avatarUrl: this.avatarOf(id), state: 'pending' })
          continue
        }
        // 如果启动时 DB 还没 ready，第一次 dbChange 可能是首个成功快照。
        // 这时只要最后一条是刚收到的对方消息，就允许生成，避免把第一条新消息静默吃掉。
        if (!prev && !isFreshTarget(target)) {
          this.ctx?.getLogService()?.warn('ReplyTile', '首次快照但最后消息不新鲜，静默播种', { sessionId: id, targetKey: target.targetKey, createTime: target.createTime })
          continue
        }

        this.ctx?.getLogService()?.warn('ReplyTile', '命中磁贴回复建议生成条件', {
          sessionId: id,
          targetKey: target.targetKey,
          prevLastTs: prev?.lastTs ?? null,
          curLastTs: cur.lastTs,
        })

        this.scheduleGenerate(id, sessionName, map[id] || {}, target)
      }
    } catch (e) {
      this.ctx?.getLogService()?.warn('ReplyTile', '检查参与会话失败', { error: String(e) })
    } finally {
      this.checking = false
    }
  }

  /** 仅同步磁贴里的参与条目（新增 pending / 移除 gone），不做基线播种（check 里已更新快照） */
  private syncParticipantList(next: Set<string>): void {
    const current = chatService.getCurrentSessionId()
    for (const id of next) {
      // 当前会话的条目由渲染端全保真推送，主进程别推 pending 覆盖
      if (!this.participants.has(id) && id !== current) this.emit({ sessionId: id, sessionName: this.nameOf(id), avatarUrl: this.avatarOf(id), state: 'pending' })
    }
    for (const id of this.participants) {
      if (!next.has(id)) {
        this.emit({ sessionId: id, sessionName: this.nameOf(id), avatarUrl: this.avatarOf(id), state: 'gone' })
        this.snapshot.delete(id)
        this.clearSessionGeneration(id)
      }
    }
    this.participants = next
  }

  private async latestIncomingMessageTarget(sessionId: string): Promise<ReplyTarget | null> {
    try {
      const msgRes = await chatService.getMessages(sessionId, 0, 3)
      const messages = msgRes.success && Array.isArray(msgRes.messages) ? msgRes.messages : []
      const last = messages[messages.length - 1]
      this.ctx?.getLogService()?.warn('ReplyTile', '读取最新消息用于磁贴判断', {
        sessionId,
        success: msgRes.success,
        messageCount: messages.length,
        lastIsSend: last?.isSend ?? null,
        lastType: last?.localType ?? null,
        lastCreateTime: last?.createTime ?? null,
        error: msgRes.error,
      })
      return last && last.isSend !== 1
        ? { targetKey: `${sessionId}:${last.localId}:${last.createTime}`, quote: quoteFromMessage(last), createTime: last.createTime }
        : null
    } catch {
      return null
    }
  }

  private clearSessionGeneration(sessionId: string): void {
    const timer = this.generateTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.generateTimers.delete(sessionId)
    this.generationSeq.set(sessionId, (this.generationSeq.get(sessionId) || 0) + 1)
    this.latestTargetKey.delete(sessionId)
    this.pendingContinue.delete(sessionId)
    this.batches.delete(sessionId)
  }

  private scheduleGenerate(sessionId: string, sessionName: string, settings: PerSession, target: ReplyTarget): void {
    const prevKey = this.latestTargetKey.get(sessionId)
    if (prevKey === target.targetKey) {
      this.ctx?.getLogService()?.warn('ReplyTile', '同一目标消息已排队或已生成，跳过重复调度', { sessionId, targetKey: target.targetKey })
      return
    }
    this.latestTargetKey.set(sessionId, target.targetKey)

    if (this.generating.has(sessionId)) {
      this.pendingContinue.set(sessionId, { sessionName, settings, targetKey: target.targetKey, quote: target.quote })
      this.ctx?.getLogService()?.warn('ReplyTile', '已有生成在进行，记录为待继续生成', { sessionId, targetKey: target.targetKey })
      this.emitState(sessionId, sessionName, 'loading')
      return
    }

    const oldTimer = this.generateTimers.get(sessionId)
    if (oldTimer) clearTimeout(oldTimer)
    const seq = this.generationSeq.get(sessionId) || 0
    this.pendingContinue.delete(sessionId)
    this.ctx?.getLogService()?.warn('ReplyTile', '已排队磁贴回复建议生成，等待静默窗口', {
      sessionId,
      targetKey: target.targetKey,
      quietMs: REPLY_QUIET_MS,
      seq,
    })
    this.emitState(sessionId, sessionName, 'loading')
    const timer = setTimeout(() => {
      this.generateTimers.delete(sessionId)
      if (this.latestTargetKey.get(sessionId) !== target.targetKey) {
        this.ctx?.getLogService()?.warn('ReplyTile', '静默窗口结束但目标消息已变化，取消本次 AI 调用', { sessionId, targetKey: target.targetKey, latestTargetKey: this.latestTargetKey.get(sessionId) })
        this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
        return
      }
      this.ctx?.getLogService()?.warn('ReplyTile', '静默窗口结束，准备进入 AI 调用', { sessionId, targetKey: target.targetKey, seq })
      void this.generate(sessionId, sessionName, settings, target.targetKey, target.quote, seq)
    }, REPLY_QUIET_MS)
    this.generateTimers.set(sessionId, timer)
  }

  continueGeneration(sessionId: string): void {
    const pending = this.pendingContinue.get(sessionId)
    if (!pending || this.generating.has(sessionId)) return
    this.pendingContinue.delete(sessionId)
    const oldTimer = this.generateTimers.get(sessionId)
    if (oldTimer) clearTimeout(oldTimer)
    this.generateTimers.delete(sessionId)
    const seq = this.generationSeq.get(sessionId) || 0
    this.emitState(sessionId, pending.sessionName, 'loading')
    void this.generate(sessionId, pending.sessionName, pending.settings, pending.targetKey, pending.quote, seq)
  }

  skip(sessionId: string): void {
    const pending = this.pendingContinue.get(sessionId)
    this.pendingContinue.delete(sessionId)
    if (pending) this.emitState(sessionId, pending.sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
  }

  retrySuggestion(sessionId: string, batchId: string, suggestionIndex: number): void {
    if (chatService.getCurrentSessionId() === sessionId) return
    if (this.generating.has(sessionId)) return
    const batch = (this.batches.get(sessionId) || []).find((item) => item.id === batchId)
    if (!batch || suggestionIndex < 0 || suggestionIndex >= batch.suggestions.length) return
    const settings = this.readSettingsMap()[sessionId] || {}
    const seq = this.generationSeq.get(sessionId) || 0
    this.emitState(sessionId, this.nameOf(sessionId), 'loading')
    void this.generate(sessionId, this.nameOf(sessionId), settings, batch.targetKey, batch.quote, seq, {
      count: 1,
      replace: { batchId, suggestionIndex },
    })
  }

  private async generate(
    sessionId: string,
    sessionName: string,
    settings: PerSession,
    targetKey: string,
    quote: string,
    seq: number,
    options?: { count?: number; replace?: ReplaceSuggestionTarget },
  ): Promise<void> {
    if (!options?.replace && this.latestTargetKey.get(sessionId) !== targetKey) {
      this.ctx?.getLogService()?.warn('ReplyTile', '跳过过期回复建议生成', { sessionId, targetKey, latestTargetKey: this.latestTargetKey.get(sessionId) })
      this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
      return
    }
    if ((this.generationSeq.get(sessionId) || 0) !== seq) {
      this.ctx?.getLogService()?.warn('ReplyTile', '跳过已失效回复建议生成', { sessionId, targetKey, seq, currentSeq: this.generationSeq.get(sessionId) })
      this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
      return
    }
    if (this.generating.has(sessionId)) {
      if (!options?.replace) this.pendingContinue.set(sessionId, { sessionName, settings, targetKey, quote })
      return
    }
    this.generating.add(sessionId)
    this.emitState(sessionId, sessionName, 'loading')
    try {
      const style = VALID_STYLES.has(String(settings.style)) ? String(settings.style) : 'natural'
      const count = [1, 2, 3, 4, 5].includes(Number(settings.count)) ? Number(settings.count) : 3
      const deep = settings.deep === true
      const take = deep ? 120 : 30

      const msgRes = await chatService.getMessages(sessionId, 0, take)
      const rawMessages = msgRes.success && Array.isArray(msgRes.messages) ? msgRes.messages : []
      const createTime = targetCreateTime(targetKey)
      const messages = createTime === null ? rawMessages : rawMessages.filter((m) => m.createTime <= createTime)
      const context = buildContext(sessionId, messages, deep)
      if ((this.generationSeq.get(sessionId) || 0) !== seq) {
        this.ctx?.getLogService()?.warn('ReplyTile', '上下文构建后生成已失效', { sessionId, targetKey, seq, currentSeq: this.generationSeq.get(sessionId) })
        this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
        return
      }
      if (context.length === 0) {
        this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
        return
      }

      // 画像：likeme 用自画像卡（无则退回 few-shot 兜底）；deep 用对方画像；myStats 供连发自适应
      const { personaStore } = await import('./agent/persona/personaStore')
      const myPersona = personaStore.get(`self:${sessionId}`)
      let myPersonaContext: string | undefined
      let myRecentTexts: string[] | undefined
      if (style === 'likeme') {
        if (myPersona) myPersonaContext = buildMyPersonaContext(myPersona)
        else myRecentTexts = buildMyRecentTexts(messages)
      }
      const myStats = myPersona
        ? { avgBurst: myPersona.stats.avgFriendBurst, avgChars: myPersona.stats.avgFriendMsgChars }
        : undefined
      let friendPersonaContext: string | undefined
      if (deep) {
        const friendPersona = personaStore.get(sessionId)
        if (friendPersona) friendPersonaContext = buildFriendPersonaContext(friendPersona)
      }
      const images = await collectPendingImages(sessionId, messages)

      const { agentProcessService } = await import('./agent/agentProcessService')
      const { resolveProviderConfig } = await import('./agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('./ai/proxyFetch')
      await refreshResolvedProxyUrl()
      const queryText = context.map((m) => m.text).join('\n').slice(-2000)
      const providerConfig = resolveProviderConfig(null)
      const profile = deep
        ? await (async () => {
            const { agentProfileService } = await import('./agent/agentProfileService')
            return agentProfileService.resolve({
              mode: 'app',
              scope: { kind: 'session', sessionId, displayName: sessionName },
              toolProfile: 'hybrid',
              includeMcpSkills: true,
              queryText,
            })
          })()
        : null
      this.ctx?.getLogService()?.warn('ReplyTile', '开始调用 AI 生成回复建议', {
        sessionId,
        targetKey,
        contextCount: context.length,
        imageCount: images.length,
        count: options?.count ?? count,
        replace: Boolean(options?.replace),
      })
      const result = await withTimeout(agentProcessService.replySuggest({
        contactName: sessionName,
        sessionId,
        context,
        style: style as never,
        count: options?.count ?? count,
        deep,
        myRecentTexts,
        myPersonaContext,
        myStats,
        friendPersonaContext,
        images: images.length > 0 ? images : undefined,
        providerConfig: profile?.providerConfig ?? providerConfig,
        mcpTools: profile?.mcpTools,
        skills: profile?.skills,
        toolProfile: profile?.toolProfile,
        codeWorkspace: profile?.codeWorkspace,
      }), REPLY_GENERATE_TIMEOUT_MS, '回复建议生成')
      this.ctx?.getLogService()?.warn('ReplyTile', 'AI 回复建议生成返回', {
        sessionId,
        targetKey,
        success: Boolean(result.suggestions?.length),
        suggestionCount: result.suggestions?.length || 0,
      })

      if ((this.generationSeq.get(sessionId) || 0) !== seq) {
        this.ctx?.getLogService()?.warn('ReplyTile', 'AI 返回后生成已失效', { sessionId, targetKey, seq, currentSeq: this.generationSeq.get(sessionId) })
        this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
        return
      }
      if (result.suggestions?.length) {
        if (options?.replace) {
          const replacement = result.suggestions[0]
          this.batches.set(sessionId, (this.batches.get(sessionId) || []).map((batch) => {
            if (batch.id !== options.replace!.batchId) return batch
            return {
              ...batch,
              suggestions: batch.suggestions.map((suggestion, index) => (
                index === options.replace!.suggestionIndex ? replacement : suggestion
              )),
            }
          }))
        } else {
          const batch: ReplyTileBatch = {
            id: `${targetKey}:${Date.now()}`,
            targetKey,
            quote,
            suggestions: result.suggestions,
          }
          this.batches.set(sessionId, [...(this.batches.get(sessionId) || []), batch])
        }
        this.emitState(sessionId, sessionName, 'ready')
      } else {
        this.emitState(sessionId, sessionName, this.batches.get(sessionId)?.length ? 'ready' : 'pending')
      }
    } catch (e) {
      if ((this.generationSeq.get(sessionId) || 0) === seq) {
        this.emitState(sessionId, sessionName, 'error', { error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      this.generating.delete(sessionId)
    }
  }

  private emitState(sessionId: string, sessionName: string, state: ReplyTileEntry['state'], extra: Partial<ReplyTileEntry> = {}): void {
    const batches = this.batches.get(sessionId) || []
    this.emit({
      sessionId,
      sessionName,
      avatarUrl: this.avatarOf(sessionId),
      state,
      suggestions: batches.flatMap((b) => b.suggestions),
      batches,
      pendingContinue: state !== 'loading' && this.pendingContinue.has(sessionId),
      ...extra,
    })
  }

  private emit(entry: ReplyTileEntry): void {
    this.ctx?.getWindowManager().updateReplyTileEntry(entry)
  }
}

export const replyTileService = new ReplyTileService()
