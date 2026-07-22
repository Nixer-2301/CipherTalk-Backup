import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { CircleDashed, Xmark } from '@gravity-ui/icons'
import { nanoid } from 'nanoid'
import { createLiquidGlassMap, type GlassFilterMap, type GlassShapeOptions } from '../../../utils/liquidGlass'
import type { ChatSession, Message } from '../../../types/models'
import {
  REPLY_SUGGEST_CONFIG_KEY,
  type ReplySuggestSettings,
  buildFriendPersonaContext,
  buildMyPersonaContext,
  buildMyRecentTexts,
  buildSuggestContext,
  collectPendingImages,
  getReplySuggestSettings,
  loadFriendPersona,
  loadMyPersona,
  sentenceSegmentLabel,
  splitSuggestionBursts,
} from '../replySuggest'
import { useTopToast } from '../hooks/useTopToast'

const QUIET_MS = 5000
// 只对"刚收到"的对方消息生成建议：超过这个时长的老消息（比如翻历史、切进老会话）不触发
const FRESH_SECONDS = 10 * 60


type ReplySuggestBatch = {
  id: string
  targetKey: string
  quote: string
  suggestions: string[]
}

type ReplaceSuggestionTarget = {
  batchId: string
  suggestionIndex: number
}

function quoteFromLastIncoming(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.isSend === 1) continue
    const text = m.parsedContent?.trim()
    if (text) return text.slice(0, 120)
  }
  return '最新一条消息'
}

// 液态玻璃折射贴图参数：卡片/胶囊是圆角矩形（气泡同款），关闭按钮是圆形（与朋友圈/Agent 按钮同参）
const GLASS_RECT: GlassShapeOptions = { halfX: 0.22, halfY: 0.14, radius: 0.7, edge: 0.2, feather: 1.2, strength: 1.6 }
const GLASS_CIRCLE: GlassShapeOptions = { halfX: 0.18, halfY: 0.18, radius: 0.18, edge: 0.02, feather: 0.35, strength: 3 }

type GlassShellProps = {
  as?: 'div' | 'button'
  shape?: GlassShapeOptions
  children: ReactNode
} & HTMLAttributes<HTMLElement> & { type?: 'button'; 'aria-label'?: string }

/**
 * 液态玻璃外壳（同 LiquidGlassBubble 方案）：按自身尺寸生成位移贴图，
 * backdrop-filter 折射背后的消息内容；卡片尺寸随内容变，ResizeObserver 跟随重建。
 * 贴图未就绪时不写行内样式，退回 CSS 里的普通毛玻璃兜底。
 */
function GlassShell({ as: Tag = 'div', shape = GLASS_RECT, children, style: _ignored, ...rest }: GlassShellProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [filterId] = useState(() => `reply-glass-${nanoid(6)}`)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const next = createLiquidGlassMap(Math.round(rect.width), Math.round(rect.height), shape)
      if (next) setMap(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
    // shape 是模块级常量，不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const backdrop = map ? `url(#${filterId}) blur(2px) saturate(180%) brightness(1.05)` : undefined
  return (
    <Tag
      ref={ref as never}
      style={backdrop ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : undefined}
      {...rest}
    >
      {map && (
        <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
          <filter
            id={filterId}
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={map.width}
            height={map.height}
          >
            <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
            <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
      {children}
    </Tag>
  )
}

/**
 * 悬浮回复建议栏：开启后，最后一条消息是对方发来且 5 秒内没有更新时，
 * 用最近上下文调一次轻量模型生成建议卡片；点击卡片复制到剪贴板。
 * 无建议时不渲染任何 DOM。
 */
export function ReplySuggestBar({ session, messages }: { session: ChatSession; messages: Message[] }) {
  const [settings, setSettings] = useState<ReplySuggestSettings | null>(null)
  const [batches, setBatches] = useState<ReplySuggestBatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { showTopToast } = useTopToast()
  // 已生成过建议的触发消息 key，避免同一条消息反复触发（含失败后的重试风暴）
  const handledKeyRef = useRef<string | null>(null)
  // 生成代次：我发出新消息后 +1，作废还在飞的旧生成结果
  const runSeqRef = useRef(0)
  const latestTargetKeyRef = useRef<string | null>(null)
  const loadingRef = useRef(false)
  const sessionRef = useRef(session.username)
  const [pendingContinueKey, setPendingContinueKey] = useState<string | null>(null)
  const [retryingSuggestion, setRetryingSuggestion] = useState<string | null>(null)
  sessionRef.current = session.username

  // 会话级设置：加载 + 跟随 config 变更（ChatHeader 下拉里改动后这里立即生效）
  useEffect(() => {
    let cancelled = false
    // 等当前会话配置加载完成后再镜像到共享磁贴，避免沿用上一会话设置。
    setSettings(null)
    void getReplySuggestSettings(session.username).then((s) => {
      if (!cancelled) setSettings(s)
    })
    const off = window.electronAPI.config.onChanged(({ key }) => {
      if (key !== REPLY_SUGGEST_CONFIG_KEY) return
      void getReplySuggestSettings(session.username).then((s) => {
        if (!cancelled) setSettings(s)
      })
    })
    return () => { cancelled = true; off() }
  }, [session.username])

  // 切会话/关闭功能：清空现有建议
  useEffect(() => {
    setBatches([])
    setPendingContinueKey(null)
    setError(null)
    handledKeyRef.current = null
  }, [session.username])

  useEffect(() => {
    if (settings && !settings.enabled) {
      setBatches([])
      setPendingContinueKey(null)
      setError(null)
    }
  }, [settings])

  const generate = useCallback(async (
    current: ReplySuggestSettings,
    targetKey: string,
    targetQuote: string,
    options?: { count?: number; replace?: ReplaceSuggestionTarget; retryKey?: string },
  ) => {
    if (loadingRef.current) {
      if (!options?.replace) setPendingContinueKey(targetKey)
      return
    }
    const username = sessionRef.current
    const runSeq = runSeqRef.current
    const replacing = Boolean(options?.replace)
    loadingRef.current = true
    if (options?.retryKey) setRetryingSuggestion(options.retryKey)
    if (!replacing) setLoading(true)
    setError(null)
    if (!replacing) setPendingContinueKey(null)
    try {
      // 自画像：likeme 用画像卡做模仿；其它风格也拿它的连发/字数统计做连发自适应
      const myPersona = await loadMyPersona(session.username)
      let myPersonaContext: string | undefined
      let myRecentTexts: string[] | undefined
      if (current.style === 'likeme') {
        if (myPersona) {
          myPersonaContext = buildMyPersonaContext(myPersona)
        } else {
          myRecentTexts = buildMyRecentTexts(messages)
        }
      }
      const myStats = myPersona
        ? { avgBurst: myPersona.stats.avgFriendBurst, avgChars: myPersona.stats.avgFriendMsgChars }
        : undefined
      // 深度模式：克隆过对方的话，把 TA 的画像也喂进去（没克隆则静默跳过）
      let friendPersonaContext: string | undefined
      if (current.deep) {
        const friendPersona = await loadFriendPersona(session.username)
        if (friendPersona) friendPersonaContext = buildFriendPersonaContext(friendPersona)
      }
      // 上下文（语音换转写文字）+ 对方待回复的图片（多模态模型会看图）
      const [context, images] = await Promise.all([
        buildSuggestContext(username, messages, current.deep),
        collectPendingImages(username, messages),
      ])
      const voiceReplaced = context.filter((c) => c.text.startsWith('[语音] ')).length
      console.log(
        `[ReplySuggest] 生成开始：上下文 ${context.length} 条（语音转写 ${voiceReplaced} 条），待附图片 ${images.length} 张`
        + `${images.length > 0 ? `（${images.map((img) => `${Math.round(img.base64.length * 0.75 / 1024)}KB`).join(' / ')}）` : ''}`
        + `，风格=${current.style}，深度=${current.deep}`,
      )
      const res = await window.electronAPI.agent.replySuggest({
        contactName: session.displayName || session.username,
        sessionId: session.username,
        context,
        style: current.style,
        count: options?.count ?? current.count,
        deep: current.deep,
        myRecentTexts,
        myPersonaContext,
        myStats,
        friendPersonaContext,
        images: images.length > 0 ? images : undefined,
      })
      // Drop only if the session changed or I already replied.
      // If the other side sends more messages, keep this result and ask whether to continue.
      if (sessionRef.current !== username || runSeqRef.current !== runSeq) return
      if (res.success && res.suggestions?.length) {
        const vision = res.visionSupport === undefined ? '未知(按可尝试处理)' : res.visionSupport ? '支持' : '不支持'
        console.log(
          `[ReplySuggest] 生成完成：${res.suggestions.length} 条建议，实际附图 ${res.imagesAttached ?? 0} 张，模型图像输入=${vision}`,
        )
        if (options?.replace) {
          const replacement = res.suggestions[0]
          setBatches((prev) => prev.map((batch) => {
            if (batch.id !== options.replace!.batchId) return batch
            return {
              ...batch,
              suggestions: batch.suggestions.map((suggestion, index) => (
                index === options.replace!.suggestionIndex ? replacement : suggestion
              )),
            }
          }))
        } else {
          setBatches((prev) => [...prev, { id: nanoid(8), targetKey, quote: targetQuote, suggestions: res.suggestions || [] }])
        }
        setPendingContinueKey(latestTargetKeyRef.current && latestTargetKeyRef.current !== targetKey ? latestTargetKeyRef.current : null)
      } else if (!res.success) {
        console.warn('[ReplySuggest] 生成失败:', res.error)
        setError(res.error || '生成失败')
      }
    } catch (e) {
      console.warn('[ReplySuggest] 生成失败:', e)
      if (sessionRef.current === username && runSeqRef.current === runSeq) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (sessionRef.current === username && runSeqRef.current === runSeq) {
        loadingRef.current = false
        if (!replacing) setLoading(false)
        if (options?.retryKey) setRetryingSuggestion(null)
      }
    }
    // messages 刻意不进依赖：generate 只在触发定时器到点时调用，用当时闭包里的列表即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.displayName, session.username, messages])

  // 触发机制：最后一条是"刚收到"的对方消息，5 秒静默后生成。新消息到达会重跑本 effect，
  // cleanup 清掉旧定时器，天然构成"5 秒内没有更新才触发"的防抖。
  useEffect(() => {
    if (!settings?.enabled) return
    const last = messages[messages.length - 1]
    if (!last || !last.parsedContent?.trim()) return
    if (last.isSend === 1) {
      // 我已经回过了：作废还在飞的生成，清掉残留建议
      latestTargetKeyRef.current = null
      loadingRef.current = false
      runSeqRef.current += 1
      setBatches([])
      setPendingContinueKey(null)
      setError(null)
      setLoading(false)
      return
    }
    // 老消息不触发：翻历史/切进最后一条是很久前的会话，不该冒建议
    if (Date.now() / 1000 - last.createTime > FRESH_SECONDS) return
    const key = `${session.username}:${last.localId}:${last.createTime}`
    const quote = last.parsedContent.trim().slice(0, 120)
    if (key !== latestTargetKeyRef.current) {
      latestTargetKeyRef.current = key
      if (loadingRef.current || pendingContinueKey) {
        setPendingContinueKey(key)
        return
      }
    }
    if (loadingRef.current || pendingContinueKey) return
    if (key === handledKeyRef.current) return
    setError(null)
    const timer = setTimeout(() => {
      if (latestTargetKeyRef.current !== key || loadingRef.current) return
      handledKeyRef.current = key
      void generate(settings, key, quote)
    }, QUIET_MS)
    return () => clearTimeout(timer)
  }, [messages, settings, session.username, generate, pendingContinueKey])

  // 当前会话的建议镜像进磁贴（全保真：图片/画像/语音转写都已算进来）。非当前会话由主进程后台生成。
  // 只有配置加载完成且明确不参与时才推 gone，避免切会话/配置加载瞬间误删其它参与会话。
  useEffect(() => {
    if (!settings) return
    const sessionId = session.username
    const sessionName = session.displayName || session.username
    const avatarUrl = session.avatarUrl
    if (!settings.enabled || !settings.tile) {
      window.electronAPI.window.replyTile.push({ sessionId, sessionName, avatarUrl, state: 'gone' })
      return
    }
    const suggestions = batches.flatMap((b) => b.suggestions)
    const state = loading ? 'loading' : error ? 'error' : batches.length ? 'ready' : 'pending'
    window.electronAPI.window.replyTile.push({
      sessionId,
      sessionName,
      avatarUrl,
      state,
      suggestions,
      batches,
      pendingContinue: Boolean(pendingContinueKey && !loading),
      error: error || undefined,
    })
  }, [settings, loading, error, batches, pendingContinueKey, session.avatarUrl, session.displayName, session.username])

  const handleCopy = useCallback((text: string, label?: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => showTopToast(label ? `已复制${label}，逐条粘贴发送` : '已复制，去微信粘贴发送'))
      .catch(() => showTopToast('复制失败', false))
  }, [showTopToast])

  const handleRetry = useCallback(() => {
    setError(null)
    const targetKey = latestTargetKeyRef.current
    if (settings && targetKey) void generate(settings, targetKey, quoteFromLastIncoming(messages))
  }, [settings, generate, messages])

  const handleRetrySuggestion = useCallback((batch: ReplySuggestBatch, suggestionIndex: number) => {
    if (!settings) return
    const retryKey = `${batch.id}:${suggestionIndex}`
    void generate(settings, batch.targetKey, batch.quote, {
      count: 1,
      replace: { batchId: batch.id, suggestionIndex },
      retryKey,
    })
  }, [settings, generate])

  const handleContinue = useCallback(() => {
    const targetKey = pendingContinueKey || latestTargetKeyRef.current
    if (!settings || !targetKey) return
    handledKeyRef.current = targetKey
    void generate(settings, targetKey, quoteFromLastIncoming(messages))
  }, [settings, pendingContinueKey, generate, messages])

  const handleSkipContinue = useCallback(() => {
    if (pendingContinueKey) handledKeyRef.current = pendingContinueKey
    setPendingContinueKey(null)
  }, [pendingContinueKey])

  useEffect(() => {
    const offContinue = window.electronAPI.window.replyTile.onContinue((sessionId) => {
      if (sessionId === session.username) handleContinue()
    })
    const offSkip = window.electronAPI.window.replyTile.onSkip((sessionId) => {
      if (sessionId === session.username) handleSkipContinue()
    })
    const offRetry = window.electronAPI.window.replyTile.onRetry((payload) => {
      if (payload.sessionId !== session.username) return
      const batch = batches.find((item) => item.id === payload.batchId)
      if (!batch) return
      handleRetrySuggestion(batch, payload.suggestionIndex)
    })
    return () => {
      offContinue()
      offSkip()
      offRetry()
    }
  }, [session.username, handleContinue, handleSkipContinue, handleRetrySuggestion, batches])

  if (!settings?.enabled) return null
  if (!loading && !error && batches.length === 0 && !pendingContinueKey) return null

  return (
    <div className="reply-suggest-bar" aria-live="polite">
      <div className="reply-suggest-bar__stack">
        {batches.length > 0 && (
          <div className="reply-suggest-bar__batches">
            {batches.map((batch) => (
              <div className="reply-suggest-bar__batch" key={batch.id}>
                <div className="reply-suggest-bar__quote">针对：{batch.quote}</div>
                <div className="reply-suggest-bar__cards">
                  {batch.suggestions.map((text, index) => {
                    const segs = splitSuggestionBursts(text)
                    return (
                      <GlassShell className="reply-suggest-bar__card" key={`${batch.id}:${index}:${text}`}>
                        <button
                          aria-label="重试这条建议"
                          className="reply-suggest-bar__card-retry"
                          disabled={Boolean(retryingSuggestion)}
                          title="重试这条建议"
                          type="button"
                          onClick={() => handleRetrySuggestion(batch, index)}
                        >
                          <CircleDashed width={12} height={12} className={retryingSuggestion === `${batch.id}:${index}` ? 'animate-spin' : ''} />
                          <span>重试</span>
                        </button>
                        {segs.map((seg, segIndex) => {
                          const label = sentenceSegmentLabel(segIndex)
                          return (
                            <button
                              className="reply-suggest-bar__seg"
                              key={`${segIndex}:${seg}`}
                              title={segs.length > 1 ? `点击复制${label}` : '点击复制'}
                              type="button"
                              onClick={() => handleCopy(seg, segs.length > 1 ? label : undefined)}
                            >
                              {segs.length > 1 && <span className="reply-suggest-bar__seg-index">{label}</span>}
                              <span className="reply-suggest-bar__seg-text">{seg}</span>
                            </button>
                          )
                        })}
                      </GlassShell>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <GlassShell className="reply-suggest-bar__loading">
            <CircleDashed width={14} height={14} className="animate-spin" />
            <span>正在生成回复建议…</span>
          </GlassShell>
        )}

        {!loading && pendingContinueKey && (
          <GlassShell className="reply-suggest-bar__continue">
            <span>生成期间收到了新消息，是否继续生成？</span>
            <button className="reply-suggest-bar__retry" type="button" onClick={handleContinue}>继续</button>
            <button className="reply-suggest-bar__retry" type="button" onClick={handleSkipContinue}>暂不</button>
          </GlassShell>
        )}

        {!loading && error && (
          <GlassShell className="reply-suggest-bar__error" title={error}>
            <span>生成失败</span>
            <button className="reply-suggest-bar__retry" type="button" onClick={handleRetry}>重试</button>
          </GlassShell>
        )}
      </div>

      <GlassShell
        as="button"
        aria-label="关闭回复建议"
        className="reply-suggest-bar__close"
        shape={GLASS_CIRCLE}
        type="button"
        onClick={() => {
          setBatches([])
          setError(null)
          setPendingContinueKey(null)
        }}
      >
        <Xmark width={14} height={14} />
      </GlassShell>
    </div>
  )
}
