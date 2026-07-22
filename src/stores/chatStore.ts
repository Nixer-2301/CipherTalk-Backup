import { create } from 'zustand'
import type { ChatSession, Message, Contact } from '../types/models'

const SESSION_MESSAGE_CACHE_LIMIT = 20
const SESSION_MESSAGE_CACHE_MAX_MESSAGES = 300
export const MAX_ACTIVE_MESSAGES = 300

export interface SessionMessageCacheEntry {
  messages: Message[]
  hasMoreMessages: boolean
  currentOffset: number
  loadedAt: number
  scrollTop?: number
  scrollHeight?: number
}

type SessionMessageCachePayload = Omit<SessionMessageCacheEntry, 'loadedAt'> & {
  loadedAt?: number
}

function messageKey(message: Message): string {
  return `${message.serverId}-${message.localId}-${message.createTime}-${message.sortSeq}`
}

function sortMessagesAsc(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const aSortSeq = Number(a.sortSeq || 0)
    const bSortSeq = Number(b.sortSeq || 0)
    if (aSortSeq > 0 && bSortSeq > 0 && aSortSeq !== bSortSeq) {
      return aSortSeq - bSortSeq
    }
    return Number(a.createTime || 0) - Number(b.createTime || 0) ||
      Number(a.localId || 0) - Number(b.localId || 0) ||
      aSortSeq - bSortSeq
  })
}

export interface ChatState {
  // 连接状态
  isConnected: boolean
  isConnecting: boolean
  connectionError: string | null

  // 会话列表
  sessions: ChatSession[]
  filteredSessions: ChatSession[]
  currentSessionId: string | null
  isLoadingSessions: boolean

  // 消息
  messages: Message[]
  isLoadingMessages: boolean
  isLoadingMore: boolean
  hasMoreMessages: boolean
  sessionMessageCache: Map<string, SessionMessageCacheEntry>

  // 联系人缓存
  contacts: Map<string, Contact>

  // 搜索
  searchKeyword: string

  // 同步版本 (用于触发 UI 增量检查)
  syncVersion: number

  // 操作
  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setConnectionError: (error: string | null) => void
  setSessions: (sessions: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) => void
  setFilteredSessions: (sessions: ChatSession[]) => void
  setCurrentSession: (sessionId: string | null) => void
  setLoadingSessions: (loading: boolean) => void
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void
  appendMessages: (messages: Message[], prepend?: boolean) => void
  setLoadingMessages: (loading: boolean) => void
  setLoadingMore: (loading: boolean) => void
  setHasMoreMessages: (hasMore: boolean) => void
  saveSessionMessageCache: (sessionId: string, cache: SessionMessageCachePayload) => void
  restoreSessionMessageCache: (sessionId: string) => SessionMessageCacheEntry | null
  clearSessionMessageCache: (sessionId?: string) => void
  setContacts: (contacts: Contact[]) => void
  addContact: (contact: Contact) => void
  setSearchKeyword: (keyword: string) => void
  incrementSyncVersion: () => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  isConnected: false,
  isConnecting: false,
  connectionError: null,
  sessions: [],
  filteredSessions: [],
  currentSessionId: null,
  isLoadingSessions: false,
  messages: [],
  isLoadingMessages: false,
  isLoadingMore: false,
  hasMoreMessages: true,
  sessionMessageCache: new Map(),
  contacts: new Map(),
  searchKeyword: '',
  syncVersion: 0,

  setConnected: (connected) => set({ isConnected: connected }),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setConnectionError: (error) => set({ connectionError: error }),

  setSessions: (sessions) => set((state) => {
    const newSessions = typeof sessions === 'function' ? sessions(state.sessions) : sessions
    // 搜索进行中不覆盖 filteredSessions，避免后台刷新冲掉搜索结果
    if (state.searchKeyword.trim()) {
      return { sessions: newSessions }
    }
    return { sessions: newSessions, filteredSessions: newSessions }
  }),
  setFilteredSessions: (sessions) => set({ filteredSessions: sessions }),

  setCurrentSession: (sessionId) => set({
    currentSessionId: sessionId,
    messages: [],
    hasMoreMessages: true
  }),

  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  setMessages: (messages) => set((state) => ({
    messages: sortMessagesAsc(typeof messages === 'function' ? messages(state.messages) : messages)
  })),

  appendMessages: (newMessages, prepend = false) => set((state) => {
    // 使用与后端一致的多维 Key (serverId + localId + createTime + sortSeq) 进行去重
    const existingKeys = new Set(
      state.messages.map(messageKey)
    )

    // 过滤掉已存在的消息
    const uniqueNewMessages = newMessages.filter(
      msg => !existingKeys.has(messageKey(msg))
    )

    // 如果没有新消息，直接返回原状态
    if (uniqueNewMessages.length === 0) {
      return state
    }

    const merged = sortMessagesAsc([...state.messages, ...uniqueNewMessages])

    // 滑动窗口：超出上限时裁剪
    if (merged.length > MAX_ACTIVE_MESSAGES) {
      return {
        // 加载旧消息(prepend)：保留最旧的，裁掉最新端
        // 加载新消息(append)：保留最新的，裁掉最旧端
        messages: prepend
          ? merged.slice(0, MAX_ACTIVE_MESSAGES)
          : merged.slice(merged.length - MAX_ACTIVE_MESSAGES)
      }
    }

    return { messages: merged }
  }),

  setLoadingMessages: (loading) => set({ isLoadingMessages: loading }),
  setLoadingMore: (loading) => set({ isLoadingMore: loading }),
  setHasMoreMessages: (hasMore) => set({ hasMoreMessages: hasMore }),

  saveSessionMessageCache: (sessionId, cache) => {
    if (!sessionId) return
    set((state) => {
      const messages = sortMessagesAsc(cache.messages).slice(-SESSION_MESSAGE_CACHE_MAX_MESSAGES)
      const next = new Map(state.sessionMessageCache)
      next.delete(sessionId)
      next.set(sessionId, {
        messages,
        hasMoreMessages: cache.hasMoreMessages,
        currentOffset: Math.max(cache.currentOffset, messages.length),
        loadedAt: cache.loadedAt ?? Date.now(),
        scrollTop: cache.scrollTop,
        scrollHeight: cache.scrollHeight
      })

      while (next.size > SESSION_MESSAGE_CACHE_LIMIT) {
        const oldestKey = next.keys().next().value
        if (!oldestKey) break
        next.delete(oldestKey)
      }

      return { sessionMessageCache: next }
    })
  },

  restoreSessionMessageCache: (sessionId) => {
    const cached = get().sessionMessageCache.get(sessionId)
    if (!cached) return null

    const restored: SessionMessageCacheEntry = {
      ...cached,
      messages: [...cached.messages],
      loadedAt: Date.now()
    }

    set((state) => {
      const next = new Map(state.sessionMessageCache)
      next.delete(sessionId)
      next.set(sessionId, restored)
      return {
        sessionMessageCache: next,
        messages: restored.messages,
        hasMoreMessages: restored.hasMoreMessages,
        isLoadingMessages: false,
        isLoadingMore: false
      }
    })

    return restored
  },

  clearSessionMessageCache: (sessionId) => set((state) => {
    if (!sessionId) {
      return { sessionMessageCache: new Map() }
    }

    if (!state.sessionMessageCache.has(sessionId)) return state
    const next = new Map(state.sessionMessageCache)
    next.delete(sessionId)
    return { sessionMessageCache: next }
  }),

  setContacts: (contacts) => set({
    contacts: new Map(contacts.map(c => [c.username, c]))
  }),

  addContact: (contact) => set((state) => {
    const newContacts = new Map(state.contacts)
    newContacts.set(contact.username, contact)
    return { contacts: newContacts }
  }),

  setSearchKeyword: (keyword) => set({ searchKeyword: keyword }),

  incrementSyncVersion: () => set((state) => ({ syncVersion: state.syncVersion + 1 })),

  reset: () => set({
    isConnected: false,
    isConnecting: false,
    connectionError: null,
    sessions: [],
    filteredSessions: [],
    currentSessionId: null,
    isLoadingSessions: false,
    messages: [],
    isLoadingMessages: false,
    isLoadingMore: false,
    hasMoreMessages: true,
    sessionMessageCache: new Map(),
    contacts: new Map(),
    searchKeyword: ''
  })
}))
