import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { ChevronDown, CircleDashed } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import ChatBackground from '../../../components/ChatBackground'
import type { ChatSession, Message } from '../../../types/models'
import type { ContextMenuState, QuoteStyle } from '../types'
import { getMessageDomKey } from '../utils/messageKeys'
import { isGroupChat, isSystemMessage } from '../utils/messageGuards'
import { formatDateDivider, shouldShowDateDivider } from '../utils/time'
import MessageBubble from './messageBubble/MessageBubble'

interface MessageListVirtualProps {
  currentSession: ChatSession
  isLoadingMessages: boolean
  messages: Message[]
  hasMoreMessages: boolean
  isLoadingMore: boolean
  messageListRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  myAvatarUrl?: string
  hasImageKey: boolean | null
  quoteStyle: QuoteStyle
  selectedMessages: Set<number>
  selectMode: boolean
  onToggleSelect: (localId: number) => void
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>
  showScrollToBottom: boolean
  scrollToBottom: (smooth?: boolean | React.MouseEvent) => void
  /** ChatPage 表达"该置底"的意图信号；每次递增触发一次 scrollToIndex 置底 */
  bottomSignal: number
  /** ChatPage 表达"该置顶"的意图信号（如日期跳转）；每次递增触发一次 scrollToIndex(0) */
  topSignal: number
}

export function MessageListVirtual({
  currentSession,
  isLoadingMessages,
  messages,
  hasMoreMessages,
  isLoadingMore,
  messageListRef,
  onScroll,
  myAvatarUrl,
  hasImageKey,
  quoteStyle,
  selectedMessages,
  selectMode,
  onToggleSelect,
  setContextMenu,
  showScrollToBottom,
  scrollToBottom,
  bottomSignal,
  topSignal
}: MessageListVirtualProps) {
  const vRef = useRef<VirtualizerHandle>(null)

  // 稳健置底：scrollToIndex 在大列表/未测量时可能落点偏差，rAF 后再校正一次到底。
  const scrollToBottomRobust = useCallback((count: number) => {
    if (count <= 0) return
    vRef.current?.scrollToIndex(count - 1, { align: 'end' })
    requestAnimationFrame(() => {
      vRef.current?.scrollToIndex(count - 1, { align: 'end' })
    })
  }, [])

  // ===== shift：头部新增(prepend)时保持滚动位置不跳 =====
  // 从「已提交」的 ref 推导，渲染期不写 ref，避开 StrictMode 双渲染误判。
  // 判据：上一帧的首项现在出现在 index>0 → 头部插入了新内容（即使滑动窗口同时裁了尾部，
  // 长度不变也能正确识别；append+裁头时旧首项被裁掉，findIndex=-1，不会误判为 prepend）。
  const prevFirstKeyRef = useRef<string | null>(null)
  const firstKey = messages.length ? getMessageDomKey(messages[0]) : null
  let isPrepend = false
  if (prevFirstKeyRef.current !== null && firstKey !== prevFirstKeyRef.current) {
    const idx = messages.findIndex((m) => getMessageDomKey(m) === prevFirstKeyRef.current)
    if (idx > 0) isPrepend = true
  }

  useLayoutEffect(() => {
    prevFirstKeyRef.current = firstKey
  }, [firstKey])

  // 最新消息数（ref，供信号驱动的置底读取，避免 effect 依赖 messages.length 而误触发）
  const messagesLenRef = useRef(0)
  messagesLenRef.current = messages.length

  // ===== 切换会话置底：每个会话首次出现消息时滚到底 =====
  const initialScrolledForRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const sid = currentSession.username
    if (!messages.length) return
    if (initialScrolledForRef.current === sid) return
    initialScrolledForRef.current = sid
    requestAnimationFrame(() => scrollToBottomRobust(messages.length))
  }, [currentSession.username, messages.length, scrollToBottomRobust])

  // ===== 置底信号：同会话刷新/初始加载/新消息粘底等 ChatPage 明确要求置底的场景 =====
  const prevBottomSignalRef = useRef(bottomSignal)
  useLayoutEffect(() => {
    if (bottomSignal === prevBottomSignalRef.current) return
    prevBottomSignalRef.current = bottomSignal
    requestAnimationFrame(() => scrollToBottomRobust(messagesLenRef.current))
  }, [bottomSignal, scrollToBottomRobust])

  // ===== 置顶信号：日期跳转（目标日期消息在索引 0，置顶显示）=====
  const prevTopSignalRef = useRef(topSignal)
  useLayoutEffect(() => {
    if (topSignal === prevTopSignalRef.current) return
    prevTopSignalRef.current = topSignal
    requestAnimationFrame(() => vRef.current?.scrollToIndex(0, { align: 'start' }))
  }, [topSignal])

  const handleScrollToBottomClick = useCallback(() => {
    if (messages.length) {
      vRef.current?.scrollToIndex(messages.length - 1, { align: 'end', smooth: true })
    } else {
      scrollToBottom(true)
    }
  }, [messages.length, scrollToBottom])

  const rows = useMemo(() => messages.map((msg, index) => {
    const prevMsg = index > 0 ? messages[index - 1] : undefined
    const showDateDivider = shouldShowDateDivider(msg, prevMsg)
    const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
    const isSent = msg.isSend === 1
    const isSystem = isSystemMessage(msg)
    const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')
    const messageDomKey = getMessageDomKey(msg)
    const isSelectable = selectMode && !isSystem
    const isSelected = selectedMessages.has(msg.localId)

    return (
      <div
        key={messageDomKey}
        className={`message-wrapper vlist-row ${wrapperClass}${isSelectable ? ' selectable' : ''}${isSelectable && isSelected ? ' selected' : ''}`}
        data-message-key={messageDomKey}
        onClick={isSelectable ? () => onToggleSelect(msg.localId) : undefined}
      >
        {showDateDivider && (
          <div className="date-divider">
            <span>{formatDateDivider(msg.createTime)}</span>
          </div>
        )}
        <MessageBubble
          message={msg}
          session={currentSession}
          showTime={!showDateDivider && showTime}
          myAvatarUrl={myAvatarUrl}
          isGroupChat={isGroupChat(currentSession.username)}
          hasImageKey={hasImageKey === true}
          quoteStyle={quoteStyle}
          selectMode={isSelectable}
          onContextMenu={(e, message, handlers) => {
            if (message.localType === 10000) {
              return
            }

            e.preventDefault()
            e.stopPropagation()

            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              message,
              session: currentSession,
              handlers
            })
          }}
          isSelected={selectedMessages.has(msg.localId)}
        />
      </div>
    )
  }), [
    messages,
    currentSession,
    myAvatarUrl,
    hasImageKey,
    quoteStyle,
    selectedMessages,
    selectMode,
    onToggleSelect,
    setContextMenu
  ])

  if (isLoadingMessages && messages.length === 0) {
    return (
      <div className="message-list message-list--loading" ref={messageListRef}>
        <ChatBackground />
        <div className="loading-messages" aria-busy="true" aria-label="加载消息中">
          <div className="message-skeleton-date" />
          {[0, 1, 2, 3, 4].map(i => (
            <div className={`message-skeleton-row ${i === 1 || i === 4 ? 'sent' : 'received'}`} key={i}>
              <div className="message-skeleton-avatar" />
              <div className="message-skeleton-main">
                <div className="message-skeleton-name" />
                <div className="message-skeleton-bubble">
                  <span className="message-skeleton-line" />
                  <span className="message-skeleton-line message-skeleton-line--mid" />
                  {i !== 1 ? <span className="message-skeleton-line message-skeleton-line--short" /> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`message-list message-list--virtual${selectMode ? ' select-mode' : ''}`}
      ref={messageListRef}
      onScroll={onScroll}
    >
      <ChatBackground />

      {/* 加载更多指示：浮层(absolute)，不入文档流，避免影响虚拟偏移 */}
      {hasMoreMessages && isLoadingMore && (
        <div className="vlist-loading-top">
          <CircleDashed width={14} height={14} />
          <span>加载更多...</span>
        </div>
      )}

      <Virtualizer ref={vRef} scrollRef={messageListRef} shift={isPrepend}>
        {rows}
      </Virtualizer>

      <div className={`scroll-to-bottom-fab ${showScrollToBottom ? 'show' : ''}`}>
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          className="rounded-full shadow-md"
          aria-label="回到底部"
          onPress={handleScrollToBottomClick}
        >
          <ChevronDown width={16} height={16} />
        </Button>
      </div>
    </div>
  )
}
