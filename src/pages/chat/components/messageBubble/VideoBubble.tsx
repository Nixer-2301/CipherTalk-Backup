import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { CircleDashed, Play, Video } from '@gravity-ui/icons'
import type { ChatSession, Message } from '../../../../types/models'
import { lastIncrementalUpdateTime, videoInfoCache } from './mediaState'
import type { CachedVideoInfo } from './mediaState'

interface VideoBubbleProps {
  message: Message
  session: ChatSession
  isSent: boolean
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void
}

/**
 * 视频消息气泡（localType === 43）
 * 支持懒加载、缩略图显示、独立窗口播放
 */
function VideoBubble({ message, session, onContextMenu }: VideoBubbleProps) {
  const [videoInfo, setVideoInfo] = useState<CachedVideoInfo | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const videoContainerRef = useRef<HTMLDivElement>(null)

  const videoCacheKey = message.videoMd5 || `local:${message.localId}`

  // 视频懒加载
  useEffect(() => {
    if (!videoContainerRef.current) return

    const scrollRoot = videoContainerRef.current.closest('.message-list') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        root: scrollRoot,
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)
    return () => observer.disconnect()
  }, [])

  // 加载视频信息
  useEffect(() => {
    if (!isVisible || videoInfo || videoLoading) return
    if (!message.videoMd5 && !message.rawContent) return

    const cached = videoInfoCache.get(videoCacheKey)
    if (cached) {
      const shouldRefetch = !cached.exists && cached.cachedAt < lastIncrementalUpdateTime
      console.log('[Video][Renderer] cache-check', {
        localId: message.localId,
        sessionId: session.username,
        videoCacheKey,
        hasCached: true,
        cachedExists: cached.exists,
        shouldRefetch,
        diagnostics: cached.diagnostics
      })
      if (!shouldRefetch) {
        setVideoInfo(cached)
        return
      }
      videoInfoCache.delete(videoCacheKey)
    }

    setVideoLoading(true)
    console.log('[Video][Renderer] request-start', {
      localId: message.localId,
      sessionId: session.username,
      videoCacheKey,
      videoMd5: message.videoMd5,
      rawPreview: String(message.rawContent || '').replace(/\s+/g, ' ').slice(0, 220)
    })

    window.electronAPI.video.getVideoInfo(message.videoMd5 || '', message.rawContent).then((result) => {
      if (result && result.success) {
        const info: CachedVideoInfo = {
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl,
          diagnostics: result.diagnostics,
          cachedAt: Date.now()
        }
        videoInfoCache.set(videoCacheKey, info)
        setVideoInfo(info)
        console.log('[Video][Renderer] request-success', {
          localId: message.localId,
          sessionId: session.username,
          videoCacheKey,
          exists: result.exists,
          videoUrl: result.videoUrl,
          diagnostics: result.diagnostics
        })
        if (!result.exists && result.diagnostics) {
          console.warn('[Video] 视频定位失败:', {
            localId: message.localId,
            diagnostics: result.diagnostics
          })
        }
      } else {
        const info: CachedVideoInfo = { exists: false, cachedAt: Date.now() }
        videoInfoCache.set(videoCacheKey, info)
        setVideoInfo(info)
        console.warn('[Video][Renderer] request-unsuccessful', {
          localId: message.localId,
          sessionId: session.username,
          videoCacheKey,
          result
        })
      }
    }).catch((error) => {
      const info: CachedVideoInfo = { exists: false, cachedAt: Date.now() }
      videoInfoCache.set(videoCacheKey, info)
      setVideoInfo(info)
      console.error('[Video][Renderer] request-error', {
        localId: message.localId,
        sessionId: session.username,
        videoCacheKey,
        error: String(error)
      })
    }).finally(() => {
      setVideoLoading(false)
    })
  }, [isVisible, videoInfo, videoLoading, message.videoMd5, message.rawContent, message.localId, videoCacheKey, session.username])

  // 播放视频 - 打开独立窗口
  const handlePlayVideo = useCallback(async () => {
    if (!videoInfo?.videoUrl) return
    try {
      await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
    } catch {
      // ignore
    }
  }, [videoInfo?.videoUrl])

  // 未进入可视区域时显示占位符
  if (!isVisible) {
    return (
      <div className="video-placeholder" ref={videoContainerRef} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <Video width={24} height={24} />
      </div>
    )
  }

  // 加载中
  if (videoLoading) {
    return (
      <div className="video-loading" ref={videoContainerRef} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <CircleDashed width={20} height={20} className="spin" />
      </div>
    )
  }

  // 视频不存在
  if (!videoInfo?.exists || !videoInfo.videoUrl) {
    return (
      <button
        className="video-unavailable"
        ref={videoContainerRef as unknown as React.RefObject<HTMLButtonElement>}
        title={videoInfo?.diagnostics?.summary || '点击重试'}
        onClick={() => {
          console.log('[Video][Renderer] retry-click', {
            localId: message.localId,
            sessionId: session.username,
            videoCacheKey,
            diagnostics: videoInfo?.diagnostics
          })
          videoInfoCache.delete(videoCacheKey)
          setVideoInfo(null)
          setVideoLoading(false)
        }}
        type="button"
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      >
        <Video width={24} height={24} />
        <span>视频不可用</span>
        {videoInfo?.diagnostics?.summary && (
          <span className="video-reason">{videoInfo.diagnostics.summary}</span>
        )}
        <span className="video-action">点击重试</span>
      </button>
    )
  }

  // 显示缩略图，点击打开独立播放窗口
  const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
  return (
    <div className="video-thumb-wrapper" ref={videoContainerRef} onClick={handlePlayVideo} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
      {thumbSrc ? (
        <img src={thumbSrc} alt="视频缩略图" className="video-thumb" />
      ) : (
        <div className="video-thumb-placeholder">
          <Video width={32} height={32} />
        </div>
      )}
      <div className="video-play-button">
        <Play width={36} height={36} fill="currentColor" />
      </div>
      {message.videoDuration && message.videoDuration > 0 && (
        <span className="video-duration-tag">
          {Math.floor(message.videoDuration / 60)}:{String(message.videoDuration % 60).padStart(2, '0')}
        </span>
      )}
    </div>
  )
}

function areVideoBubblePropsEqual(prev: VideoBubbleProps, next: VideoBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.isSent === next.isSent
}

export default memo(VideoBubble, areVideoBubblePropsEqual)
