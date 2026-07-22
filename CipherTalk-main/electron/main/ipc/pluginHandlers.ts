/**
 * 插件系统 IPC（见 PLUGIN_SYSTEM_PLAN.md §3、§5）。
 *
 * - 管理通道：plugin:list / enable / disable / uninstall / 开发者模式
 * - 能力通道：单一 plugin:invoke + 方法路由表（权限校验、限流、limit 上限、超时）
 *
 * 主进程不执行插件代码，本文件只做校验与转发；数据查询实际在 wcdb utilityProcess 执行。
 */
import { clipboard, dialog, ipcMain, Notification } from 'electron'
import fs from 'fs'
import { chatService } from '../../services/chatService'
import { groupMetadataService } from '../../services/groupMetadataService'
import { imageDecryptService } from '../../services/imageDecryptService'
import { videoService } from '../../services/videoService'
import { sttRuntimeService } from '../../services/sttRuntimeService'
import { voiceTranscribeService } from '../../services/voiceTranscribeService'
import { chatSearchIndexService } from '../../services/search/chatSearchIndexService'
import { exportProcessService } from '../../services/exportProcessService'
import { issueMediaUrl } from '../../services/pluginMediaService'
import {
  pluginManagerService,
  type InstalledPlugin,
  type PluginPermission,
} from '../../services/pluginManagerService'
import type { Message } from '../../services/chat/types'
import type { ExportOptions } from '../../services/exportService'
import type { MainProcessContext } from '../context'

// ========= 防护参数（对应方案 §8「性能防护」） =========
const MAX_QUERY_LIMIT = 2000
const DEFAULT_QUERY_LIMIT = 500
const INVOKE_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_PER_PLUGIN = 2
const RATE_LIMIT_PER_SEC = 50
const MAX_STORAGE_VALUE_BYTES = 256 * 1024
const MAX_STORAGE_FILE_BYTES = 5 * 1024 * 1024

interface RateState { windowStart: number; count: number; running: number }
const rateStates = new Map<string, RateState>()

function checkAndAcquire(pluginId: string): { ok: boolean; error?: string } {
  let state = rateStates.get(pluginId)
  const now = Date.now()
  if (!state) {
    state = { windowStart: now, count: 0, running: 0 }
    rateStates.set(pluginId, state)
  }
  if (now - state.windowStart >= 1000) {
    state.windowStart = now
    state.count = 0
  }
  if (state.count >= RATE_LIMIT_PER_SEC) return { ok: false, error: '调用频率超限（50 次/秒）' }
  if (state.running >= MAX_CONCURRENT_PER_PLUGIN) return { ok: false, error: '并发调用超限（2 路）' }
  state.count += 1
  state.running += 1
  return { ok: true }
}

function release(pluginId: string): void {
  const state = rateStates.get(pluginId)
  if (state && state.running > 0) state.running -= 1
}

// AI 调用花的是用户自己的 API 额度，单独做更紧的预算：每插件 20 次/分钟
const AI_BUDGET_PER_MIN = 20
const aiBudgets = new Map<string, { windowStart: number; count: number }>()

function checkAiBudget(pluginId: string): void {
  const now = Date.now()
  let budget = aiBudgets.get(pluginId)
  if (!budget || now - budget.windowStart >= 60_000) {
    budget = { windowStart: now, count: 0 }
    aiBudgets.set(pluginId, budget)
  }
  if (budget.count >= AI_BUDGET_PER_MIN) {
    throw new Error('AI 调用超出预算（20 次/分钟），请合并请求')
  }
  budget.count += 1
}

// ========= 面向插件的裁剪结构（不透传内部完整行） =========

function toPluginMessage(m: Message) {
  return {
    localId: m.localId,
    serverId: m.serverId,
    type: m.localType,
    createTime: m.createTime,
    sortSeq: m.sortSeq,
    isSend: m.isSend === 1,
    senderUsername: m.senderUsername,
    content: m.parsedContent,
    imageMd5: m.imageMd5,
    videoDuration: m.videoDuration,
    voiceDuration: m.voiceDuration,
    fileName: m.fileName,
    fileSize: m.fileSize,
  }
}

type MessageCursor = { s: number; t: number; l: number }

function encodeCursor(c: MessageCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url')
}

function decodeCursor(raw: unknown): MessageCursor | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'))
    if (typeof c?.s !== 'number' || typeof c?.t !== 'number' || typeof c?.l !== 'number') return null
    return c
  } catch {
    return null
  }
}

function clampLimit(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUERY_LIMIT
  return Math.min(Math.floor(n), MAX_QUERY_LIMIT)
}

/**
 * messages.query：从最新消息向旧翻页的游标查询。
 * 过滤条件在本页内应用——一次调用最多扫描 limit 行，返回行数可能少于 limit，
 * 只要还有 nextCursor 就表示可以继续翻页（诚实游标语义，SDK 文档同步说明）。
 */
async function queryMessages(args: Record<string, unknown>) {
  const sessionId = String(args.sessionId || '')
  if (!sessionId) throw new Error('sessionId 必填')
  const limit = clampLimit(args.limit)
  const startTime = typeof args.startTime === 'number' ? args.startTime : undefined
  const endTime = typeof args.endTime === 'number' ? args.endTime : undefined
  const senderId = typeof args.senderId === 'string' && args.senderId ? args.senderId : undefined
  const keyword = typeof args.keyword === 'string' && args.keyword.trim() ? args.keyword.trim() : undefined

  const cursor = decodeCursor(args.cursor)
  const result = cursor
    ? await chatService.getMessagesBefore(sessionId, cursor.s, limit, cursor.t, cursor.l)
    : await chatService.getMessagesBefore(sessionId, Number.MAX_SAFE_INTEGER, limit)
  if (!result.success) throw new Error(result.error || '查询失败')

  const scanned = result.messages ?? []
  // getMessagesBefore 返回升序页；从旧到新扫，游标取本页最旧一条继续向更早翻
  const rows: ReturnType<typeof toPluginMessage>[] = []
  let stopPaging = false
  for (const m of scanned) {
    if (startTime !== undefined && m.createTime < startTime) continue
    if (endTime !== undefined && m.createTime > endTime) continue
    if (senderId !== undefined && m.senderUsername !== senderId) continue
    if (keyword !== undefined && !String(m.parsedContent || '').includes(keyword)) continue
    rows.push(toPluginMessage(m))
  }
  // 本页最旧一条已早于 startTime：更早的页全部超出范围，停止翻页
  if (startTime !== undefined && scanned.length > 0 && scanned[0].createTime < startTime) {
    stopPaging = true
  }

  const hasMore = !!result.hasMore && !stopPaging && scanned.length > 0
  const oldest = scanned[0]
  return {
    rows,
    nextCursor: hasMore
      ? encodeCursor({ s: Number(oldest.sortSeq || 0), t: Number(oldest.createTime || 0), l: Number(oldest.localId || 0) })
      : undefined,
  }
}

// ========= 插件私有 KV 存储 =========

function readStorage(pluginId: string): Record<string, unknown> {
  const file = pluginManagerService.getStorageFile(pluginId)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

function writeStorage(pluginId: string, data: Record<string, unknown>): void {
  const file = pluginManagerService.getStorageFile(pluginId)
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_STORAGE_FILE_BYTES) {
    throw new Error('插件存储超出 5MB 上限')
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, serialized, 'utf-8')
  fs.renameSync(tmp, file)
}

// ========= 方法路由表 =========

type ApiHandler = (plugin: InstalledPlugin, args: Record<string, unknown>) => Promise<unknown> | unknown

/** timeoutMs 缺省 10s；转写等长任务可放宽 */
const apiRegistry: Record<string, { permission: PluginPermission | null; handler: ApiHandler; timeoutMs?: number }> = {
  'data.sessions.list': {
    permission: 'sessions:read',
    handler: async (_p, args) => {
      const offset = Number(args.offset) || 0
      const limit = Math.min(Number(args.limit) || 200, MAX_QUERY_LIMIT)
      const result = await chatService.getSessions(offset, limit)
      if (!result.success) throw new Error(result.error || '获取会话失败')
      return {
        sessions: (result.sessions ?? []).map((s) => ({
          sessionId: s.username,
          type: s.type,
          displayName: s.displayName,
          summary: s.summary,
          lastTimestamp: s.lastTimestamp,
          avatarUrl: s.avatarUrl,
          isPinned: s.isPinned,
          isWeCom: s.isWeCom,
          isOfficialAccount: s.isOfficialAccount,
        })),
        hasMore: result.hasMore,
      }
    },
  },
  'data.contacts.list': {
    permission: 'contacts:read',
    handler: async (_p, args) => {
      const result = await chatService.getContacts()
      if (!result.success) throw new Error(result.error || '获取联系人失败')
      const offset = Number(args.offset) || 0
      const limit = Math.min(Number(args.limit) || 500, MAX_QUERY_LIMIT)
      const all = result.contacts ?? []
      return {
        contacts: all.slice(offset, offset + limit).map((c) => ({
          username: c.username,
          displayName: c.displayName,
          remark: c.remark,
          nickname: c.nickname,
          type: c.type,
          avatarUrl: c.avatarUrl,
        })),
        hasMore: offset + limit < all.length,
      }
    },
  },
  'data.contacts.get': {
    permission: 'contacts:read',
    handler: async (_p, args) => {
      const username = String(args.username || '')
      if (!username) throw new Error('username 必填')
      const contact = await chatService.getContact(username)
      if (!contact) return null
      return {
        username: contact.username,
        alias: contact.alias,
        remark: contact.remark,
        nickname: contact.nickName,
      }
    },
  },
  'data.contacts.getAvatar': {
    permission: 'contacts:read',
    handler: async (_p, args) => {
      const username = String(args.username || '')
      if (!username) throw new Error('username 必填')
      return chatService.getContactAvatar(username)
    },
  },
  'data.contacts.getGroupMembers': {
    permission: 'contacts:read',
    handler: async (_p, args) => {
      const chatroomId = String(args.chatroomId || '')
      if (!chatroomId) throw new Error('chatroomId 必填')
      return groupMetadataService.getGroupMembers(chatroomId)
    },
  },
  'data.messages.query': {
    permission: 'messages:read',
    handler: (_p, args) => queryMessages(args),
  },
  'data.messages.get': {
    permission: 'messages:read',
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const localId = Number(args.localId)
      if (!sessionId || !Number.isFinite(localId)) throw new Error('sessionId 与 localId 必填')
      const message = await chatService.getMessageByLocalId(sessionId, localId)
      return message ? toPluginMessage(message) : null
    },
  },
  'data.messages.getDatesWithMessages': {
    permission: 'messages:read',
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const year = Number(args.year)
      const month = Number(args.month)
      if (!sessionId || !Number.isFinite(year) || !Number.isFinite(month)) {
        throw new Error('sessionId、year、month 必填')
      }
      const result = await chatService.getDatesWithMessages(sessionId, year, month)
      if (!result.success) throw new Error(result.error || '查询失败')
      return result.dates ?? []
    },
  },
  'storage.get': {
    permission: null,
    handler: (plugin, args) => {
      const key = String(args.key || '')
      if (!key) throw new Error('key 必填')
      return readStorage(plugin.manifest.id)[key] ?? null
    },
  },
  'storage.set': {
    permission: null,
    handler: (plugin, args) => {
      const key = String(args.key || '')
      if (!key) throw new Error('key 必填')
      const serialized = JSON.stringify(args.value ?? null)
      if (Buffer.byteLength(serialized, 'utf-8') > MAX_STORAGE_VALUE_BYTES) {
        throw new Error('单个值超出 256KB 上限')
      }
      const data = readStorage(plugin.manifest.id)
      data[key] = args.value ?? null
      writeStorage(plugin.manifest.id, data)
      return true
    },
  },
  'storage.delete': {
    permission: null,
    handler: (plugin, args) => {
      const key = String(args.key || '')
      if (!key) throw new Error('key 必填')
      const data = readStorage(plugin.manifest.id)
      delete data[key]
      writeStorage(plugin.manifest.id, data)
      return true
    },
  },
  'clipboard.write': {
    permission: 'clipboard:write',
    handler: (_p, args) => {
      clipboard.writeText(String(args.text ?? ''))
      return true
    },
  },

  // ========= 二期：媒体（media:read） =========
  'media.getImage': {
    permission: 'media:read',
    timeoutMs: 30_000,
    handler: async (plugin, args) => {
      const result = await imageDecryptService.decryptImage({
        sessionId: args.sessionId ? String(args.sessionId) : undefined,
        imageMd5: args.imageMd5 ? String(args.imageMd5) : undefined,
        imageDatName: args.imageDatName ? String(args.imageDatName) : undefined,
        createTime: typeof args.createTime === 'number' ? args.createTime : undefined,
        quick: args.thumbnail === true,
      })
      if (!result.success || !result.localPath) throw new Error(result.error || '图片解密失败')
      return { url: issueMediaUrl(plugin.manifest.id, result.localPath), isThumb: !!result.isThumb }
    },
  },
  'media.getVoice': {
    permission: 'media:read',
    timeoutMs: 30_000,
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const localId = Number(args.localId)
      if (!sessionId || !Number.isFinite(localId)) throw new Error('sessionId 与 localId 必填')
      const result = await chatService.getVoiceData(
        sessionId,
        String(localId),
        typeof args.createTime === 'number' ? args.createTime : undefined,
        typeof args.serverId === 'number' ? args.serverId : undefined,
      )
      if (!result.success || !result.data) throw new Error(result.error || '语音读取失败')
      return { wavBase64: result.data }
    },
  },
  'media.getEmoji': {
    permission: 'media:read',
    timeoutMs: 30_000,
    handler: async (plugin, args) => {
      const sessionId = String(args.sessionId || '')
      const localId = Number(args.localId)
      if (!sessionId || !Number.isFinite(localId)) throw new Error('sessionId 与 localId 必填')
      const message = await chatService.getMessageByLocalId(sessionId, localId)
      if (!message) throw new Error('消息不存在')
      if (message.emojiLocalPath && fs.existsSync(message.emojiLocalPath)) {
        return { url: issueMediaUrl(plugin.manifest.id, message.emojiLocalPath) }
      }
      const result = await chatService.downloadEmoji(
        message.emojiCdnUrl || '',
        message.emojiMd5,
        message.productId,
        message.createTime,
      )
      const localPath = result.localPath || result.cachePath
      if (!result.success || !localPath) throw new Error(result.error || '表情获取失败')
      return { url: issueMediaUrl(plugin.manifest.id, localPath) }
    },
  },
  'media.getVideoInfo': {
    permission: 'media:read',
    timeoutMs: 30_000,
    handler: async (plugin, args) => {
      const videoMd5 = String(args.videoMd5 || '')
      if (!videoMd5) throw new Error('videoMd5 必填')
      const info = await videoService.getVideoInfo(videoMd5)
      return {
        exists: info.exists,
        url: info.videoUrl && fs.existsSync(info.videoUrl)
          ? issueMediaUrl(plugin.manifest.id, info.videoUrl)
          : undefined,
        coverUrl: info.coverUrl,
        thumbUrl: info.thumbUrl,
      }
    },
  },

  // ========= 二期：语音转写（stt:use） =========
  'stt.transcribe': {
    permission: 'stt:use',
    timeoutMs: 180_000,
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const localId = Number(args.localId)
      const createTime = Number(args.createTime)
      if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime)) {
        throw new Error('sessionId、localId、createTime 必填')
      }
      // 命中缓存直接返回，不重复转写（空结果也算命中，避免重复扣额度）
      if (args.force !== true && voiceTranscribeService.hasCachedTranscript(sessionId, createTime, localId)) {
        return { text: voiceTranscribeService.getCachedTranscript(sessionId, createTime, localId) ?? '', fromCache: true }
      }

      const voice = await chatService.getVoiceData(
        sessionId,
        String(localId),
        createTime,
        typeof args.serverId === 'number' ? args.serverId : undefined,
      )
      if (!voice.success || !voice.data) throw new Error(voice.error || '语音读取失败')
      const result = await sttRuntimeService.transcribeWavBuffer(Buffer.from(voice.data, 'base64'), {
        cache: { sessionId, createTime, localId, force: args.force === true },
      })
      if (result?.success === false) throw new Error(result.error || '转写失败')
      return { text: result?.transcript ?? '', fromCache: false }
    },
  },
  'stt.getCachedTranscript': {
    permission: 'stt:use',
    handler: (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const createTime = Number(args.createTime)
      const localId = Number(args.localId)
      if (!sessionId || !Number.isFinite(createTime)) throw new Error('sessionId、createTime 必填')
      return voiceTranscribeService.getCachedTranscript(
        sessionId,
        createTime,
        Number.isFinite(localId) ? localId : undefined,
      ) ?? null
    },
  },

  // ========= 二期：全文搜索（search:use） =========
  'search.query': {
    permission: 'search:use',
    timeoutMs: 60_000,
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const query = String(args.query || '').trim()
      if (!sessionId || !query) throw new Error('sessionId 与 query 必填')
      const result = await chatSearchIndexService.searchSession({
        sessionId,
        query,
        limit: Math.min(Number(args.limit) || 50, 200),
        matchMode: args.matchMode === 'exact' ? 'exact' : 'substring',
        startTimeMs: typeof args.startTime === 'number' ? args.startTime * 1000 : undefined,
        endTimeMs: typeof args.endTime === 'number' ? args.endTime * 1000 : undefined,
        senderUsername: args.senderId ? String(args.senderId) : undefined,
      })
      return {
        hits: result.hits.map((hit) => ({
          message: toPluginMessage(hit.message),
          excerpt: hit.excerpt,
          score: hit.score,
        })),
        indexComplete: result.indexComplete,
        truncated: result.truncated,
      }
    },
  },

  // ========= 二期：统计（stats:read） =========
  'stats.messageCounts': {
    permission: 'stats:read',
    timeoutMs: 15_000,
    handler: async (_p, args) => {
      const sessionId = String(args.sessionId || '')
      const groupBy = String(args.groupBy || 'day')
      if (!sessionId) throw new Error('sessionId 必填')
      if (!['day', 'month', 'sender'].includes(groupBy)) throw new Error('groupBy 须为 day/month/sender')
      const startTime = typeof args.startTime === 'number' ? args.startTime : undefined
      const endTime = typeof args.endTime === 'number' ? args.endTime : undefined

      const counts = new Map<string, number>()
      let cursor = Number.MAX_SAFE_INTEGER
      let cursorTime: number | undefined
      let cursorLocalId: number | undefined
      let scanned = 0
      let truncated = false
      const deadline = Date.now() + 8000
      const MAX_SCAN = 50_000

      while (true) {
        const page = await chatService.getMessagesBefore(sessionId, cursor, 2000, cursorTime, cursorLocalId)
        if (!page.success) throw new Error(page.error || '读取失败')
        const rows = page.messages ?? []
        if (rows.length === 0) break
        let stop = false
        for (const m of rows) {
          if (endTime !== undefined && m.createTime > endTime) continue
          if (startTime !== undefined && m.createTime < startTime) continue
          const date = new Date(m.createTime * 1000)
          const key = groupBy === 'sender'
            ? (m.isSend === 1 ? '__self__' : (m.senderUsername || '__unknown__'))
            : groupBy === 'month'
              ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
              : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          counts.set(key, (counts.get(key) || 0) + 1)
        }
        scanned += rows.length
        const oldest = rows[0]
        // 已扫过 startTime 之前的数据，更早的页全部超出范围
        if (startTime !== undefined && oldest.createTime < startTime) stop = true
        if (!page.hasMore || stop) break
        if (scanned >= MAX_SCAN || Date.now() > deadline) { truncated = true; break }
        cursor = Number(oldest.sortSeq || 0)
        cursorTime = Number(oldest.createTime || 0)
        cursorLocalId = Number(oldest.localId || 0)
      }

      return {
        counts: [...counts.entries()]
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        scanned,
        truncated,
      }
    },
  },

  // ========= 三期：朋友圈（sns:read） =========
  'sns.getTimeline': {
    permission: 'sns:read',
    timeoutMs: 30_000,
    handler: async (_p, args) => {
      const { snsService } = await import('../../services/snsService')
      const limit = Math.min(Number(args.limit) || 20, 100)
      const offset = Number(args.offset) || 0
      const usernames = Array.isArray(args.usernames) ? args.usernames.map(String).slice(0, 50) : undefined
      const result = await snsService.getTimeline(
        limit,
        offset,
        usernames,
        args.keyword ? String(args.keyword) : undefined,
        typeof args.startTime === 'number' ? args.startTime : undefined,
        typeof args.endTime === 'number' ? args.endTime : undefined,
      )
      if (!result.success) throw new Error(result.error || '朋友圈读取失败')
      // 裁剪结构：不透传解密密钥/token/rawXml，媒体只保留展示所需字段
      return {
        posts: (result.timeline ?? []).map((post) => ({
          id: post.id,
          username: post.username,
          nickname: post.nickname,
          createTime: post.createTime,
          content: post.contentDesc,
          type: post.type,
          media: (post.media ?? []).map((m) => ({
            url: m.url, thumbUrl: m.thumb, width: m.width, height: m.height,
          })),
          likes: post.likes ?? [],
          comments: (post.comments ?? []).map((c) => ({
            nickname: c.nickname, content: c.content, refNickname: c.refNickname,
          })),
        })),
        hasMore: (result.timeline ?? []).length >= limit,
      }
    },
  },

  // ========= 三期：AI 能力（ai:use，走宿主已配置的模型与 key，key 对插件不可见） =========
  'ai.complete': {
    permission: 'ai:use',
    timeoutMs: 120_000,
    handler: async (plugin, args) => {
      const prompt = String(args.prompt || '')
      if (!prompt.trim()) throw new Error('prompt 必填')
      if (prompt.length > 32_000) throw new Error('prompt 超出 32k 字符上限')
      const system = args.system ? String(args.system).slice(0, 8_000) : undefined

      checkAiBudget(plugin.manifest.id)
      const [{ generateText }, { resolveProviderConfig }, { createLanguageModel }] = await Promise.all([
        import('ai'),
        import('../../services/agent/resolveProviderConfig'),
        import('../../services/agent/provider'),
      ])
      const providerConfig = resolveProviderConfig()
      const result = await generateText({
        model: createLanguageModel(providerConfig),
        system,
        prompt,
      })
      return { text: result.text }
    },
  },
  'ai.embed': {
    permission: 'ai:use',
    timeoutMs: 60_000,
    handler: async (plugin, args) => {
      const texts = Array.isArray(args.texts) ? args.texts.map(String) : []
      if (texts.length === 0) throw new Error('texts 必填')
      if (texts.length > 64) throw new Error('单次最多 64 条')
      if (texts.some((t) => t.length > 8_000)) throw new Error('单条文本超出 8k 字符上限')

      checkAiBudget(plugin.manifest.id)
      const { embedTexts } = await import('../../services/ai/embeddingService')
      return { embeddings: await embedTexts(texts) }
    },
  },

  // ========= 二期：系统通知（notify:send） =========
  'notify.send': {
    permission: 'notify:send',
    handler: (plugin, args) => {
      new Notification({
        title: String(args.title || plugin.manifest.name),
        body: String(args.body || ''),
      }).show()
      return true
    },
  },
  /** 宿主支持的方法集，供 SDK 做能力探测与优雅降级 */
  'host.capabilities': {
    permission: null,
    handler: () => Object.keys(apiRegistry),
  },
}

function serializePlugin(plugin: InstalledPlugin) {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    author: plugin.manifest.author ?? { name: '未知' },
    permissions: plugin.manifest.permissions ?? [],
    contributes: plugin.manifest.contributes ?? {},
    isDev: plugin.isDev,
    enabled: plugin.enabled,
    grantedPermissions: plugin.grantedPermissions,
    error: plugin.error,
  }
}

export function registerPluginHandlers(ctx: MainProcessContext): void {
  // 新消息事件桥：宿主实时变更走 chatService 'dbChange'（monitorBridge 推送），
  // 但 dbChange 只带 table、不带具体会话，需对比会话快照才能定位「哪个会话来新消息」。
  // 与 notifyService 同款判定（时间线前进 + 有未读），再广播 newMessages{sessionId,count}，
  // PluginHost 按 messages:read 权限过滤后转发进 iframe。
  const sessionSnapshot = new Map<string, { lastTs: number; unread: number }>()
  let newMsgTimer: NodeJS.Timeout | null = null
  let checkingNewMsg = false

  const anyPluginWantsMessages = () =>
    pluginManagerService.list().some((p) => p.enabled && p.grantedPermissions.includes('messages:read'))

  const checkNewMessagesForPlugins = async () => {
    if (checkingNewMsg) return
    checkingNewMsg = true
    try {
      const result = await chatService.getSessions(0, 200)
      if (!result.success || !Array.isArray(result.sessions)) return
      for (const s of result.sessions) {
        const sessionId = String(s.username || '')
        if (!sessionId) continue
        const cur = {
          lastTs: Number(s.lastTimestamp || s.sortTimestamp || 0),
          unread: Number(s.unreadCount || 0),
        }
        const prev = sessionSnapshot.get(sessionId)
        sessionSnapshot.set(sessionId, cur)
        if (!prev) continue // 首轮播种：不补广播历史
        if (cur.lastTs <= prev.lastTs || cur.unread <= 0) continue
        ctx.broadcastToWindows('plugin:event', {
          pluginId: null,
          requiredPermission: 'messages:read',
          event: 'newMessages',
          payload: { sessionId, count: cur.unread },
        })
      }
    } catch (e) {
      ctx.getLogService()?.warn('Plugin', 'newMessages 检查失败', { error: String(e) })
    } finally {
      checkingNewMsg = false
    }
  }

  chatService.on('dbChange', (payload: { table?: string }) => {
    const table = String(payload?.table || '')
    if (table !== 'Message' && table !== 'Session') return
    if (!anyPluginWantsMessages()) return // 没有插件订阅：零开销
    if (newMsgTimer) clearTimeout(newMsgTimer)
    newMsgTimer = setTimeout(() => { newMsgTimer = null; void checkNewMessagesForPlugins() }, 500)
  })

  // ========= 二期：导出（export:use，异步任务 + 事件回报进度） =========
  const EXPORT_EXTENSIONS: Record<string, string> = {
    json: 'json', html: 'html', txt: 'txt', excel: 'xlsx', sql: 'sql',
    chatlab: 'json', 'chatlab-jsonl': 'jsonl',
  }
  apiRegistry['export.exportSession'] = {
    permission: 'export:use',
    timeoutMs: 60_000,
    handler: async (plugin, args) => {
      const sessionId = String(args.sessionId || '')
      const format = String(args.format || 'html')
      if (!sessionId) throw new Error('sessionId 必填')
      if (!EXPORT_EXTENSIONS[format]) throw new Error(`不支持的格式：${format}`)

      // 输出位置始终由用户在系统对话框里确认，插件不能指定任意路径
      const win = ctx.getMainWindow()
      const defaultName = `${sessionId}-${new Date().toISOString().slice(0, 10)}.${EXPORT_EXTENSIONS[format]}`
      const picked = win
        ? await dialog.showSaveDialog(win, { title: `导出会话（${plugin.manifest.name}）`, defaultPath: defaultName })
        : await dialog.showSaveDialog({ title: `导出会话（${plugin.manifest.name}）`, defaultPath: defaultName })
      if (picked.canceled || !picked.filePath) return { canceled: true }

      const taskId = `plugin-${plugin.manifest.id}-${Date.now()}`
      const options: ExportOptions = {
        format: format as ExportOptions['format'],
        dateRange: typeof args.startTime === 'number' && typeof args.endTime === 'number'
          ? { start: args.startTime, end: args.endTime }
          : null,
      }
      const pluginId = plugin.manifest.id
      void exportProcessService
        .exportSession(taskId, sessionId, picked.filePath, options, (progress) => {
          ctx.broadcastToWindows('plugin:event', {
            pluginId, event: 'exportProgress', payload: { taskId, ...progress },
          })
        })
        .then((result) => {
          ctx.broadcastToWindows('plugin:event', {
            pluginId, event: 'exportDone', payload: { taskId, ...result, outputPath: picked.filePath },
          })
        })
        .catch((error) => {
          ctx.broadcastToWindows('plugin:event', {
            pluginId, event: 'exportDone', payload: { taskId, success: false, error: String(error) },
          })
        })
      return { taskId, outputPath: picked.filePath }
    },
  }

  // 依赖主进程上下文的方法在此注入
  apiRegistry['window.open'] = {
    permission: 'window:create',
    handler: (plugin, args) => {
      const viewId = String(args.viewId || '')
      if (!pluginManagerService.getViewUrl(plugin.manifest.id, viewId)) {
        throw new Error(`视图不存在：${viewId}`)
      }
      ctx.getWindowManager().openPluginWindow(plugin.manifest.id, viewId, {
        width: Number(args.width) || undefined,
        height: Number(args.height) || undefined,
        title: plugin.manifest.name,
      })
      return true
    },
  }

  ipcMain.handle('plugin:list', () => ({
    plugins: pluginManagerService.list().map(serializePlugin),
    devModeEnabled: pluginManagerService.getDevModeEnabled(),
  }))

  ipcMain.handle('plugin:enable', (_, id: string) => pluginManagerService.enable(String(id)))
  ipcMain.handle('plugin:disable', (_, id: string) => pluginManagerService.disable(String(id)))
  ipcMain.handle('plugin:uninstall', (_, id: string) => pluginManagerService.uninstall(String(id)))
  ipcMain.handle('plugin:rescan', () => { pluginManagerService.rescan(); return { success: true } })
  ipcMain.handle('plugin:setDevMode', (_, enabled: boolean) => {
    pluginManagerService.setDevModeEnabled(!!enabled)
    return { success: true }
  })
  ipcMain.handle('plugin:addDevPlugin', (_, dir: string) => pluginManagerService.addDevPlugin(String(dir)))
  ipcMain.handle('plugin:installFromFile', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择插件安装包',
      properties: ['openFile'],
      filters: [{ name: 'CipherTalk 插件', extensions: ['ctp', 'ctplugin', 'zip'] }],
    })
    const zipPath = picked.filePaths[0]
    if (picked.canceled || !zipPath) return { success: false, canceled: true }
    return pluginManagerService.installFromZip(zipPath)
  })
  ipcMain.handle('plugin:getViewUrl', (_, pluginId: string, viewId: string) => {
    return pluginManagerService.getViewUrl(String(pluginId), String(viewId))
  })

  ipcMain.handle('plugin:invoke', async (_, pluginId: string, method: string, args?: Record<string, unknown>) => {
    const id = String(pluginId || '')
    const plugin = pluginManagerService.get(id)
    if (!plugin || !plugin.enabled) {
      return { success: false, error: '插件未启用' }
    }
    const entry = apiRegistry[String(method)]
    if (!entry) {
      return { success: false, error: `未知方法：${String(method)}` }
    }
    if (entry.permission && !pluginManagerService.hasPermission(id, entry.permission)) {
      return { success: false, error: `缺少权限：${entry.permission}` }
    }

    const acquired = checkAndAcquire(id)
    if (!acquired.ok) return { success: false, error: acquired.error }

    try {
      const timeoutMs = entry.timeoutMs ?? INVOKE_TIMEOUT_MS
      const data = await Promise.race([
        Promise.resolve(entry.handler(plugin, args ?? {})),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`调用超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
        ),
      ])
      return { success: true, data }
    } catch (error) {
      ctx.getLogService()?.warn('Plugin', 'plugin:invoke 失败', {
        pluginId: id, method, error: String(error),
      })
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      release(id)
    }
  })
}
