
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tooltip } from '@heroui/react'
import { ArrowRotateLeft, ArrowRotateRight, ChevronLeft, ChevronRight, MagnifierMinus, MagnifierPlus } from '@gravity-ui/icons'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import type { ImageListItem } from '../types/electron'
import { createLiquidGlassMap, type GlassFilterMap } from '../utils/liquidGlass'
import './ImageWindow.css'

type ViewportMeta = {
    scale: number
    initialScale: number
    naturalSize: { width: number; height: number }
    viewportSize: { width: number; height: number }
}

function isImagePannable({ scale, initialScale, naturalSize, viewportSize }: ViewportMeta): boolean {
    const displayScale = initialScale * scale
    return viewportSize.width > 0 &&
        (naturalSize.width * displayScale > viewportSize.width + 1 ||
            naturalSize.height * displayScale > viewportSize.height + 1)
}

export default function ImageWindow() {
    const [searchParams] = useSearchParams()
    const imagePath = searchParams.get('imagePath')
    const liveVideoPath = searchParams.get('liveVideoPath')
    const sessionId = searchParams.get('sessionId') || undefined
    const imageMd5 = searchParams.get('imageMd5') || undefined
    const imageDatName = searchParams.get('imageDatName') || undefined

    // 图片列表导航状态
    const [imageList, setImageList] = useState<ImageListItem[]>([])
    const [currentIndex, setCurrentIndex] = useState(0)

    const activeImage = imageList.length > 0 ? imageList[currentIndex] : null
    const currentImagePath = activeImage?.imagePath || imagePath
    // 多图模式下只用列表中的 liveVideoPath，不回退到 URL 参数，避免非实况图也显示实况按钮
    const currentLiveVideoPath = imageList.length > 0 ? activeImage?.liveVideoPath : liveVideoPath
    const [hdImagePath, setHdImagePath] = useState<string | null>(null)
    const [hdLiveVideoPath, setHdLiveVideoPath] = useState<string | undefined>(undefined)
    const upgradeTriedRef = useRef<string | null>(null)
    const suppressGestureUntilRef = useRef(0)
    const effectiveImagePath = hdImagePath || currentImagePath
    const effectiveLiveVideoPath = hdLiveVideoPath ?? currentLiveVideoPath

    const [scale, setScale] = useState(1)
    const [rotation, setRotation] = useState(0)
    const [position, setPosition] = useState({ x: 0, y: 0 })
    const [initialScale, setInitialScale] = useState(1)
    const [isPlayingLive, setIsPlayingLive] = useState(false)
    const [isVideoVisible, setIsVideoVisible] = useState(false)
    const viewportRef = useRef<HTMLDivElement>(null)
    const toolbarRef = useRef<HTMLDivElement>(null)
    const videoRef = useRef<HTMLVideoElement>(null)
    const [glassFilterMap, setGlassFilterMap] = useState<GlassFilterMap | null>(null)
    // 上一张/下一张按钮：固定 44px 圆形，一次生成液态玻璃圆形位移贴图
    const [navGlassMap, setNavGlassMap] = useState<GlassFilterMap | null>(null)

    // 使用 ref 存储拖动状态，避免闭包问题
    const dragStateRef = useRef({
        isDragging: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        startPosX: 0,
        startPosY: 0
    })

    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

    useEffect(() => {
        setHdImagePath(null)
        setHdLiveVideoPath(undefined)
        upgradeTriedRef.current = null
    }, [currentImagePath])

    useLayoutEffect(() => {
        suppressGestureUntilRef.current = Date.now() + 400
        setScale(1)
        setRotation(0)
        setPosition({ x: 0, y: 0 })
        setIsPlayingLive(false)
        setIsVideoVisible(false)
    }, [currentImagePath])

    // 在图片查看器中再次尝试强制升级高清图
    useEffect(() => {
        if (!currentImagePath) return
        if (!sessionId) return
        if (!imageMd5 && !imageDatName) return

        const upgradeKey = `${sessionId}|${imageMd5 || ''}|${imageDatName || ''}`
        if (upgradeTriedRef.current === upgradeKey) return
        upgradeTriedRef.current = upgradeKey

        let cancelled = false
        window.electronAPI.image.decrypt({
            sessionId,
            imageMd5,
            imageDatName,
            force: true
        }).then((result) => {
            if (cancelled) return
            if (result.success && result.localPath) {
                setHdImagePath(result.localPath)
                if ((result as any).liveVideoPath) {
                    setHdLiveVideoPath((result as any).liveVideoPath)
                }
            }
        }).catch(() => {
            // ignore
        })

        return () => {
            cancelled = true
        }
    }, [currentImagePath, sessionId, imageMd5, imageDatName])

    const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 10))
    const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.1))
    const handleRotate = () => setRotation(prev => (prev + 90) % 360)
    const handleRotateCcw = () => setRotation(prev => (prev - 90 + 360) % 360)

    // 重置视图
    const handleReset = useCallback(() => {
        setScale(1)
        setRotation(0)
        setPosition({ x: 0, y: 0 })
    }, [])

    // ... existing useEffects for resize/scale ... (not modifying them here, just context if needed)

    // 播放 Live Photo
    const handlePlayLiveVideo = useCallback(() => {
        if (effectiveLiveVideoPath && !isPlayingLive) {
            setIsPlayingLive(true)
            // 播放视频
            if (videoRef.current) {
                videoRef.current.currentTime = 0
                videoRef.current.play()
            }
        }
    }, [effectiveLiveVideoPath, isPlayingLive])

    // 视频真正开始播放（画面就绪）
    const handleVideoPlaying = useCallback(() => {
        setIsVideoVisible(true)
    }, [])

    // 视频播放结束后返回图片
    const handleVideoEnded = useCallback(() => {
        setIsVideoVisible(false) // 先隐藏视频（显示下方的图片）
        // 等待过渡动画结束后，卸载视频组件
        setTimeout(() => {
            setIsPlayingLive(false)
        }, 300)
    }, [])

    // 监听主进程发送的图片更新
    useEffect(() => {
        const cleanup = window.electronAPI?.window?.onImageListUpdate?.((data) => {
            setImageList(data.imageList)
            setCurrentIndex(data.currentIndex)
        })
        return () => cleanup?.()
    }, [])

    // 导航函数
    const canGoPrev = imageList.length > 0 && currentIndex > 0
    const canGoNext = imageList.length > 0 && currentIndex < imageList.length - 1

    const goToImage = useCallback((newIndex: number) => {
        if (newIndex < 0 || newIndex >= imageList.length) return
        setCurrentIndex(newIndex)
        setScale(1)
        setRotation(0)
        setPosition({ x: 0, y: 0 })
        setIsPlayingLive(false)
        setIsVideoVisible(false)
    }, [imageList.length])

    const goPrev = useCallback(() => { if (canGoPrev) goToImage(currentIndex - 1) }, [canGoPrev, currentIndex, goToImage])
    const goNext = useCallback(() => { if (canGoNext) goToImage(currentIndex + 1) }, [canGoNext, currentIndex, goToImage])

    // 监听窗口大小变化
    useEffect(() => {
        if (!viewportRef.current) return

        const updateViewportSize = () => {
            if (viewportRef.current) {
                setViewportSize({
                    width: viewportRef.current.clientWidth,
                    height: viewportRef.current.clientHeight
                })
            }
        }

        updateViewportSize()
        const resizeObserver = new ResizeObserver(() => {
            updateViewportSize()
        })
        resizeObserver.observe(viewportRef.current)
        window.addEventListener('resize', updateViewportSize)
        return () => {
            resizeObserver.disconnect()
            window.removeEventListener('resize', updateViewportSize)
        }
    }, [])

    useLayoutEffect(() => {
        const toolbar = toolbarRef.current
        if (!toolbar) return

        const updateFilterMap = () => {
            const rect = toolbar.getBoundingClientRect()
            const next = createLiquidGlassMap(rect.width, rect.height)
            if (next) setGlassFilterMap(next)
        }

        updateFilterMap()
        const resizeObserver = new ResizeObserver(updateFilterMap)
        resizeObserver.observe(toolbar)
        return () => resizeObserver.disconnect()
    }, [])

    useEffect(() => {
        setNavGlassMap(createLiquidGlassMap(44, 44, { halfX: 0.18, halfY: 0.18, radius: 0.18, edge: 0.02, feather: 0.4, strength: 3 }))
    }, [])

    // 监听视口大小和图片原始尺寸变化，自动调整初始缩放比例
    useEffect(() => {
        if (naturalSize.width === 0 || viewportSize.width === 0) return

        const viewportWidth = viewportSize.width
        const viewportHeight = viewportSize.height
        const scaleX = viewportWidth / naturalSize.width
        const scaleY = viewportHeight / naturalSize.height
        const fitScale = Math.min(scaleX, scaleY, 1)

        setInitialScale(fitScale)
    }, [naturalSize, viewportSize])

    // 图片加载完成后：
    // 1. 记录原始尺寸
    // 2. 调整窗口大小以适应图片（如果可能）
    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget
        const naturalWidth = img.naturalWidth
        const naturalHeight = img.naturalHeight

        setNaturalSize({ width: naturalWidth, height: naturalHeight })

        // 多图模式下不调整窗口大小，避免切换时窗口跳动
        if (imageList.length <= 1) {
            const desiredWidth = naturalWidth
            const desiredHeight = naturalHeight
            // @ts-ignore
            window.electronAPI?.window?.resizeContent?.(desiredWidth, desiredHeight)
        }

        // 重置缩放和位置
        setScale(1)
        setPosition({ x: 0, y: 0 })
    }, [effectiveImagePath, imageList.length])

    // Use a ref to access latest state in event listeners without re-binding
    const metaRef = useRef({
        scale,
        initialScale,
        naturalSize,
        viewportSize
    })

    useEffect(() => {
        metaRef.current = { scale, initialScale, naturalSize, viewportSize }
    }, [scale, initialScale, naturalSize, viewportSize])

    const clampDragPosition = useCallback((clientX: number, clientY: number) => {
        const { scale, initialScale, naturalSize, viewportSize } = metaRef.current
        const displayScale = initialScale * scale

        const dx = clientX - dragStateRef.current.startX
        const dy = clientY - dragStateRef.current.startY

        let newX = dragStateRef.current.startPosX + dx
        let newY = dragStateRef.current.startPosY + dy

        const dw = naturalSize.width * displayScale
        const dh = naturalSize.height * displayScale

        if (dw > viewportSize.width) {
            const limitX = (dw - viewportSize.width) / 2
            newX = Math.max(-limitX, Math.min(newX, limitX))
        } else {
            newX = 0
        }

        if (dh > viewportSize.height) {
            const limitY = (dh - viewportSize.height) / 2
            newY = Math.max(-limitY, Math.min(newY, limitY))
        } else {
            newY = 0
        }

        setPosition({ x: newX, y: newY })
    }, [])

    const stopDragging = useCallback(() => {
        dragStateRef.current.isDragging = false
        dragStateRef.current.pointerId = -1
        document.body.style.cursor = isImagePannable(metaRef.current) ? 'grab' : 'default'
    }, [])

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()

        const isPannable = isImagePannable(metaRef.current)
        if (!isPannable) return

        dragStateRef.current = {
            isDragging: true,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startPosX: position.x,
            startPosY: position.y
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        document.body.style.cursor = 'grabbing'
    }, [position.x, position.y])

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStateRef.current.isDragging) return
        if (dragStateRef.current.pointerId !== e.pointerId) return

        clampDragPosition(e.clientX, e.clientY)
    }, [clampDragPosition])

    const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragStateRef.current.pointerId === e.pointerId && e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId)
        }
        stopDragging()
    }, [stopDragging])

    const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragStateRef.current.pointerId === e.pointerId && e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId)
        }
        stopDragging()
    }, [stopDragging])

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (!viewportRef.current) return
        if (Date.now() < suppressGestureUntilRef.current) return
        // 阻止默认滚动行为，避免触发页面滚动（虽然 overflows hidden 但保险起见）

        const ZOOM_SPEED = 0.15
        const delta = -Math.sign(e.deltaY) * ZOOM_SPEED

        const newScaleRaw = scale + delta
        const newScale = Math.min(Math.max(newScaleRaw, 0.1), 10)

        if (newScale === scale) return

        // 如果缩小到小于等于 1 (适应屏幕大小)，则强制居中
        if (newScale <= 1) {
            setScale(newScale)
            setPosition({ x: 0, y: 0 })
            return
        }

        // 计算鼠标相对于视口中心的偏移
        const rect = viewportRef.current.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const centerX = rect.width / 2
        const centerY = rect.height / 2

        const pointerX = mouseX - centerX
        const pointerY = mouseY - centerY

        // 保持鼠标下的点不变：
        // NewPos = Pointer - (Pointer - OldPos) * (NewScale / OldScale)
        const scaleRatio = newScale / scale
        const newPos = {
            x: pointerX - (pointerX - position.x) * scaleRatio,
            y: pointerY - (pointerY - position.y) * scaleRatio
        }

        setScale(newScale)
        setPosition(newPos)
    }, [scale, position])

    // 双击重置
    // 双击：如果当前是适应屏幕 (scale ~ 1)，则放大到 100% (1:1) 并以鼠标为中心；否则重置
    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
        if (Date.now() < suppressGestureUntilRef.current) return
        if (Math.abs(scale - 1) < 0.05) {
            // 当前是适应状态 -> 放大到 1:1
            // 1:1 意味着 displayScale = 1.0
            // displayScale = initialScale * scale => scale = 1 / initialScale
            const targetScale = 1 / initialScale

            // 计算新的位置让鼠标处放大
            if (viewportRef.current) {
                const rect = viewportRef.current.getBoundingClientRect()
                const mouseX = e.clientX - rect.left
                const mouseY = e.clientY - rect.top
                const centerX = rect.width / 2
                const centerY = rect.height / 2
                const pointerX = mouseX - centerX
                const pointerY = mouseY - centerY

                const scaleRatio = targetScale / scale
                const newPos = {
                    x: pointerX - (pointerX - position.x) * scaleRatio,
                    y: pointerY - (pointerY - position.y) * scaleRatio
                }
                setPosition(newPos)
            }

            setScale(targetScale)
        } else {
            // 当前是放大/缩小状态 -> 重置
            handleReset()
        }
    }, [scale, initialScale, position, handleReset])

    // 快捷键支持
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (isPlayingLive) {
                    setIsPlayingLive(false)
                } else {
                    window.electronAPI.window.close()
                }
            }
            if (e.key === '=' || e.key === '+') handleZoomIn()
            if (e.key === '-') handleZoomOut()
            if (e.key === 'r' || e.key === 'R') handleRotate()
            if (e.key === '0') handleReset()
            if (e.key === ' ' && effectiveLiveVideoPath) {
                e.preventDefault()
                handlePlayLiveVideo()
            }
            if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
            if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [handleReset, effectiveLiveVideoPath, isPlayingLive, handlePlayLiveVideo, goPrev, goNext])

    const hasLiveVideo = !!effectiveLiveVideoPath

    if (!effectiveImagePath) {
        return (
            <div className="image-window-empty">
                <span>无效的图片路径</span>
            </div>
        )
    }

    const displayScale = initialScale * scale

    // 判断是否可拖拽平移：只有当显示尺寸大于视口尺寸时才允许平移，否则允许拖拽窗口
    const isPannable = isImagePannable({ scale, initialScale, naturalSize, viewportSize })
    // height 判定宽松一点或者严格一点？这里用 height 简单判定。
    // 注意：如果旋转了，宽高判断会变。暂不处理旋转后的复杂bbox calculations。

    return (
        <div className={`image-window-container${navGlassMap ? ' nav-glass-ready' : ''}`}>
            <svg className="glass-filter-defs" aria-hidden="true" focusable="false">
                <filter
                    id="image-window-liquid-refraction"
                    filterUnits="userSpaceOnUse"
                    colorInterpolationFilters="sRGB"
                    x="0"
                    y="0"
                    width={glassFilterMap?.width || 1}
                    height={glassFilterMap?.height || 1}
                >
                    <feImage
                        id="image-window-liquid-refraction-map"
                        href={glassFilterMap?.href || ''}
                        xlinkHref={glassFilterMap?.href || ''}
                        width={glassFilterMap?.width || 1}
                        height={glassFilterMap?.height || 1}
                        result="displacementMap"
                    />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="displacementMap"
                        scale={glassFilterMap?.scale || 0}
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                </filter>
                {navGlassMap && (
                    <filter
                        id="image-window-nav-glass"
                        filterUnits="userSpaceOnUse"
                        colorInterpolationFilters="sRGB"
                        x="0"
                        y="0"
                        width={navGlassMap.width}
                        height={navGlassMap.height}
                    >
                        <feImage href={navGlassMap.href} xlinkHref={navGlassMap.href} width={navGlassMap.width} height={navGlassMap.height} result="navDisplacementMap" />
                        <feDisplacementMap in="SourceGraphic" in2="navDisplacementMap" scale={navGlassMap.scale} xChannelSelector="R" yChannelSelector="G" />
                    </filter>
                )}
            </svg>

            <div className="title-bar">
                <div className="window-drag-area" aria-hidden="true"></div>
            </div>

            <div className="bottom-toolbar-shell">
                <div
                    className="bottom-toolbar"
                    ref={toolbarRef}
                    style={glassFilterMap ? {
                        backdropFilter: 'url(#image-window-liquid-refraction) blur(3px) brightness(1.08) saturate(1.08)',
                        WebkitBackdropFilter: 'url(#image-window-liquid-refraction) blur(3px) brightness(1.08) saturate(1.08)',
                    } : undefined}
                >
                    {hasLiveVideo && (
                        <>
                            <Tooltip delay={0} closeDelay={60}>
                                <Tooltip.Trigger>
                                    <button
                                        onClick={handlePlayLiveVideo}
                                        aria-label={isPlayingLive ? '正在播放' : '播放 Live Photo'}
                                        className={`live-play-btn ${isPlayingLive ? 'active' : ''}`}
                                        disabled={isPlayingLive}
                                    >
                                        <LivePhotoIcon size={18} />
                                        <span>LIVE</span>
                                    </button>
                                </Tooltip.Trigger>
                                <Tooltip.Content placement="top">{isPlayingLive ? '正在播放' : '播放 Live Photo（空格）'}</Tooltip.Content>
                            </Tooltip>
                            <div className="divider"></div>
                        </>
                    )}
                    <Tooltip delay={0} closeDelay={60}>
                        <Tooltip.Trigger>
                            <button onClick={handleZoomOut} aria-label="缩小">
                                <MagnifierMinus width={16} height={16} />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Content placement="top">缩小（-）</Tooltip.Content>
                    </Tooltip>
                    <span className="scale-text">{Math.round(displayScale * 100)}%</span>
                    <Tooltip delay={0} closeDelay={60}>
                        <Tooltip.Trigger>
                            <button onClick={handleZoomIn} aria-label="放大">
                                <MagnifierPlus width={16} height={16} />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Content placement="top">放大（+）</Tooltip.Content>
                    </Tooltip>
                    <div className="divider"></div>
                    <Tooltip delay={0} closeDelay={60}>
                        <Tooltip.Trigger>
                            <button onClick={handleRotateCcw} aria-label="逆时针旋转">
                                <ArrowRotateLeft width={16} height={16} />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Content placement="top">逆时针旋转</Tooltip.Content>
                    </Tooltip>
                    <Tooltip delay={0} closeDelay={60}>
                        <Tooltip.Trigger>
                            <button onClick={handleRotate} aria-label="顺时针旋转">
                                <ArrowRotateRight width={16} height={16} />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Content placement="top">顺时针旋转（R）</Tooltip.Content>
                    </Tooltip>
                    {imageList.length > 1 && (
                        <>
                            <div className="divider"></div>
                            <span className="image-counter">{currentIndex + 1} / {imageList.length}</span>
                        </>
                    )}
                </div>
            </div>

            <div
                className="image-viewport"
                ref={viewportRef}
                onWheel={handleWheel}
                onDoubleClick={handleDoubleClick}
            >
                <div
                    className={`media-wrapper ${isPannable ? 'pannable' : ''}`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    style={{
                        transform: `translate(${position.x}px, ${position.y}px) scale(${displayScale}) rotate(${rotation}deg)`
                    }}
                >
                    <img
                        src={effectiveImagePath}
                        alt="Preview"
                        onLoad={handleImageLoad}
                        draggable={false}
                    />

                    {hasLiveVideo && isPlayingLive && (
                        <video
                            ref={videoRef}
                            src={effectiveLiveVideoPath || ''}
                            className={`live-video ${isVideoVisible ? 'visible' : ''}`}
                            autoPlay
                            // muted={false} // Default is unmuted, explicit false for clarity
                            onEnded={handleVideoEnded}
                            onPlaying={handleVideoPlaying}
                        />
                    )}
                </div>

                {imageList.length > 1 && (
                    <>
                        {canGoPrev && (
                            <button className="nav-btn nav-prev" onClick={goPrev}>
                                <ChevronLeft width={28} height={28} />
                            </button>
                        )}
                        {canGoNext && (
                            <button className="nav-btn nav-next" onClick={goNext}>
                                <ChevronRight width={28} height={28} />
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
