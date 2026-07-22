import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@heroui/react'
import { Comment, Picture, Xmark } from '@gravity-ui/icons'
import { useChatStore, MAX_ACTIVE_MESSAGES } from '../../stores/chatStore'
import { useUpdateStatusStore } from '../../stores/updateStatusStore'
import ChatBackground from '../../components/ChatBackground'
import { parseDateValue } from '../../components/AppDatePicker'
import TitleBar from '../../components/TitleBar'
import { getImageXorKey, getImageAesKey, getQuoteStyle, type QuoteStyleConfig } from '../../services/config'
import type { ChatSession, Message } from '../../types/models'
import { BatchDecryptModal } from './components/BatchDecryptModal'
import { BatchTranscribeModal } from './components/BatchTranscribeModal'
import { ChatHeader } from './components/ChatHeader'
import { MessageListVirtual } from './components/MessageListVirtual'
import { ReplySuggestBar } from './components/ReplySuggestBar'
import { SessionSidebar } from './components/SessionSidebar'
import { ContextMenuPortal } from './components/portals/ContextMenuPortal'
import { EnlargeViewModal } from './components/portals/EnlargeViewModal'
import { MessageInfoModal } from './components/portals/MessageInfoModal'
import { setLastIncrementalUpdateTime } from './components/messageBubble/mediaState'
import { useContextMenuState } from './hooks/useContextMenuState'
import { useSidebarResize } from './hooks/useSidebarResize'
import { useThrottledScroll } from './hooks/useThrottledScroll'
import { useTopToast } from './hooks/useTopToast'
import type { BatchImageMessage } from './types'
import { isReplySuggestSession } from './replySuggest'
import { checkOnlineSttConfigReady } from './utils/sttConfig'
import { formatSessionTime } from './utils/time'

interface ChatPageProps {
  // 保留接口以备将来扩展
}

function getMessageCacheKey(message: Message): string {
  return `${message.serverId}-${message.localId}-${message.createTime}-${message.sortSeq}`
}

// 历史分页大小：初次进会话用较大值铺满屏幕；滚动"加载更多"用较小值，
// 减小单次 prepend 的渲染阻塞（一次性 mount 50 条约卡 180ms，25 条约减半）。
const INITIAL_PAGE_SIZE = 50
const HISTORY_PAGE_SIZE = 25
const IMAGE_PREWARM_LIMIT = 40
// 会话列表分页大小（后端按原始行分页，最多单次 1000）
const SESSION_PAGE_SIZE = 300

// 刷新会话列表的合并：新页按后端顺序作为头部（保留未变化对象引用避免闪烁），
// 之前滚动分页加载出的更早会话保留在尾部，不因刷新只覆盖首个区间而丢失
function mergeRefreshedSessions(prev: ChatSession[], page: ChatSession[]): ChatSession[] {
  if (prev.length === 0) return page

  const prevMap = new Map(prev.map(s => [s.username, s]))
  const head = page.map(newSession => {
    const oldSession = prevMap.get(newSession.username)
    if (!oldSession) return newSession
    const hasChanges =
      oldSession.summary !== newSession.summary ||
      oldSession.lastTimestamp !== newSession.lastTimestamp ||
      oldSession.unreadCount !== newSession.unreadCount ||
      oldSession.displayName !== newSession.displayName ||
      oldSession.avatarUrl !== newSession.avatarUrl
    return hasChanges ? newSession : oldSession
  })

  const inPage = new Set(page.map(s => s.username))
  const tail = prev.filter(s => !inPage.has(s.username))
  return tail.length > 0 ? [...head, ...tail] : head
}

type ImagePrewarmPayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

function buildImagePrewarmPayloads(messages: Message[], sessionId: string, limit = IMAGE_PREWARM_LIMIT): ImagePrewarmPayload[] {
  const payloads: ImagePrewarmPayload[] = []
  const seen = new Set<string>()

  const addPayload = (payload: ImagePrewarmPayload) => {
    const imageKey = payload.imageMd5 || payload.imageDatName
    if (!imageKey) return
    const dedupeKey = [
      payload.sessionId || '',
      imageKey,
      payload.imageDatName || '',
      payload.createTime || 0
    ].join('|')
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    payloads.push(payload)
  }

  for (let i = messages.length - 1; i >= 0 && payloads.length < limit; i -= 1) {
    const message = messages[i]
    if (message.localType === 3 && (message.imageMd5 || message.imageDatName)) {
      addPayload({
        sessionId,
        imageMd5: message.imageMd5 || undefined,
        imageDatName: message.imageDatName || undefined,
        createTime: message.createTime
      })
    }

    if (message.quotedImageMd5) {
      addPayload({
        sessionId,
        imageMd5: message.quotedImageMd5,
        createTime: message.createTime
      })
    }
  }

  return payloads
}

function ChatPage(_props: ChatPageProps) {
  const [quoteStyle, setQuoteStyle] = useState<QuoteStyleConfig>('default')

  const refreshQuoteStyle = useCallback(() => {
    getQuoteStyle()
      .then(setQuoteStyle)
      .catch(console.error)
  }, [])

  useEffect(() => {
    refreshQuoteStyle()

    const removeConfigListener = window.electronAPI.config.onChanged((payload) => {
      if (payload.key === 'quoteStyle') refreshQuoteStyle()
    })

    const handleFocus = () => refreshQuoteStyle()
    const handleVisibilityChange = () => {
      if (!document.hidden) refreshQuoteStyle()
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      removeConfigListener()
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refreshQuoteStyle])

  const {
    isConnected,
    isConnecting,
    connectionError,
    sessions,
    filteredSessions,
    currentSessionId,
    isLoadingSessions,
    messages,
    isLoadingMessages,
    isLoadingMore,
    hasMoreMessages,
    searchKeyword,
    setConnected,
    setConnecting,
    setConnectionError,
    setSessions,
    setFilteredSessions,
    setCurrentSession,
    setLoadingSessions,
    setMessages,
    appendMessages,
    setLoadingMessages,
    setLoadingMore,
    setHasMoreMessages,
    saveSessionMessageCache,
    restoreSessionMessageCache,
    clearSessionMessageCache,
    setSearchKeyword,
    incrementSyncVersion
  } = useChatStore()

  const messageListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Message[]>([])
  const imagePrewarmSignatureRef = useRef('')
  const isLoadingMoreRef = useRef(false)
  const scrollToBottomAfterRenderRef = useRef(false)
  // 虚拟列表滚动信号：ChatPage 表达"该置底/置顶"的意图，递增令 MessageListVirtual 用 scrollToIndex 落点
  const [vlistBottomSignal, setVlistBottomSignal] = useState(0)
  const [vlistTopSignal, setVlistTopSignal] = useState(0)
  const currentSessionIdRef = useRef<string | null>(null)
  const messageLoadSeqRef = useRef(0)
  const lastUpdateTimeRef = useRef<number>(0)
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null)
  const updateStatusTimerRef = useRef<NodeJS.Timeout | null>(null)
  const wcdbChangeTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isUserOperatingRef = useRef<boolean>(false) // 标记用户是否正在操作
  const [currentOffset, setCurrentOffset] = useState(0)
  const [isDateJumpMode, setIsDateJumpMode] = useState(false)
  const currentOffsetRef = useRef(0)
  const hasMoreMessagesRef = useRef(true)
  // 会话列表分页：offset 按后端原始行推进（后端返回前会过滤，前端条数 < 原始行数）
  const sessionRawOffsetRef = useRef(0)
  const hasMoreSessionsRef = useRef(true)
  const loadingMoreSessionsRef = useRef(false)
  // 会话搜索：防抖定时器 + 过期结果丢弃序号
  const searchSeqRef = useRef(0)
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isDateJumpModeRef = useRef(false)
  // 向上滑动游标（最早消息）
  const [dateJumpCursorSortSeq, setDateJumpCursorSortSeq] = useState<number | null>(null)
  const [dateJumpCursorCreateTime, setDateJumpCursorCreateTime] = useState<number | null>(null)
  const [dateJumpCursorLocalId, setDateJumpCursorLocalId] = useState<number | null>(null)
  // 向下滑动游标（最新消息）
  const [dateJumpCursorSortSeqEnd, setDateJumpCursorSortSeqEnd] = useState<number | null>(null)
  const [dateJumpCursorCreateTimeEnd, setDateJumpCursorCreateTimeEnd] = useState<number | null>(null)
  const [dateJumpCursorLocalIdEnd, setDateJumpCursorLocalIdEnd] = useState<number | null>(null)
  const [hasMoreMessagesAfter, setHasMoreMessagesAfter] = useState(false)

  // 更新状态管理
  const setIsUpdating = useUpdateStatusStore(state => state.setIsUpdating)
  const isUpdating = useUpdateStatusStore(state => state.isUpdating)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  // showScrollToBottom 由 useThrottledScroll hook 管理
  const { sidebarWidth, isResizing, handleResizeStart } = useSidebarResize(260)
  const [hasImageKey, setHasImageKey] = useState<boolean | null>(null)
  const {
    contextMenu,
    setContextMenu,
    closeContextMenu
  } = useContextMenuState()
  const [selectedMessages, setSelectedMessages] = useState<Set<number>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [showEnlargeView, setShowEnlargeView] = useState<{ message: Message; content: string } | null>(null)
  const { showTopToast } = useTopToast()
  const [showMessageInfo, setShowMessageInfo] = useState<Message | null>(null) // 消息信息弹窗
  const [selectedDate, setSelectedDate] = useState<string>('') // 选中的日期 (YYYY-MM-DD)
  const [isJumpingToDate, setIsJumpingToDate] = useState(false) // 正在跳转
  
  // 批量语音转文字相关状态
  const [isBatchTranscribing, setIsBatchTranscribing] = useState(false)
  const [isExportingVoiceSample, setIsExportingVoiceSample] = useState(false)
  const [batchTranscribeProgress, setBatchTranscribeProgress] = useState({ current: 0, total: 0 })
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchVoiceCount, setBatchVoiceCount] = useState(0) // 保存查询到的语音消息数量
  const [batchVoiceMessages, setBatchVoiceMessages] = useState<Message[] | null>(null) // 当前会话所有语音消息（用于按日期筛选）
  const [batchVoiceDates, setBatchVoiceDates] = useState<string[]>([]) // 有语音的日期列表 YYYY-MM-DD，仅展示可选项
  const [batchSelectedDates, setBatchSelectedDates] = useState<Set<string>>(new Set()) // 用户选中的要转写的日期
  const [showBatchProgress, setShowBatchProgress] = useState(false) // 显示进度对话框
  const [showBatchResult, setShowBatchResult] = useState(false) // 显示结果对话框
  const [batchResult, setBatchResult] = useState({ success: 0, fail: 0 }) // 转写结果

  // 批量解密图片相关状态
  const [isBatchDecrypting, setIsBatchDecrypting] = useState(false)
  const [batchDecryptProgress, setBatchDecryptProgress] = useState({ current: 0, total: 0 })
  const [showBatchDecryptProgress, setShowBatchDecryptProgress] = useState(false)
  const [showBatchDecryptConfirm, setShowBatchDecryptConfirm] = useState(false)
  const [batchImageMessages, setBatchImageMessages] = useState<BatchImageMessage[] | null>(null)
  const [batchImageDates, setBatchImageDates] = useState<string[]>([])
  const [batchImageSelectedDates, setBatchImageSelectedDates] = useState<Set<string>>(new Set())

  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMore])

  const saveCurrentSessionMessageCache = useCallback((sessionId: string | null = currentSessionIdRef.current) => {
    if (!sessionId || isDateJumpModeRef.current) return
    const cachedMessages = messagesRef.current
    if (cachedMessages.length === 0) return

    const listEl = messageListRef.current
    saveSessionMessageCache(sessionId, {
      messages: cachedMessages,
      hasMoreMessages: hasMoreMessagesRef.current,
      currentOffset: currentOffsetRef.current,
      scrollTop: listEl?.scrollTop,
      scrollHeight: listEl?.scrollHeight
    })
  }, [saveSessionMessageCache])

  const enterSelectMode = useCallback((localId: number) => {
    setSelectMode(true)
    setSelectedMessages(new Set([localId]))
  }, [])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedMessages(new Set())
  }, [])

  const toggleSelectMessage = useCallback((localId: number) => {
    setSelectedMessages(prev => {
      const next = new Set(prev)
      if (next.has(localId)) next.delete(localId)
      else next.add(localId)
      return next
    })
  }, [])

  // 切换会话时退出多选模式
  useEffect(() => {
    setSelectMode(false)
    setSelectedMessages(new Set())
  }, [currentSessionId])

  const posterMessages = useMemo(
    () => messages.filter(m => selectedMessages.has(m.localId)),
    [messages, selectedMessages]
  )

  const openPosterWindow = useCallback(async () => {
    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      showTopToast('当前会话不存在', false)
      return
    }
    if (posterMessages.length === 0) {
      showTopToast('请先选择消息', false)
      return
    }
    try {
      const savedThemeId = await window.electronAPI.config.get('posterThemeId')
      await window.electronAPI.config.set('posterStyleWindowContext', {
        session,
        messages: posterMessages,
        myAvatarUrl,
        themeId: typeof savedThemeId === 'string' ? savedThemeId : '',
        updatedAt: Date.now()
      })
      await window.electronAPI.window.openPosterStyleWindow()
      exitSelectMode()
    } catch (error) {
      console.error('[ChatPage] 打开海报窗口失败', error)
      showTopToast('打开海报窗口失败', false)
    }
  }, [currentSessionId, exitSelectMode, myAvatarUrl, posterMessages, sessions, showTopToast])

  const exportVoiceMessage = useCallback(async (message: Message, session: ChatSession) => {
    try {
      const voiceResult = await window.electronAPI.chat.getVoiceData(
        session.username,
        String(message.localId),
        message.createTime,
        message.serverId
      )

      if (!voiceResult.success || !voiceResult.data) {
        alert(voiceResult.error || '获取语音数据失败')
        return
      }

      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const safeSessionName = String(session.displayName || session.username || 'voice')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'voice'
      const timestamp = new Date(message.createTime * 1000)
      const pad = (value: number) => String(value).padStart(2, '0')
      const fileName = `${safeSessionName}_${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}_${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}_${message.localId}.wav`

      const saveResult = await window.electronAPI.dialog.saveFile({
        title: '导出语音文件',
        defaultPath: `${downloadsPath}${window.navigator.platform.toLowerCase().includes('win') ? '\\' : '/'}${fileName}`,
        filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
      })

      if (saveResult.canceled || !saveResult.filePath) {
        return
      }

      const writeResult = await window.electronAPI.file.writeBase64(saveResult.filePath, voiceResult.data)
      if (!writeResult.success) {
        alert(writeResult.error || '导出语音文件失败')
        return
      }

      showTopToast('语音文件导出成功', true)
    } catch (e) {
      showTopToast(`导出语音文件失败: ${String(e)}`, false)
    }
  }, [showTopToast])

  const exportVoiceCloneSample = useCallback(async () => {
    if (!currentSessionId || isExportingVoiceSample) return

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      showTopToast('当前会话不存在', false)
      return
    }

    setIsExportingVoiceSample(true)
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const safeSessionName = String(session.displayName || session.username || 'voice_clone_sample')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'voice_clone_sample'
      const timestamp = new Date()
      const pad = (value: number) => String(value).padStart(2, '0')
      const fileName = `${safeSessionName}_复刻语音样本_${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}_${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}.wav`

      const saveResult = await window.electronAPI.dialog.saveFile({
        title: '导出复刻语音样本',
        defaultPath: `${downloadsPath}\\${fileName}`,
        filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
      })

      if (saveResult.canceled || !saveResult.filePath) {
        return
      }

      const result = await window.electronAPI.persona.exportVoiceSample({
        sessionId: session.username,
        displayName: session.displayName || session.username,
        outputPath: saveResult.filePath
      })

      if (!result.success) {
        showTopToast(result.error || '导出复刻语音样本失败', false)
        return
      }

      const seconds = Math.round(result.sampleSeconds || 0)
      showTopToast(`复刻语音样本已导出（${seconds} 秒）`, true)
    } catch (e) {
      showTopToast(`导出复刻语音样本失败: ${String(e)}`, false)
    } finally {
      setIsExportingVoiceSample(false)
    }
  }, [currentSessionId, isExportingVoiceSample, sessions, showTopToast])

  // 检查图片密钥配置（XOR 和 AES 都需要配置）
  useEffect(() => {
    Promise.all([getImageXorKey(), getImageAesKey()]).then(([xorKey, aesKey]) => {
      setHasImageKey(Boolean(xorKey) && Boolean(aesKey))
    })
  }, [])

  // 加载当前用户头像
  const loadMyAvatar = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getMyAvatarUrl()
      if (result.success && result.avatarUrl) {
        setMyAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载用户头像失败:', e)
    }
  }, [])

  // 连接数据库
  const connect = useCallback(async () => {
    setConnecting(true)
    setConnectionError(null)
    try {
      const result = await window.electronAPI.chat.connect()
      if (result.success) {
        setConnected(true)
        await loadSessions()
        await loadMyAvatar()
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar])

  // 加载会话列表
  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      // 刷新时覆盖已加载的原始行区间（后端单次上限 1000）；超出部分由 mergeRefreshedSessions 的尾部保留
      const sessionLimit = Math.min(1000, Math.max(SESSION_PAGE_SIZE, sessionRawOffsetRef.current))
      const result = await window.electronAPI.chat.getSessions(0, sessionLimit)
      if (result.success && result.sessions) {
        sessionRawOffsetRef.current = Math.max(sessionRawOffsetRef.current, sessionLimit)
        hasMoreSessionsRef.current = !!result.hasMore
        setSessions((prevSessions: ChatSession[]) => mergeRefreshedSessions(prevSessions, result.sessions!))
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setLoadingSessions(false)
    }
  }

  // 会话列表滚动到底部时加载下一页（搜索模式下由 SessionSidebar 不触发）
  const loadMoreSessions = useCallback(async () => {
    if (loadingMoreSessionsRef.current || !hasMoreSessionsRef.current) return
    loadingMoreSessionsRef.current = true
    try {
      const result = await window.electronAPI.chat.getSessions(sessionRawOffsetRef.current, SESSION_PAGE_SIZE)
      if (result.success && result.sessions) {
        sessionRawOffsetRef.current += SESSION_PAGE_SIZE
        hasMoreSessionsRef.current = !!result.hasMore
        const incoming = result.sessions
        if (incoming.length > 0) {
          setSessions((prevSessions: ChatSession[]) => {
            const seen = new Set(prevSessions.map(s => s.username))
            const fresh = incoming.filter(s => !seen.has(s.username))
            return fresh.length > 0 ? [...prevSessions, ...fresh] : prevSessions
          })
        }
      }
    } catch (e) {
      console.error('加载更多会话失败:', e)
    } finally {
      loadingMoreSessionsRef.current = false
    }
  }, [setSessions])

  // 刷新会话列表
  const handleRefresh = async () => {
    await loadSessions()
  }

  // 刷新当前会话消息（清空缓存后重新加载）
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false)
  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingMessages) return
    setIsRefreshingMessages(true)
    setIsUpdating(true) // 显示更新指示器
    try {
      clearSessionMessageCache(currentSessionId)
      // 清空后端缓存
      await window.electronAPI.chat.refreshCache()
      // 重新加载会话列表，以确保联系人信息被重新加载
      await loadSessions()
      // 重新加载消息
      setCurrentOffset(0)
      await loadMessages(currentSessionId, 0)
    } catch (e) {
      console.error('刷新消息失败:', e)
    } finally {
      setIsRefreshingMessages(false)
      setIsUpdating(false) // 隐藏更新指示器
    }
  }

  // 加载消息
  const loadMessages = async (sessionId: string, offset = 0) => {
    const loadSeq = ++messageLoadSeqRef.current
    if (offset === 0) {
      setLoadingMessages(true)
      setMessages([])
      setIsDateJumpMode(false)
      setDateJumpCursorSortSeq(null)
      setDateJumpCursorCreateTime(null)
      setDateJumpCursorLocalId(null)
      setDateJumpCursorSortSeqEnd(null)
      setDateJumpCursorCreateTimeEnd(null)
      setDateJumpCursorLocalIdEnd(null)
      setHasMoreMessagesAfter(false)
      // 标记用户正在操作（首次加载）
      isUserOperatingRef.current = true
    } else {
      if (isLoadingMoreRef.current) return
      isLoadingMoreRef.current = true
      setLoadingMore(true)
    }

    try {
      // 确保连接已建立（如果未连接，先连接）
      if (!isConnected) {
        console.log('[ChatPage] 加载消息前检查连接状态，未连接，先连接...')
        const connectResult = await window.electronAPI.chat.connect()
        if (!connectResult.success) {
          setConnectionError(connectResult.error || '连接失败')
          return
        }
        setConnected(true)
      }

      const oldestLoadedMessage = messagesRef.current[0]
      const oldestSortSeq = Number(oldestLoadedMessage?.sortSeq || 0)
      const useCursorPagination = offset > 0 && oldestLoadedMessage !== undefined && Number.isFinite(oldestSortSeq) && oldestSortSeq > 0
      const result = useCursorPagination
        ? await window.electronAPI.chat.getMessagesBefore(
          sessionId,
          oldestSortSeq,
          HISTORY_PAGE_SIZE,
          typeof oldestLoadedMessage.createTime === 'number' ? oldestLoadedMessage.createTime : undefined,
          typeof oldestLoadedMessage.localId === 'number' ? oldestLoadedMessage.localId : undefined
        )
        : await window.electronAPI.chat.getMessages(sessionId, offset, INITIAL_PAGE_SIZE)

      if (currentSessionIdRef.current !== sessionId || loadSeq !== messageLoadSeqRef.current) {
        return
      }

      if (result.success && result.messages) {
        const msgs = result.messages
        if (offset === 0) {
          setMessages(msgs)
          scrollToBottomAfterRenderRef.current = true
        } else {
          const hasMore = result.hasMore ?? false
          const newOffset = offset + msgs.length
          if (msgs.length === 0) {
            setHasMoreMessages(false)
          } else {
            appendMessages(msgs, true)
            setHasMoreMessages(hasMore)
            setCurrentOffset(newOffset)

            // 滑动窗口：首次触达上限时切换到双向游标模式
            const afterAppend = useChatStore.getState().messages
            if (afterAppend.length >= MAX_ACTIVE_MESSAGES && !isDateJumpModeRef.current) {
              const oldest = afterAppend[0]
              const newest = afterAppend[afterAppend.length - 1]
              setIsDateJumpMode(true)
              setDateJumpCursorSortSeq(oldest?.sortSeq ?? null)
              setDateJumpCursorCreateTime(typeof oldest?.createTime === 'number' ? oldest.createTime : null)
              setDateJumpCursorLocalId(typeof oldest?.localId === 'number' ? oldest.localId : null)
              setDateJumpCursorSortSeqEnd(newest?.sortSeq ?? null)
              setDateJumpCursorCreateTimeEnd(typeof newest?.createTime === 'number' ? newest.createTime : null)
              setDateJumpCursorLocalIdEnd(typeof newest?.localId === 'number' ? newest.localId : null)
              setHasMoreMessagesAfter(true)
            }
          }
        }
        if (offset === 0) {
          const hasMore = result.hasMore ?? false
          const nextOffset = offset + msgs.length
          setHasMoreMessages(hasMore)
          setCurrentOffset(nextOffset)
          saveSessionMessageCache(sessionId, {
            messages: msgs,
            hasMoreMessages: hasMore,
            currentOffset: nextOffset
          })
        }
      }
    } catch (e) {
      console.error('加载消息失败:', e)
    } finally {
      setLoadingMessages(false)
      setLoadingMore(false)
      if (offset > 0) {
        isLoadingMoreRef.current = false
      }
      // 加载完成后，延迟重置用户操作标记（给一点缓冲时间）
      if (offset === 0) {
        setTimeout(() => {
          isUserOperatingRef.current = false
        }, 2000) // 2秒后允许自动更新
      }
    }
  }

  // 监听增量消息推送
  useEffect(() => {
    // 告知后端当前会话
    window.electronAPI.chat.setCurrentSession(currentSessionId)

    const cleanup = window.electronAPI.chat.onNewMessages((data: { sessionId: string; messages: Message[] }) => {
      if (data.sessionId === currentSessionId && data.messages && data.messages.length > 0) {
        const listEl = messageListRef.current
        let shouldAutoScroll = false
        if (listEl) {
          const { scrollTop, scrollHeight, clientHeight } = listEl
          const distanceFromBottom = scrollHeight - scrollTop - clientHeight
          shouldAutoScroll = distanceFromBottom < 120
        }

        setMessages((prev: Message[]) => {
          // 使用与后端一致的多维 Key (serverId + localId + createTime + sortSeq) 进行去重
          const existingKeys = new Set(
            prev.map(pm => `${pm.serverId}-${pm.localId}-${pm.createTime}-${pm.sortSeq}`)
          )

          const newMsgs = data.messages.filter(nm => {
            const key = `${nm.serverId}-${nm.localId}-${nm.createTime}-${nm.sortSeq}`
            if (existingKeys.has(key)) return false
            existingKeys.add(key)
            return true
          })

          if (newMsgs.length === 0) return prev

          return [...prev, ...newMsgs]
        })

        // 仅当用户已在底部附近时才自动滚动，避免浏览历史时被打断
        if (shouldAutoScroll) {
          requestAnimationFrame(() => scrollToBottom(true))
        }
      }
    })

    return () => {
      cleanup()
    }
  }, [currentSessionId])

  // 上报当前正在查看的会话给消息提醒（"正在看的不提醒"）；离开聊天页时清空
  useEffect(() => {
    window.electronAPI.notify.setActiveSession(currentSessionId)
    return () => window.electronAPI.notify.setActiveSession(null)
  }, [currentSessionId])

  const syncCachedSessionMessages = useCallback(async (sessionId: string, loadSeq: number) => {
    const cachedMessages = useChatStore.getState().messages || []
    const lastMsg = cachedMessages[cachedMessages.length - 1]
    const minTime = Number(lastMsg?.createTime || 0)
    if (cachedMessages.length === 0 || minTime <= 0) return

    const listEl = messageListRef.current
    let isNearBottom = false
    if (listEl) {
      const { scrollTop, scrollHeight, clientHeight } = listEl
      isNearBottom = scrollHeight - scrollTop - clientHeight < 300
    }

    try {
      const messagesResult = await window.electronAPI.chat.getNewMessages(sessionId, minTime, 1000)
      if (currentSessionIdRef.current !== sessionId || loadSeq !== messageLoadSeqRef.current) return
      if (!messagesResult.success || !messagesResult.messages || messagesResult.messages.length === 0) return

      const latestMessages = useChatStore.getState().messages || []
      const existingKeys = new Set(latestMessages.map(getMessageCacheKey))
      const uniqueNewMessages = messagesResult.messages
        .filter((msg) => {
          const key = getMessageCacheKey(msg)
          if (existingKeys.has(key)) return false
          existingKeys.add(key)
          return true
        })
        .sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)

      if (uniqueNewMessages.length === 0) return
      if (isDateJumpModeRef.current) return

      appendMessages(uniqueNewMessages, false)
      const nextOffset = currentOffsetRef.current + uniqueNewMessages.length
      setCurrentOffset(nextOffset)
      incrementSyncVersion()

      const nextMessages = useChatStore.getState().messages || []
      const nextListEl = messageListRef.current
      saveSessionMessageCache(sessionId, {
        messages: nextMessages,
        hasMoreMessages: hasMoreMessagesRef.current,
        currentOffset: nextOffset,
        scrollTop: nextListEl?.scrollTop,
        scrollHeight: nextListEl?.scrollHeight
      })

      if (isNearBottom) {
        setVlistBottomSignal(s => s + 1)
      }
    } catch (e) {
      console.error('[ChatPage] 缓存会话增量同步失败:', e)
    }
  }, [appendMessages, incrementSyncVersion, saveSessionMessageCache])

  // 组件卸载时取消当前会话
  useEffect(() => {
    return () => {
      saveCurrentSessionMessageCache(currentSessionIdRef.current)
      window.electronAPI.chat.setCurrentSession(null)
    }
  }, [saveCurrentSessionMessageCache])

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    if (session.isFoldGroup || session.isOfficialFolder) {
      return
    }

    if (session.username === currentSessionId) {
      // 如果是当前会话，重新加载消息（用于刷新）
      clearSessionMessageCache(session.username)
      setCurrentOffset(0)
      currentSessionIdRef.current = session.username
      loadMessages(session.username, 0)
      return
    }

    saveCurrentSessionMessageCache(currentSessionId)
    currentSessionIdRef.current = session.username
    setCurrentSession(session.username)

    const cached = restoreSessionMessageCache(session.username)
    if (cached) {
      const loadSeq = ++messageLoadSeqRef.current
      setCurrentOffset(cached.currentOffset)
      setHasMoreMessages(cached.hasMoreMessages)
      setIsDateJumpMode(false)
      setDateJumpCursorSortSeq(null)
      setDateJumpCursorCreateTime(null)
      setDateJumpCursorLocalId(null)
      setDateJumpCursorSortSeqEnd(null)
      setDateJumpCursorCreateTimeEnd(null)
      setDateJumpCursorLocalIdEnd(null)
      setHasMoreMessagesAfter(false)
      // 重进会话由 MessageListVirtual 初始置底接管（virtua），不做裸 DOM 滚动恢复
      void syncCachedSessionMessages(session.username, loadSeq)
      return
    }

    setCurrentOffset(0)
    loadMessages(session.username, 0)
  }

  // 搜索：先对已加载列表就地过滤给即时反馈，防抖后走后端全量搜索覆盖结果
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
    const seq = ++searchSeqRef.current
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    if (!keyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = keyword.toLowerCase()
    const filtered = sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
    setFilteredSessions(filtered)

    searchTimerRef.current = setTimeout(async () => {
      searchTimerRef.current = null
      try {
        const result = await window.electronAPI.chat.searchSessions(keyword)
        // 关键词已变化或搜索已关闭，丢弃过期结果
        if (seq !== searchSeqRef.current) return
        if (result.success && result.sessions) {
          setFilteredSessions(result.sessions)
        }
      } catch (e) {
        console.error('后端搜索会话失败:', e)
      }
    }, 250)
  }

  // 关闭搜索框
  const handleCloseSearch = () => {
    searchSeqRef.current++
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    setSearchKeyword('')
    setFilteredSessions(sessions)
  }

  // 滚动加载更多 + 显示/隐藏回到底部按钮
  const loadMoreMessagesInDateJumpMode = useCallback(async () => {
    if (!currentSessionId || dateJumpCursorSortSeq === null || isLoadingMoreRef.current || !hasMoreMessages) return

    isLoadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const result = await window.electronAPI.chat.getMessagesBefore(
        currentSessionId,
        dateJumpCursorSortSeq,
        HISTORY_PAGE_SIZE,
        dateJumpCursorCreateTime ?? undefined,
        dateJumpCursorLocalId ?? undefined
      )

      if (result.success && result.messages) {
        const existingKeys = new Set(
          messagesRef.current.map(m => `${m.serverId}-${m.localId}-${m.createTime}-${m.sortSeq}`)
        )
        const uniqueOlderMessages = result.messages.filter(msg =>
          !existingKeys.has(`${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`)
        )

        if (uniqueOlderMessages.length === 0) {
          setHasMoreMessages(false)
          return
        }

        const oldestSortSeq = uniqueOlderMessages[0]?.sortSeq
        const oldestCreateTime = uniqueOlderMessages[0]?.createTime
        const oldestLocalId = uniqueOlderMessages[0]?.localId

        appendMessages(uniqueOlderMessages, true)
        if (typeof oldestSortSeq !== 'number' || oldestSortSeq >= dateJumpCursorSortSeq) {
          setHasMoreMessages(false)
        } else {
          setDateJumpCursorSortSeq(oldestSortSeq)
          setDateJumpCursorCreateTime(typeof oldestCreateTime === 'number' ? oldestCreateTime : null)
          setDateJumpCursorLocalId(typeof oldestLocalId === 'number' ? oldestLocalId : null)
          setHasMoreMessages(result.hasMore ?? false)
        }

        // 滑动窗口：若 appendMessages 裁剪了最新端，同步更新向下游标
        const afterAppend = useChatStore.getState().messages
        const newestAfter = afterAppend[afterAppend.length - 1]
        if (
          typeof newestAfter?.sortSeq === 'number' &&
          newestAfter.sortSeq !== dateJumpCursorSortSeqEnd
        ) {
          setDateJumpCursorSortSeqEnd(newestAfter.sortSeq)
          setDateJumpCursorCreateTimeEnd(typeof newestAfter.createTime === 'number' ? newestAfter.createTime : null)
          setDateJumpCursorLocalIdEnd(typeof newestAfter.localId === 'number' ? newestAfter.localId : null)
          setHasMoreMessagesAfter(true)
        }
      } else {
        setHasMoreMessages(false)
      }
    } catch (e) {
      console.error('日期跳转模式加载更多失败:', e)
    } finally {
      setLoadingMore(false)
      isLoadingMoreRef.current = false
    }
  }, [
    currentSessionId,
    dateJumpCursorSortSeq,
    dateJumpCursorCreateTime,
    dateJumpCursorLocalId,
    hasMoreMessages,
    appendMessages,
    setHasMoreMessages,
    setLoadingMore
  ])

  // 日期跳转模式：向下滑动加载更新的消息
  const loadMoreMessagesAfterInDateJumpMode = useCallback(async () => {
    if (!currentSessionId || dateJumpCursorSortSeqEnd === null || isLoadingMoreRef.current || !hasMoreMessagesAfter) return

    isLoadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const result = await window.electronAPI.chat.getMessagesAfter(
        currentSessionId,
        dateJumpCursorSortSeqEnd,
        HISTORY_PAGE_SIZE,
        dateJumpCursorCreateTimeEnd ?? undefined,
        dateJumpCursorLocalIdEnd ?? undefined
      )

      if (result.success && result.messages) {
        const existingKeys = new Set(
          messagesRef.current.map(m => `${m.serverId}-${m.localId}-${m.createTime}-${m.sortSeq}`)
        )
        const uniqueNewerMessages = result.messages.filter((msg: Message) =>
          !existingKeys.has(`${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`)
        )

        if (uniqueNewerMessages.length === 0) {
          setHasMoreMessagesAfter(false)
          return
        }

        // 追加到消息列表末尾
        appendMessages(uniqueNewerMessages, false)

        // 更新向下滑动游标
        const newestMsg = uniqueNewerMessages[uniqueNewerMessages.length - 1]
        const newestSortSeq = newestMsg?.sortSeq
        const newestCreateTime = newestMsg?.createTime
        const newestLocalId = newestMsg?.localId

        if (typeof newestSortSeq !== 'number' || newestSortSeq <= dateJumpCursorSortSeqEnd) {
          setHasMoreMessagesAfter(false)
        } else {
          setDateJumpCursorSortSeqEnd(newestSortSeq)
          setDateJumpCursorCreateTimeEnd(typeof newestCreateTime === 'number' ? newestCreateTime : null)
          setDateJumpCursorLocalIdEnd(typeof newestLocalId === 'number' ? newestLocalId : null)
          setHasMoreMessagesAfter(result.hasMore ?? false)
        }

        // 追加在末尾不移动视口，由 virtua 处理，无需手动保持滚动位置
      } else {
        setHasMoreMessagesAfter(false)
      }
    } catch (e) {
      console.error('日期跳转模式向下加载失败:', e)
    } finally {
      setLoadingMore(false)
      isLoadingMoreRef.current = false
    }
  }, [
    currentSessionId,
    dateJumpCursorSortSeqEnd,
    dateJumpCursorCreateTimeEnd,
    dateJumpCursorLocalIdEnd,
    hasMoreMessagesAfter,
    appendMessages
  ])

  const { handleScroll, showScrollToBottom } = useThrottledScroll(
    { messageListRef, isLoadingMoreRef, currentSessionIdRef },
    { hasMoreMessages, hasMoreMessagesAfter, currentOffset, isDateJumpMode, loadMessages, loadMoreMessagesInDateJumpMode, loadMoreMessagesAfterInDateJumpMode }
  )

  // 滚动到底部：走置底信号，由 MessageListVirtual 用 scrollToIndex 落点（不碰裸 DOM）
  const scrollToBottom = useCallback((_smooth: boolean | React.MouseEvent = true) => {
    setVlistBottomSignal(s => s + 1)
  }, [])

  // WeFlow 风格实时更新：wcdb 变化事件只做触发器，实际数据通过会话/消息接口增量读取
  useEffect(() => {
    const onChange = window.electronAPI.wcdb?.onChange
    if (typeof onChange !== 'function') return

    let pendingSessionRefresh = false
    let pendingMessageRefresh = false

    const flushRealtimeUpdate = async () => {
      wcdbChangeTimerRef.current = null
      const shouldRefreshSessions = pendingSessionRefresh
      const shouldRefreshMessages = pendingMessageRefresh
      pendingSessionRefresh = false
      pendingMessageRefresh = false

      try {
        setLastIncrementalUpdateTime(Date.now())

        if (shouldRefreshSessions) {
          const sessionLimit = Math.min(1000, Math.max(SESSION_PAGE_SIZE, sessionRawOffsetRef.current))
          const result = await window.electronAPI.chat.getSessions(0, sessionLimit)
          if (result.success && result.sessions) {
            setSessions((prevSessions: ChatSession[]) => mergeRefreshedSessions(prevSessions, result.sessions!))
          }
        }

        const currentId = currentSessionIdRef.current
        // 仅在消息表变更时拉取当前会话增量；纯会话变更只刷新会话列表，避免多余的 getNewMessages
        if (!currentId || !shouldRefreshMessages) return

        const currentMessages = useChatStore.getState().messages || []
        const lastMsg = currentMessages[currentMessages.length - 1]
        const minTime = Number(lastMsg?.createTime || 0)
        const listEl = messageListRef.current
        let isNearBottom = false
        if (listEl) {
          const { scrollTop, scrollHeight, clientHeight } = listEl
          isNearBottom = scrollHeight - scrollTop - clientHeight < 300
        }

        const messagesResult = await window.electronAPI.chat.getNewMessages(currentId, minTime, 1000)
        if (currentSessionIdRef.current !== currentId) return
        if (!messagesResult.success || !messagesResult.messages || messagesResult.messages.length === 0) return

        const latestMessages = useChatStore.getState().messages || []
        const existingKeys = new Set(latestMessages.map(m => `${m.serverId}-${m.localId}-${m.createTime}-${m.sortSeq}`))
        const uniqueNewMessages = messagesResult.messages
          .filter(msg => !existingKeys.has(`${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`))
          .sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)

        if (uniqueNewMessages.length === 0) return
        if (isDateJumpModeRef.current) return
        appendMessages(uniqueNewMessages, false)
        incrementSyncVersion()
        if (isNearBottom) {
          requestAnimationFrame(() => scrollToBottom(true))
        }
      } catch (e) {
        console.error('[ChatPage] wcdb 实时刷新失败:', e)
      }
    }

    const remove = onChange((payload) => {
      const table = String(payload?.table || '').toLowerCase()
      if (table === 'session' || table === 'contact') pendingSessionRefresh = true
      if (table === 'message' || table === 'unknown' || table.startsWith('msg')) pendingMessageRefresh = true
      if (!pendingSessionRefresh && !pendingMessageRefresh) return

      if (wcdbChangeTimerRef.current) clearTimeout(wcdbChangeTimerRef.current)
      wcdbChangeTimerRef.current = setTimeout(() => {
        void flushRealtimeUpdate()
      }, 450)
    })

    return () => {
      remove?.()
      if (wcdbChangeTimerRef.current) {
        clearTimeout(wcdbChangeTimerRef.current)
        wcdbChangeTimerRef.current = null
      }
    }
  }, [appendMessages, incrementSyncVersion, scrollToBottom, setSessions])

  // 初始/刷新置底：由 MessageListVirtual 用 scrollToIndex 置底。把"该置底"意图转成置底信号
  // （覆盖"同会话刷新"——sid 不变、会话级 guard 不触发的情况）。
  useEffect(() => {
    if (scrollToBottomAfterRenderRef.current) {
      scrollToBottomAfterRenderRef.current = false
      setVlistBottomSignal(s => s + 1)
    }
  }, [messages])

  // 日期跳转处理
  const handleJumpToDate = useCallback(async (dateValue?: string) => {
    const targetDateValue = dateValue || selectedDate
    if (!targetDateValue || !currentSessionId || isJumpingToDate) return

    setIsJumpingToDate(true)

    try {
      // 将选中的日期转换为 Unix 时间戳（秒）
      const targetDate = parseDateValue(targetDateValue)
      if (!targetDate) return

      targetDate.setHours(0, 0, 0, 0)
      const targetTimestamp = Math.floor(targetDate.getTime() / 1000)

      const result = await window.electronAPI.chat.getMessagesByDate(currentSessionId, targetTimestamp, 50)

      if (result.success && result.messages && result.messages.length > 0) {
        // 清空当前消息并加载新消息
        setMessages(result.messages)
        setHasMoreMessages(true)
        setCurrentOffset(result.messages.length)
        setIsDateJumpMode(true)
        // 设置向上滑动游标（最早消息）
        setDateJumpCursorSortSeq(result.messages[0]?.sortSeq ?? null)
        setDateJumpCursorCreateTime(result.messages[0]?.createTime ?? null)
        setDateJumpCursorLocalId(result.messages[0]?.localId ?? null)
        // 设置向下滑动游标（最新消息）
        const lastMsg = result.messages[result.messages.length - 1]
        setDateJumpCursorSortSeqEnd(lastMsg?.sortSeq ?? null)
        setDateJumpCursorCreateTimeEnd(lastMsg?.createTime ?? null)
        setDateJumpCursorLocalIdEnd(lastMsg?.localId ?? null)
        setHasMoreMessagesAfter(true)

        // 滚动到顶部显示目标日期的消息（置顶信号，由 MessageListVirtual 用 scrollToIndex(0)）
        setVlistTopSignal(s => s + 1)
      } else {
        // 没有找到消息，可能日期太新
        console.log('未找到该日期或之后的消息')
      }
    } catch (e) {
      console.error('跳转到日期失败:', e)
    } finally {
      setIsJumpingToDate(false)
    }
  }, [selectedDate, currentSessionId, isJumpingToDate, setMessages, setHasMoreMessages])

  // 批量语音转文字
  const handleBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) {
      alert('未选择会话')
      return
    }
    
    const session = sessions.find(s => s.username === currentSessionId)
    
    if (!session) {
      alert('未找到当前会话')
      return
    }
    
    if (isBatchTranscribing) {
      return
    }

    // 从数据库获取该会话的所有语音消息
    const result = await window.electronAPI.chat.getAllVoiceMessages(currentSessionId)
    
    if (!result.success || !result.messages) {
      alert(`获取语音消息失败: ${result.error || '未知错误'}`)
      return
    }

    const voiceMessages = result.messages
    
    if (voiceMessages.length === 0) {
      alert('当前会话没有语音消息')
      return
    }

    // 统计有语音的日期（仅这些日期可选）
    const dateSet = new Set<string>()
    voiceMessages.forEach(m => dateSet.add(new Date(m.createTime * 1000).toISOString().slice(0, 10)))
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a)) // 最近的排上面

    setBatchVoiceMessages(voiceMessages)
    setBatchVoiceCount(voiceMessages.length)
    setBatchVoiceDates(sortedDates)
    setBatchSelectedDates(new Set(sortedDates)) // 默认全选
    setShowBatchConfirm(true)
  }, [sessions, currentSessionId, isBatchTranscribing])

  // 确认批量转写（仅转写选中日期内的语音）
  const confirmBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const messages = batchVoiceMessages
    if (!messages || messages.length === 0) {
      setShowBatchConfirm(false)
      return
    }

    const voiceMessages = messages.filter(m =>
      selected.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    )
    if (voiceMessages.length === 0) {
      alert('所选日期下没有语音消息')
      return
    }

    setShowBatchConfirm(false)
    setBatchVoiceMessages(null)
    setBatchVoiceDates([])
    setBatchSelectedDates(new Set())

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return
    
    setIsBatchTranscribing(true)
    setShowBatchProgress(true) // 显示进度对话框
    setBatchTranscribeProgress({ current: 0, total: voiceMessages.length })

    // 检查 STT 模式和模型
    const sttMode = await window.electronAPI.config.get('sttMode') || 'cpu'
    
    let modelExists = false
    let concurrency = 5
    if (sttMode === 'gpu') {
      const whisperModelType = (await window.electronAPI.config.get('whisperModelType') as string) || 'small'
      const modelStatus = await window.electronAPI.sttWhisper.checkModel(whisperModelType)
      modelExists = modelStatus.exists
      
      if (!modelExists) {
        alert(`Whisper ${whisperModelType} 模型未下载，请先在设置中下载模型`)
        setIsBatchTranscribing(false)
        setShowBatchProgress(false)
        return
      }
    } else if (sttMode === 'online') {
      const onlineReady = await checkOnlineSttConfigReady()
      if (!onlineReady.ready) {
        alert(onlineReady.error)
        setIsBatchTranscribing(false)
        setShowBatchProgress(false)
        return
      }
      const savedConcurrency = Number(await window.electronAPI.config.get('sttOnlineMaxConcurrency')) || 2
      concurrency = Math.max(1, Math.min(10, Math.floor(savedConcurrency)))
    } else {
      const modelStatus = await window.electronAPI.stt.getModelStatus()
      modelExists = !!(modelStatus.success && modelStatus.exists)
      
      if (!modelExists) {
        alert('SenseVoice 模型未下载，请先在设置中下载模型')
        setIsBatchTranscribing(false)
        setShowBatchProgress(false)
        return
      }
    }

    // 并发批量转写
    let successCount = 0
    let failCount = 0
    let completedCount = 0
    
    // 并发数量限制（避免同时处理太多导致内存溢出）
    // 转写单条语音的函数
    const transcribeOne = async (msg: any) => {
      try {
        // 检查是否已有缓存
        const cached = await window.electronAPI.stt.getCachedTranscript(session.username, msg.createTime, msg.localId)
        
        if (cached && cached.success && cached.transcript) {
          return { success: true, cached: true }
        }

        // 获取语音数据
        const result = await window.electronAPI.chat.getVoiceData(
          session.username,
          String(msg.localId),
          msg.createTime,
          msg.serverId
        )

        if (!result.success || !result.data) {
          return { success: false }
        }

        // 转写
        const transcribeResult = await window.electronAPI.stt.transcribe(
          result.data,
          session.username,
          msg.createTime,
          false,
          msg.localId,
        )

        return { success: transcribeResult.success }
      } catch (e) {
        return { success: false }
      }
    }

    // 使用 Promise.all 分批并发处理
    for (let i = 0; i < voiceMessages.length; i += concurrency) {
      const batch = voiceMessages.slice(i, i + concurrency)
      
      const results = await Promise.all(
        batch.map(msg => transcribeOne(msg))
      )

      // 统计结果
      results.forEach(result => {
        if (result.success) {
          successCount++
        } else {
          failCount++
        }
        completedCount++
        setBatchTranscribeProgress({ current: completedCount, total: voiceMessages.length })
      })
    }

    setIsBatchTranscribing(false)
    setShowBatchProgress(false) // 隐藏进度对话框
    
    // 显示结果对话框
    setBatchResult({ success: successCount, fail: failCount })
    setShowBatchResult(true)
  }, [sessions, currentSessionId, batchSelectedDates, batchVoiceMessages, checkOnlineSttConfigReady])

  // 批量转写：按日期的消息数量
  const batchCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchVoiceMessages) return map
    batchVoiceMessages.forEach(m => {
      const d = new Date(m.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) || 0) + 1)
    })
    return map
  }, [batchVoiceMessages])

  // 批量转写：选中日期对应的语音条数
  const batchSelectedMessageCount = useMemo(() => {
    if (!batchVoiceMessages) return 0
    return batchVoiceMessages.filter(m =>
      batchSelectedDates.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchVoiceMessages, batchSelectedDates])

  const toggleBatchDate = useCallback((date: string) => {
    setBatchSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchDates = useCallback(() => setBatchSelectedDates(new Set(batchVoiceDates)), [batchVoiceDates])
  const clearAllBatchDates = useCallback(() => setBatchSelectedDates(new Set()), [])

  // 批量解密图片 - 日期选择辅助
  const toggleBatchImageDate = useCallback((date: string) => {
    setBatchImageSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set(batchImageDates)), [batchImageDates])
  const clearAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set()), [])

  const batchImageCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchImageMessages) return map
    batchImageMessages.forEach(img => {
      if (img.createTime) {
        const d = new Date(img.createTime * 1000).toISOString().slice(0, 10)
        map.set(d, (map.get(d) ?? 0) + 1)
      }
    })
    return map
  }, [batchImageMessages])

  const batchImageSelectedCount = useMemo(() => {
    if (!batchImageMessages) return 0
    return batchImageMessages.filter(img =>
      img.createTime && batchImageSelectedDates.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchImageMessages, batchImageSelectedDates])

  // 批量解密图片 - 打开日期选择对话框
  const handleBatchDecrypt = useCallback(async () => {
    if (!currentSessionId || isBatchDecrypting) return

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    const result = await window.electronAPI.chat.getAllImageMessages(currentSessionId)
    if (!result.success || !result.images || result.images.length === 0) {
      alert(result.error || '当前会话没有图片消息')
      return
    }

    const dateSet = new Set<string>()
    result.images.forEach(img => {
      if (img.createTime) dateSet.add(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    })
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

    setBatchImageMessages(result.images)
    setBatchImageDates(sortedDates)
    setBatchImageSelectedDates(new Set(sortedDates))
    setShowBatchDecryptConfirm(true)
  }, [currentSessionId, sessions, isBatchDecrypting])

  // 确认批量解密（仅解密选中日期内的图片）
  const confirmBatchDecrypt = useCallback(async () => {
    if (!currentSessionId || !batchImageMessages) return

    const selected = batchImageSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const images = batchImageMessages.filter(img =>
      img.createTime && selected.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    )
    if (images.length === 0) {
      alert('所选日期下没有图片消息')
      return
    }

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    setShowBatchDecryptConfirm(false)
    setBatchImageMessages(null)
    setBatchImageDates([])
    setBatchImageSelectedDates(new Set())

    setIsBatchDecrypting(true)
    setShowBatchDecryptProgress(true)
    setBatchDecryptProgress({ current: 0, total: images.length })

    const payloads = images.map(img => ({
      sessionId: session.username,
      imageMd5: img.imageMd5,
      imageDatName: img.imageDatName,
      createTime: img.createTime
    }))

    let finalSuccess = 0
    let finalFail = 0
    const unsubscribeProgress = window.electronAPI.image.onBatchDecryptProgress((progress) => {
      setBatchDecryptProgress({ current: progress.current, total: progress.total || images.length })
      finalSuccess = progress.successCount
      finalFail = progress.failCount
    })

    try {
      const result = await window.electronAPI.image.batchDecrypt(payloads)
      finalSuccess = result.successCount
      finalFail = result.failCount
      setBatchDecryptProgress({ current: result.current, total: result.total || images.length })
    } catch {
      finalFail = Math.max(finalFail, images.length - finalSuccess)
    } finally {
      unsubscribeProgress()
      setIsBatchDecrypting(false)
      setShowBatchDecryptProgress(false)
    }

    alert(`解密完成：成功 ${finalSuccess} 张，失败 ${finalFail} 张`)
  }, [currentSessionId, sessions, batchImageMessages, batchImageSelectedDates])

  // 同步 messages 和 currentSessionId 到 ref，供自动更新使用
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    if (!currentSessionId || hasImageKey === false || messages.length === 0) return

    const payloads = buildImagePrewarmPayloads(messages, currentSessionId)
    if (payloads.length === 0) return

    const signature = payloads
      .map(item => `${item.sessionId || ''}:${item.imageMd5 || ''}:${item.imageDatName || ''}:${item.createTime || 0}`)
      .join('|')
    if (signature === imagePrewarmSignatureRef.current) return
    imagePrewarmSignatureRef.current = signature

    const timer = window.setTimeout(() => {
      void window.electronAPI.image.prewarm(payloads).catch(() => { })
    }, 300)

    return () => {
      window.clearTimeout(timer)
    }
  }, [currentSessionId, hasImageKey, messages])

  useEffect(() => {
    currentOffsetRef.current = currentOffset
  }, [currentOffset])

  useEffect(() => {
    hasMoreMessagesRef.current = hasMoreMessages
  }, [hasMoreMessages])

  useEffect(() => {
    isDateJumpModeRef.current = isDateJumpMode
  }, [isDateJumpMode])

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // 初始化连接
  useEffect(() => {
    if (!isConnected && !isConnecting) {
      connect()
    }
  }, [])

  // 监听会话更新事件（来自后台自动同步）
  useEffect(() => {
    if (!isConnected) return

    // 监听会话列表更新
    const removeSessionsListener = window.electronAPI.chat.onSessionsUpdated?.(async (newSessions) => {
      // 更新增量更新时间戳
      setLastIncrementalUpdateTime(Date.now())

      // 智能合并更新会话列表，避免闪烁
      setSessions((prevSessions: ChatSession[]) => {
        // 如果之前没有会话，直接设置
        if (prevSessions.length === 0) {
          return newSessions
        }

        // 创建旧会话的 Map
        const oldSessionsMap = new Map(
          prevSessions.map(s => [s.username, s])
        )

        // 合并：保留顺序，只更新变化的字段
        const merged = newSessions.map(newSession => {
          const oldSession = oldSessionsMap.get(newSession.username)

          // 如果是新会话，直接返回
          if (!oldSession) {
            return newSession
          }

          // 检查是否有实质性变化
          const hasChanges =
            oldSession.summary !== newSession.summary ||
            oldSession.lastTimestamp !== newSession.lastTimestamp ||
            oldSession.unreadCount !== newSession.unreadCount ||
            oldSession.displayName !== newSession.displayName ||
            oldSession.avatarUrl !== newSession.avatarUrl

          // 如果有变化，返回新数据；否则保留旧对象引用（避免重新渲染）
          return hasChanges ? newSession : oldSession
        })

        return merged
      })

      const currentId = currentSessionIdRef.current
      // 如果当前没有打开会话，只需要更新列表（App.tsx 已处理）
      if (!currentId) return

      // 2. 检查当前会话是否有新消息
      const currentSession = newSessions.find(s => s.username === currentId)
      if (!currentSession) return // 当前会话可能被删除了？
      if (currentSession.isFoldGroup || currentSession.isOfficialFolder) return

      // 简单判断：如果当前会话的 lastTimestamp 变了，或者有新消息
      // 这里我们采取积极策略：只要有更新事件，就尝试拉取最新消息
      // 因为增量获取开销很小

      try {
        const currentMessages = messagesRef.current
        const listEl = messageListRef.current

        // 记录滚动位置
        let isNearBottom = false
        if (listEl) {
          const { scrollTop, scrollHeight, clientHeight } = listEl
          const distanceFromBottom = scrollHeight - scrollTop - clientHeight
          isNearBottom = distanceFromBottom < 300
        }

        // 获取最新 50 条消息（增量获取开销小）
        const messagesResult = await window.electronAPI.chat.getMessages(currentId, 0, 50)
        if (currentSessionIdRef.current !== currentId) return

        if (messagesResult.success && messagesResult.messages) {
          const fetchedMessages = messagesResult.messages
          if (fetchedMessages.length === 0) return

          // 如果之前没消息，直接设置并返回
          if (currentMessages.length === 0) {
            setMessages(fetchedMessages)
            setHasMoreMessages(messagesResult.hasMore ?? false)
            return
          }

          // 使用多维 Key (localId + createTime) 进行去重，找出真正的“新”消息
          const existingKeys = new Set(currentMessages.map(m => `${m.serverId}-${m.localId}-${m.createTime}-${m.sortSeq}`))
          const uniqueNewMessages = fetchedMessages.filter(msg =>
            !existingKeys.has(`${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`)
          )

          if (uniqueNewMessages.length > 0) {
            // 按 createTime 升序排序，确保追加顺序正确
            uniqueNewMessages.sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)

            console.log(`[ChatPage] 自动增长发现 ${uniqueNewMessages.length} 条新消息`)
            if (isDateJumpModeRef.current) return
            appendMessages(uniqueNewMessages, false)

            // 滚动处理：如果用户在底部附近，则自动平滑滚动
            if (isNearBottom) {
              requestAnimationFrame(() => {
                scrollToBottom(true)
              })
            }
            // 每次成功发现新消息或活跃会话更新，都增加全局同步计数，触发图片无感检查
            incrementSyncVersion()
          }
        }
      } catch (e) {
        console.error('[ChatPage] 自动刷新消息失败:', e)
      }
    })

    return () => {
      removeSessionsListener?.()
    }
  }, [isConnected, currentSessionId, appendMessages, setMessages, setHasMoreMessages])

  // 点击外部或右键其他地方关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      if (contextMenu) {
        closeContextMenu()
      }
    }

    const handleContextMenu = () => {
      // 右键其他地方时，先关闭当前菜单
      // 新菜单会在 onContextMenu 处理函数中打开
      if (contextMenu) {
        closeContextMenu()
      }
    }

    if (contextMenu) {
      // 延迟添加事件监听，避免立即触发
      const timer = setTimeout(() => {
        document.addEventListener('click', handleClick)
        document.addEventListener('contextmenu', handleContextMenu)
      }, 0)

      return () => {
        clearTimeout(timer)
        document.removeEventListener('click', handleClick)
        document.removeEventListener('contextmenu', handleContextMenu)
      }
    }
  }, [contextMenu])

  // 获取当前会话信息
  const currentSession = sessions.find(s => s.username === currentSessionId)

  return (
    <div className={`chat-page standalone ${isResizing ? 'resizing' : ''}`}>
      {/* 左侧会话列表 */}
      <SessionSidebar
        sidebarRef={sidebarRef}
        searchInputRef={searchInputRef}
        sidebarWidth={sidebarWidth}
        searchKeyword={searchKeyword}
        onSearch={handleSearch}
        onCloseSearch={handleCloseSearch}
        onRefresh={handleRefresh}
        isLoadingSessions={isLoadingSessions}
        isUpdating={isUpdating}
        connectionError={connectionError}
        onRetryConnect={connect}
        filteredSessions={filteredSessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onLoadMore={loadMoreSessions}
        formatTime={formatSessionTime}
      />

      <div className="resize-handle" onMouseDown={handleResizeStart} />

      {/* 右侧消息区域 */}
      <div className="message-shell">
        <TitleBar className="message-titlebar" rightContent={<></>} showTitle={false} />

        <div className="message-area">
          {currentSession ? (
            <>
              <ChatHeader
                currentSession={currentSession}
                currentSessionId={currentSessionId}
                isRefreshingMessages={isRefreshingMessages}
                isLoadingMessages={isLoadingMessages}
                isUpdating={isUpdating}
                onRefreshMessages={handleRefreshMessages}
                selectedDate={selectedDate}
                onSelectedDateChange={setSelectedDate}
                onJumpToDate={handleJumpToDate}
                isJumpingToDate={isJumpingToDate}
                isBatchTranscribing={isBatchTranscribing}
                batchTranscribeProgress={batchTranscribeProgress}
                onBatchTranscribe={handleBatchTranscribe}
                isExportingVoiceSample={isExportingVoiceSample}
                onExportVoiceCloneSample={exportVoiceCloneSample}
                isBatchDecrypting={isBatchDecrypting}
                batchDecryptProgress={batchDecryptProgress}
                onBatchDecrypt={handleBatchDecrypt}
              />

              <div className="message-content-wrapper">
                <MessageListVirtual
                  currentSession={currentSession}
                  isLoadingMessages={isLoadingMessages}
                  messages={messages}
                  hasMoreMessages={hasMoreMessages}
                  isLoadingMore={isLoadingMore}
                  messageListRef={messageListRef}
                  onScroll={handleScroll}
                  myAvatarUrl={myAvatarUrl}
                  hasImageKey={hasImageKey}
                  quoteStyle={quoteStyle}
                  selectedMessages={selectedMessages}
                  selectMode={selectMode}
                  onToggleSelect={toggleSelectMessage}
                  setContextMenu={setContextMenu}
                  showScrollToBottom={showScrollToBottom}
                  scrollToBottom={scrollToBottom}
                  bottomSignal={vlistBottomSignal}
                  topSignal={vlistTopSignal}
                />
                {isReplySuggestSession(currentSession) && (
                  <ReplySuggestBar messages={messages} session={currentSession} />
                )}
              </div>

              {selectMode && (
                <div className="select-action-bar">
                  <span className="select-action-bar__count">已选 {selectedMessages.size} 条</span>
                  <div className="select-action-bar__btns">
                    <Button
                      className="select-action-bar__btn"
                      size="sm"
                      variant="tertiary"
                      onPress={exitSelectMode}
                    >
                      <Xmark className="size-4 shrink-0" />
                      取消
                    </Button>
                    <Button
                      className="select-action-bar__btn select-action-bar__btn--primary"
                      isDisabled={selectedMessages.size === 0}
                      size="sm"
                      variant="primary"
                      onPress={() => void openPosterWindow()}
                    >
                      <Picture className="size-4 shrink-0" />
                      生成海报
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="message-header empty-header">
                <div className="header-info">
                  <h3>聊天</h3>
                </div>
              </div>
              <div className="message-content-wrapper">
                <div className="message-list">
                  <ChatBackground />
                  <div className="empty-chat">
                    <Comment />
                    <p>选择一个会话开始查看聊天记录</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <ContextMenuPortal
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        showTopToast={showTopToast}
        setShowEnlargeView={setShowEnlargeView}
        onEnterSelectMode={enterSelectMode}
        exportVoiceMessage={exportVoiceMessage}
        setShowMessageInfo={setShowMessageInfo}
      />

      <MessageInfoModal
        message={showMessageInfo}
        onClose={() => setShowMessageInfo(null)}
      />

      <EnlargeViewModal
        view={showEnlargeView}
        onClose={() => setShowEnlargeView(null)}
      />

      <BatchTranscribeModal
        showConfirm={showBatchConfirm}
        onCloseConfirm={() => setShowBatchConfirm(false)}
        voiceDates={batchVoiceDates}
        countByDate={batchCountByDate}
        selectedDates={batchSelectedDates}
        selectedMessageCount={batchSelectedMessageCount}
        onToggleDate={toggleBatchDate}
        onSelectAllDates={selectAllBatchDates}
        onClearAllDates={clearAllBatchDates}
        onConfirm={confirmBatchTranscribe}
        showProgress={showBatchProgress}
        progress={batchTranscribeProgress}
        showResult={showBatchResult}
        result={batchResult}
        onCloseResult={() => setShowBatchResult(false)}
        voiceMessages={batchVoiceMessages}
      />

      <BatchDecryptModal
        showConfirm={showBatchDecryptConfirm}
        onCloseConfirm={() => setShowBatchDecryptConfirm(false)}
        imageDates={batchImageDates}
        countByDate={batchImageCountByDate}
        selectedDates={batchImageSelectedDates}
        selectedCount={batchImageSelectedCount}
        onToggleDate={toggleBatchImageDate}
        onSelectAllDates={selectAllBatchImageDates}
        onClearAllDates={clearAllBatchImageDates}
        onConfirm={confirmBatchDecrypt}
        showProgress={showBatchDecryptProgress}
        progress={batchDecryptProgress}
        imageMessages={batchImageMessages}
      />

    </div>
  )
}

export default ChatPage
