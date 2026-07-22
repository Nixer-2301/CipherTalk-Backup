import { useCallback, useEffect, useRef, useState } from 'react'

interface ScrollDeps {
  hasMoreMessages: boolean
  hasMoreMessagesAfter: boolean
  currentOffset: number
  isDateJumpMode: boolean
  loadMessages: (sessionId: string, offset?: number) => void
  loadMoreMessagesInDateJumpMode: () => void
  loadMoreMessagesAfterInDateJumpMode: () => void
}

interface ScrollRefs {
  messageListRef: React.RefObject<HTMLDivElement | null>
  isLoadingMoreRef: React.RefObject<boolean>
  currentSessionIdRef: React.RefObject<string | null>
}

export function useThrottledScroll(refs: ScrollRefs, deps: ScrollDeps) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const lastScrollTopRef = useRef(0)
  const scrollRafRef = useRef<number>(0)
  const depsRef = useRef(deps)

  // 保持 deps ref 为最新值
  useEffect(() => { depsRef.current = deps })

  // 卸载时取消未执行的 rAF
  useEffect(() => () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current) }, [])

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      const el = refs.messageListRef.current
      if (!el) return

      const { scrollTop, clientHeight, scrollHeight } = el
      const isScrollingUp = scrollTop < lastScrollTopRef.current - 4
      lastScrollTopRef.current = scrollTop

      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      setShowScrollToBottom(distanceFromBottom > 300)

      const d = depsRef.current
      const sessionId = refs.currentSessionIdRef.current
      if (!refs.isLoadingMoreRef.current && sessionId) {
        const topThreshold = Math.max(clientHeight * 2, 1200)
        const bottomThreshold = clientHeight * 0.3

        if (isScrollingUp && scrollTop < topThreshold && d.hasMoreMessages) {
          if (d.isDateJumpMode) {
            d.loadMoreMessagesInDateJumpMode()
          } else {
            d.loadMessages(sessionId, d.currentOffset)
          }
        }

        if (d.isDateJumpMode && distanceFromBottom < bottomThreshold && d.hasMoreMessagesAfter) {
          d.loadMoreMessagesAfterInDateJumpMode()
        }
      }
    })
  }, [])

  return { handleScroll, showScrollToBottom }
}
