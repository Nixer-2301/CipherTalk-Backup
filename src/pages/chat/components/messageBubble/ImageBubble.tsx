import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsRotateLeft, CircleDashed, Picture } from '@gravity-ui/icons'
import { LivePhotoIcon } from '../../../../components/LivePhotoIcon'
import type { ChatSession, Message } from '../../../../types/models'
import { resolveImageDisplaySize, type ImageDisplaySize } from '../../utils/imageSize'
import { enqueueDecrypt, imageDataUrlCache, subscribeImageUpdate, subscribeImageCacheResolved } from './mediaState'

type ImageStatusVariant = 'placeholder' | 'loading' | 'unavailable' | 'no-key'

interface ImageStatusCardProps {
  variant: ImageStatusVariant
  size: ImageDisplaySize
  clicked?: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

/**
 * 图片非就绪状态的统一卡片：占位 / 解密中 / 未解密 / 未配置密钥。
 * 四种状态共用与最终图片一致的尺寸（由 size 决定），消除解密前后的高度跳变。
 */
function ImageStatusCard({ variant, size, clicked, containerRef, onClick, onContextMenu }: ImageStatusCardProps) {
  const style = { width: size.width, height: size.height }

  if (variant === 'loading') {
    return (
      <div ref={containerRef} className="image-loading" style={style} onContextMenu={onContextMenu}>
        <CircleDashed width={20} height={20} className="spin" />
      </div>
    )
  }

  if (variant === 'placeholder') {
    return (
      <div ref={containerRef} className="image-placeholder" style={style} onContextMenu={onContextMenu}>
        <Picture width={24} height={24} />
      </div>
    )
  }

  if (variant === 'no-key') {
    return (
      <div ref={containerRef} className="image-no-key" style={style} onContextMenu={onContextMenu}>
        <Picture width={24} height={24} />
        <span>请配置图片解密密钥</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`image-unavailable ${clicked ? 'clicked' : ''}`}
      style={style}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <Picture width={24} height={24} />
      <span>图片未解密</span>
      <span className="image-action">{clicked ? '已点击…' : '点击解密'}</span>
    </div>
  )
}

interface ImageBubbleProps {
  message: Message
  session: ChatSession
  hasImageKey?: boolean
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void
}

/**
 * 图片消息气泡（localType === 3）
 * 支持懒加载、解密、缓存、缩略图升级、实况照片等
 */
function ImageBubble({ message, session, hasImageKey, onContextMenu }: ImageBubbleProps) {
  const syncVersion = useRef(0)
  // We'll use a ref that gets updated - simplest way to track sync version without full store import
  // In practice the parent or store passes this

  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(() => {
    const cacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
    return imageDataUrlCache.get(cacheKey)
  })
  const [imageLiveVideoPath, setImageLiveVideoPath] = useState<string | undefined>()
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const [isVisible, setIsVisible] = useState(false)

  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageUpgradeTimerRef = useRef<number | null>(null)
  const imageRecoveringRef = useRef(false)
  const imageRecoverRetryCountRef = useRef(0)
  const lastRecoverTriedPathRef = useRef<string | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)

  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`

  // 占位/解密中/未解密/已解密四态共用同一尺寸，消除解密前后高度跳变
  const displaySize = useMemo(() => resolveImageDisplaySize(message), [message])

  const detectImageMimeFromBase64 = useCallback((base64: string): string => {
    try {
      const head = window.atob(base64.slice(0, 48))
      const bytes = new Uint8Array(head.length)
      for (let i = 0; i < head.length; i++) {
        bytes[i] = head.charCodeAt(i)
      }
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
      if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      ) {
        return 'image/webp'
      }
    } catch { }
    return 'image/jpeg'
  }, [])

  // 使用 IntersectionObserver 检测图片是否进入可视区域（懒加载）
  useEffect(() => {
    if (!imageContainerRef.current) return

    const scrollRoot = imageContainerRef.current.closest('.message-list') as HTMLElement | null
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
        // 预加载约 2 屏（原 1000px 会让快速滚动时一次性解码过多图片造成卡顿）
        rootMargin: '400px 0px',
        threshold: 0
      }
    )

    observer.observe(imageContainerRef.current)

    return () => observer.disconnect()
  }, [])

  // 请求图片解密
  const requestImageDecrypt = useCallback(async (forceUpdate = false) => {
    if (imageLoading) return
    setImageLoading(true)
    setImageError(false)

    try {
      if (message.imageMd5 || message.imageDatName) {
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName,
          createTime: message.createTime,
          force: forceUpdate,
          quick: !forceUpdate
        })

        if (result.success && result.localPath) {
          imageDataUrlCache.set(imageCacheKey, result.localPath)
          setImageLocalPath(result.localPath)
          if ((result as any).liveVideoPath) setImageLiveVideoPath((result as any).liveVideoPath)
          setImageHasUpdate(Boolean((result as { isThumb?: boolean }).isThumb))
          return (result as any).liveVideoPath as string | undefined
        }
      }

      const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId), message.createTime)
      if (fallback.success && fallback.data) {
        const dataUrl = `data:${detectImageMimeFromBase64(fallback.data)};base64,${fallback.data}`
        imageDataUrlCache.set(imageCacheKey, dataUrl)
        setImageLocalPath(dataUrl)
        setImageHasUpdate(false)
        setImageError(false)
        return
      }

      setImageError(true)
    } catch {
      setImageError(true)
    } finally {
      setImageLoading(false)
    }
  }, [imageLoading, message.imageMd5, message.imageDatName, message.localId, message.createTime, session.username, imageCacheKey, detectImageMimeFromBase64])

  // 点击图片解密
  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    void requestImageDecrypt(true)
  }, [requestImageDecrypt])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
    }
  }, [])

  // 自动尝试从缓存解析图片，如果没有缓存则自动解密（仅在可见时触发）
  useEffect(() => {
    if (!isVisible) return

    if (imageLocalPath) return
    // 守卫：每个 cacheKey 只自动解密一次。解密失败也不自动重试，
    // 避免失败图片无限重解密（用户可点击手动重试）。
    if (imageUpdateCheckedRef.current === imageCacheKey) return

    imageUpdateCheckedRef.current = imageCacheKey

    let cancelled = false

    const doDecrypt = async () => {
      if (cancelled) return
      setImageLoading(true)

      try {
        // 先尝试从缓存获取
        try {
          const result = await window.electronAPI.image.resolveCache({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            createTime: message.createTime
          })
          if (cancelled) return
          if (result.success && result.localPath) {
            imageDataUrlCache.set(imageCacheKey, result.localPath)
            setImageLocalPath(result.localPath)
            if ((result as any).liveVideoPath) setImageLiveVideoPath((result as any).liveVideoPath)
            setImageHasUpdate(Boolean(result.hasUpdate))
            setImageError(false)
            return
          }
        } catch { /* continue */ }

        // 缓存中没有，自动尝试解密
        try {
          const decryptResult = await window.electronAPI.image.decrypt({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            createTime: message.createTime,
            force: false,
            quick: true
          })
          if (cancelled) return
          if (decryptResult.success && decryptResult.localPath) {
            imageDataUrlCache.set(imageCacheKey, decryptResult.localPath)
            setImageLocalPath(decryptResult.localPath)
            if ((decryptResult as any).liveVideoPath) setImageLiveVideoPath((decryptResult as any).liveVideoPath)
            setImageHasUpdate(false)
            setImageError(false)
            return
          }
        } catch { /* continue */ }

        // 兜底：从数据库获取原始图片数据
        try {
          const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId), message.createTime)
          if (cancelled) return
          if (fallback.success && fallback.data) {
            const dataUrl = `data:${detectImageMimeFromBase64(fallback.data)};base64,${fallback.data}`
            imageDataUrlCache.set(imageCacheKey, dataUrl)
            setImageLocalPath(dataUrl)
            setImageHasUpdate(false)
            setImageError(false)
            return
          }
        } catch { /* continue */ }

        setImageError(true)
      } finally {
        setImageLoading(false)
      }
    }

    enqueueDecrypt(doDecrypt)

    return () => {
      // 仅取消在飞的解密；不重置守卫 ref，否则守卫失效会导致无限重解密
      cancelled = true
    }
  }, [
    isVisible,
    imageCacheKey,
    imageLocalPath,
    message.imageMd5,
    message.imageDatName,
    message.localId,
    message.createTime,
    session.username,
    detectImageMimeFromBase64
  ])

  // 若已显示缩略图且检测到高清图可用，循环尝试升级
  useEffect(() => {
    if (!isVisible) return
    if (!imageLocalPath) return
    if (!imageLocalPath.toLowerCase().includes('_thumb')) return
    if (!imageHasUpdate) return

    if (imageUpgradeTimerRef.current) {
      window.clearInterval(imageUpgradeTimerRef.current)
    }

    imageUpgradeTimerRef.current = window.setInterval(() => {
      if (!imageLoading) {
        void requestImageDecrypt(true)
      }
    }, 6000)

    if (!imageLoading) {
      void requestImageDecrypt(true)
    }

    return () => {
      if (imageUpgradeTimerRef.current) {
        window.clearInterval(imageUpgradeTimerRef.current)
        imageUpgradeTimerRef.current = null
      }
    }
  }, [isVisible, imageLocalPath, imageHasUpdate, imageLoading, requestImageDecrypt])

  const handleOpenImage = useCallback(() => {
    if (!imageLocalPath) return
    void window.electronAPI.window.openImageViewerWindow(imageLocalPath, imageLiveVideoPath).catch((error) => {
      console.error('[ChatPage] 打开图片查看器失败:', error)
    })
  }, [imageLocalPath, imageLiveVideoPath])

  const recoverBrokenImagePath = useCallback(async () => {
    if (!session.username) return
    if (imageRecoveringRef.current) return
    if (imageRecoverRetryCountRef.current >= 3) return

    const failedPath = imageLocalPath || '__empty__'
    if (lastRecoverTriedPathRef.current === failedPath && !imageHasUpdate) return
    lastRecoverTriedPathRef.current = failedPath
    imageRecoverRetryCountRef.current += 1
    imageRecoveringRef.current = true
    setImageLoading(true)

    try {
      const payload = {
        sessionId: session.username,
        imageMd5: message.imageMd5 || undefined,
        imageDatName: message.imageDatName,
        createTime: message.createTime
      }

      try {
        const cached = await window.electronAPI.image.resolveCache(payload)
        if (cached.success && cached.localPath && cached.localPath !== imageLocalPath) {
          imageDataUrlCache.set(imageCacheKey, cached.localPath)
          setImageLocalPath(cached.localPath)
          setImageHasUpdate(cached.localPath.toLowerCase().includes('_thumb'))
          setImageError(false)
          return
        }
      } catch { /* continue */ }

      try {
        const refreshed = await window.electronAPI.image.decrypt({ ...payload, force: true })
        if (refreshed.success && refreshed.localPath) {
          imageDataUrlCache.set(imageCacheKey, refreshed.localPath)
          setImageLocalPath(refreshed.localPath)
          setImageHasUpdate(Boolean((refreshed as { isThumb?: boolean }).isThumb))
          if ((refreshed as any).liveVideoPath) setImageLiveVideoPath((refreshed as any).liveVideoPath)
          setImageError(false)
          return
        }
      } catch { /* continue */ }

      try {
        const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId), message.createTime)
        if (fallback.success && fallback.data) {
          const dataUrl = `data:${detectImageMimeFromBase64(fallback.data)};base64,${fallback.data}`
          imageDataUrlCache.set(imageCacheKey, dataUrl)
          setImageLocalPath(dataUrl)
          setImageHasUpdate(false)
          setImageError(false)
          return
        }
      } catch { /* continue */ }

      setImageError(true)
    } finally {
      setImageLoading(false)
      imageRecoveringRef.current = false
      imageRecoverRetryCountRef.current = 0
    }
  }, [
    message.imageMd5,
    message.imageDatName,
    message.localId,
    message.createTime,
    session.username,
    imageLocalPath,
    imageHasUpdate,
    imageCacheKey,
    detectImageMimeFromBase64
  ])

  // 监听图片更新事件（共享分发器，避免每条气泡各自注册 IPC 监听）
  useEffect(() => {
    return subscribeImageUpdate((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
  }, [message.imageDatName, message.imageMd5])

  // 监听缓存解析事件（共享分发器）
  useEffect(() => {
    return subscribeImageCacheResolved((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        imageDataUrlCache.set(imageCacheKey, payload.localPath)
        setImageLocalPath(payload.localPath)
        setImageHasUpdate(payload.localPath.toLowerCase().includes('_thumb'))
        setImageError(false)
      }
    })
  }, [imageCacheKey, message.imageDatName, message.imageMd5])

  // 没有配置密钥时显示提示
  if (hasImageKey === false) {
    return (
      <ImageStatusCard
        variant="no-key"
        size={displaySize}
        containerRef={imageContainerRef}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      />
    )
  }

  // 已有缓存图片，直接显示
  if (imageLocalPath) {
    return (
      <div
        className="image-message-wrapper"
        ref={imageContainerRef}
        style={{ width: displaySize.width, height: displaySize.height }}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      >
        <img
          src={imageLocalPath}
          alt="图片"
          className="image-message"
          style={{ width: '100%', height: '100%' }}
          decoding="async"
          onClick={() => { void handleOpenImage() }}
          onLoad={() => setImageError(false)}
          onError={() => {
            setImageError(true)
            void recoverBrokenImagePath()
          }}
        />
        {imageHasUpdate && (
          <button
            type="button"
            className="image-update-button"
            title="检测到高清图，点击更新"
            onClick={(e) => {
              e.stopPropagation()
              void requestImageDecrypt(true)
            }}
          >
            <ArrowsRotateLeft width={14} height={14} />
          </button>
        )}
        {imageLiveVideoPath && (
          <div className="media-badge live">
            <LivePhotoIcon size={14} />
          </div>
        )}
        {imageLoading && (
          <div className="image-loading-overlay">
            <CircleDashed width={20} height={20} className="spin" />
          </div>
        )}
      </div>
    )
  }

  // 未进入可视区域时显示占位符
  if (!isVisible) {
    return (
      <ImageStatusCard
        variant="placeholder"
        size={displaySize}
        containerRef={imageContainerRef}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      />
    )
  }

  if (imageLoading) {
    return (
      <ImageStatusCard
        variant="loading"
        size={displaySize}
        containerRef={imageContainerRef}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      />
    )
  }

  // 解密失败或未解密
  return (
    <ImageStatusCard
      variant="unavailable"
      size={displaySize}
      clicked={imageClicked}
      containerRef={imageContainerRef}
      onClick={handleImageClick}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
    />
  )
}

function areImageBubblePropsEqual(prev: ImageBubbleProps, next: ImageBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.hasImageKey === next.hasImageKey
}

export default memo(ImageBubble, areImageBubblePropsEqual)
