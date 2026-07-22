import { useEffect, useRef, useState } from 'react'
import { CircleDashed } from '@gravity-ui/icons'
import { sentenceSegmentLabel, splitSuggestionBursts } from './chat/replySuggest'
import './reply-tile.css'

/**
 * 回复建议磁贴窗口：贴在微信主窗口右侧（放不下翻到左侧），高度跟随微信。
 * 位置/显隐由主进程 windowManager 的跟踪循环控制；本页聚合各参与会话的建议，顶部可切换会话。
 */

type TileState = 'pending' | 'loading' | 'error' | 'ready' | 'gone'
type TileEntry = {
  sessionId: string
  sessionName: string
  avatarUrl?: string
  state: TileState
  suggestions?: string[]
  batches?: Array<{ id: string; targetKey: string; quote: string; suggestions: string[] }>
  pendingContinue?: boolean
  error?: string
}

function getAvatarFallback(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}

export default function ReplyTileWindow() {
  // 用 ref 存全量，state 只存一个自增版本号触发重渲染（避免频繁重建 Map 对象）
  const entriesRef = useRef<Map<string, TileEntry>>(new Map())
  const [, forceRender] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected
  const [copied, setCopied] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  useEffect(() => {
    const root = document.getElementById('root')
    const prevHtmlBackground = document.documentElement.style.background
    const prevHtmlOverflow = document.documentElement.style.overflow
    const prevBodyBackground = document.body.style.background
    const prevBodyOverflow = document.body.style.overflow
    const prevRootBackground = root?.style.background

    document.documentElement.style.background = 'transparent'
    document.documentElement.style.overflow = 'hidden'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    if (root) root.style.background = 'transparent'
    window.electronAPI.window.replyTileReady()

    const unsubscribe = window.electronAPI.window.replyTile.onUpdate((entry) => {
      const map = entriesRef.current
      if (entry.state === 'gone') {
        map.delete(entry.sessionId)
        if (selectedRef.current === entry.sessionId) setSelected(null)
      } else {
        map.set(entry.sessionId, entry)
        if (entry.state === 'ready' || entry.state === 'error') setRetrying((value) => (
          value?.startsWith(`${entry.sessionId}:`) ? null : value
        ))
        // 新一轮生成/新建议时自动切到该会话；用户手动切走后，下次有新活动再跟随
        if (entry.state === 'loading' || entry.state === 'ready') setSelected(entry.sessionId)
        else if (selectedRef.current === null) setSelected(entry.sessionId)
      }
      forceRender((v) => v + 1)
    })

    return () => {
      unsubscribe()
      document.documentElement.style.background = prevHtmlBackground
      document.documentElement.style.overflow = prevHtmlOverflow
      document.body.style.background = prevBodyBackground
      document.body.style.overflow = prevBodyOverflow
      if (root && prevRootBackground !== undefined) root.style.background = prevRootBackground
    }
  }, [])

  const handleCopy = (text: string, tag: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(tag)
      window.setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1200)
    })
  }

  const handleContinue = (sessionId: string) => {
    window.electronAPI.window.replyTile.continue(sessionId)
  }

  const handleSkip = (sessionId: string) => {
    window.electronAPI.window.replyTile.skip(sessionId)
  }

  const handleRetry = (sessionId: string, batchId: string, suggestionIndex: number) => {
    setRetrying(`${sessionId}:${batchId}:${suggestionIndex}`)
    window.electronAPI.window.replyTile.retry({ sessionId, batchId, suggestionIndex })
  }

  const entries = Array.from(entriesRef.current.values())
  const current = (selected && entriesRef.current.get(selected)) || entries[0] || null
  const currentBatches = current?.batches?.length
    ? current.batches
    : current?.suggestions?.length
      ? [{ id: `${current.sessionId}:legacy`, targetKey: `${current.sessionId}:legacy`, quote: '最新一条消息', suggestions: current.suggestions }]
      : []

  return (
    <div className="reply-tile">
      <div className="reply-tile__header">
        <span className="reply-tile__title">回复建议</span>
      </div>

      {entries.length === 0 ? (
        <div className="reply-tile__empty">在聊天窗口开启「磁贴窗口」参与后，这里会显示回复建议</div>
      ) : (
        <>
          <div className="reply-tile__tabs">
            {entries.map((e) => (
              <button
                key={e.sessionId}
                type="button"
                className={`reply-tile__tab${current?.sessionId === e.sessionId ? ' reply-tile__tab--active' : ''}`}
                title={e.sessionName}
                onClick={() => setSelected(e.sessionId)}
              >
                <span className="reply-tile__avatar" aria-hidden="true">
                  {e.avatarUrl ? <img src={e.avatarUrl} alt="" /> : <span>{getAvatarFallback(e.sessionName)}</span>}
                </span>
                {e.state === 'loading' && <span className="reply-tile__tab-dot reply-tile__tab-dot--busy" />}
                {e.state === 'ready' && <span className="reply-tile__tab-dot reply-tile__tab-dot--ready" />}
                <span className="reply-tile__tab-name">{e.sessionName}</span>
              </button>
            ))}
          </div>

          <div className="reply-tile__body">
            {currentBatches.map((batch) => (
              <div className="reply-tile__batch" key={batch.id}>
                <div className="reply-tile__quote">针对：{batch.quote}</div>
                {batch.suggestions.map((text, index) => {
                  const segs = splitSuggestionBursts(text)
                  return (
                    <div className="reply-tile__card" key={`${batch.id}:${index}:${text}`}>
                      <button
                        className="reply-tile__retry"
                        disabled={Boolean(retrying)}
                        type="button"
                        title="重试这条建议"
                        onClick={() => current && handleRetry(current.sessionId, batch.id, index)}
                      >
                        <CircleDashed width={12} height={12} className={retrying === `${current?.sessionId}:${batch.id}:${index}` ? 'animate-spin' : ''} />
                        <span>重试</span>
                      </button>
                      {segs.map((seg, segIndex) => {
                        const tag = `${current?.sessionId}:${batch.id}:${index}:${segIndex}`
                        const label = sentenceSegmentLabel(segIndex)
                        return (
                          <button
                            className="reply-tile__seg"
                            key={tag}
                            type="button"
                            title={segs.length > 1 ? `点击复制${label}` : '点击复制'}
                            onClick={() => handleCopy(seg, tag)}
                          >
                            {segs.length > 1 && <span className="reply-tile__seg-index">{label}</span>}
                            <span className="reply-tile__seg-text">{seg}</span>
                            {copied === tag && <span className="reply-tile__copied">已复制</span>}
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}

            {(!current || (current.state === 'pending' && currentBatches.length === 0)) && (
              <div className="reply-tile__hint">等待新消息后生成回复建议…</div>
            )}

            {current?.state === 'error' && (
              <div className="reply-tile__hint reply-tile__hint--error">{current.error || '生成失败'}</div>
            )}

            {current?.state === 'loading' && (
              <div className="reply-tile__loading">
                <CircleDashed width={14} height={14} className="animate-spin" />
                <span>正在生成回复建议…</span>
              </div>
            )}

            {current && current.state !== 'loading' && current.pendingContinue && (
              <div className="reply-tile__continue">
                <span>生成期间收到了新消息，是否继续生成？</span>
                <div className="reply-tile__actions">
                  <button className="reply-tile__action" type="button" onClick={() => handleContinue(current.sessionId)}>继续</button>
                  <button className="reply-tile__action" type="button" onClick={() => handleSkip(current.sessionId)}>暂不</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
