import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { Xmark } from '@gravity-ui/icons'
import { LivePhotoIcon } from './LivePhotoIcon'
import { createPortal } from 'react-dom'
import './ImagePreview.scss'

export interface ImagePreviewOriginRect {
  left: number
  top: number
  width: number
  height: number
}

interface ImagePreviewProps {
  src: string
  isVideo?: boolean
  liveVideoPath?: string
  originRect?: ImagePreviewOriginRect
  onClose: () => void
}

type EntryPhase = 'measuring' | 'from' | 'to' | 'settled'

export const ImagePreview: React.FC<ImagePreviewProps> = ({ src, isVideo, liveVideoPath, originRect, onClose }) => {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const [entryPhase, setEntryPhase] = useState<EntryPhase>(originRect ? 'measuring' : 'settled')
  const [entryTransform, setEntryTransform] = useState({ x: 0, y: 0, scaleX: 1, scaleY: 1 })
  const [mediaReady, setMediaReady] = useState(!originRect || Boolean(isVideo))
  const dragStart = useRef({ x: 0, y: 0 })
  const positionStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
    setShowLive(false)
    setMediaReady(!originRect || Boolean(isVideo))
    setEntryPhase(originRect ? 'measuring' : 'settled')
  }, [isVideo, originRect, src])

  useLayoutEffect(() => {
    if (!originRect || !mediaReady) return

    const content = contentRef.current
    if (!content) return

    const finalRect = content.getBoundingClientRect()
    if (!finalRect.width || !finalRect.height || !originRect.width || !originRect.height) {
      setEntryPhase('settled')
      return
    }

    const originCenterX = originRect.left + originRect.width / 2
    const originCenterY = originRect.top + originRect.height / 2
    const finalCenterX = finalRect.left + finalRect.width / 2
    const finalCenterY = finalRect.top + finalRect.height / 2

    setEntryTransform({
      x: originCenterX - finalCenterX,
      y: originCenterY - finalCenterY,
      scaleX: originRect.width / finalRect.width,
      scaleY: originRect.height / finalRect.height
    })
    setEntryPhase('from')

    let frameB = 0
    let timeoutId = 0
    const frameA = requestAnimationFrame(() => {
      frameB = requestAnimationFrame(() => {
        setEntryPhase('to')
        timeoutId = window.setTimeout(() => {
          setEntryPhase('settled')
        }, 360)
      })
    })

    return () => {
      cancelAnimationFrame(frameA)
      cancelAnimationFrame(frameB)
      window.clearTimeout(timeoutId)
    }
  }, [mediaReady, originRect])

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (showLive) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setScale(prev => Math.min(Math.max(prev * delta, 0.5), 5))
  }, [showLive])

  // 开始拖动
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (showLive || scale <= 1) return
    e.preventDefault()
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    positionStart.current = { ...position }
  }, [scale, position, showLive])

  // 拖动中
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPosition({
      x: positionStart.current.x + dx,
      y: positionStart.current.y + dy
    })
  }, [isDragging])

  // 结束拖动
  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // 双击重置
  const handleDoubleClick = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  // 点击背景关闭
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      onClose()
    }
  }, [onClose])

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const isEnteringFromOrigin = originRect && entryPhase !== 'settled'
  const overlayClassName = [
    'image-preview-overlay',
    entryPhase === 'from' || entryPhase === 'measuring' ? '' : 'is-entered'
  ].filter(Boolean).join(' ')
  const contentClassName = [
    'preview-content',
    entryPhase === 'measuring' ? 'is-measuring' : '',
    isEnteringFromOrigin ? 'is-origin-transitioning' : ''
  ].filter(Boolean).join(' ')
  const baseTranslate = entryPhase === 'from'
    ? {
        x: entryTransform.x + position.x,
        y: entryTransform.y + position.y,
        scaleX: entryTransform.scaleX,
        scaleY: entryTransform.scaleY
      }
    : {
        x: position.x,
        y: position.y,
        scaleX: 1,
        scaleY: 1
      }

  return createPortal(
    <div
      ref={containerRef}
      className={overlayClassName}
      onClick={handleOverlayClick}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div
        ref={contentRef}
        className={contentClassName}
        style={{
          position: 'relative',
          transform: `translate(${baseTranslate.x}px, ${baseTranslate.y}px) scale(${baseTranslate.scaleX}, ${baseTranslate.scaleY})`,
          width: 'fit-content',
          height: 'fit-content'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(isVideo || showLive) ? (
          <video
            src={showLive ? liveVideoPath : src}
            controls={!showLive}
            autoPlay
            loop={showLive}
            className="preview-image"
            style={{
              transform: `scale(${scale})`,
              maxHeight: '90vh',
              maxWidth: '90vw'
            }}
            onLoadedMetadata={() => setMediaReady(true)}
          />
        ) : (
          <img
            src={src}
            alt="图片预览"
            className={`preview-image ${isDragging ? 'dragging' : ''}`}
            style={{
              transform: `scale(${scale})`,
              maxHeight: '90vh',
              maxWidth: '90vw',
              cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onLoad={() => setMediaReady(true)}
            draggable={false}
          />
        )}

      </div>

      {liveVideoPath && !isVideo && (
        <button
          className={`live-photo-btn ${showLive ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setShowLive(!showLive)
          }}
          data-tooltip={showLive ? "显示照片" : "播放实况"}
        >
          <LivePhotoIcon size={20} />
          <span>实况</span>
        </button>
      )}

      <button className="image-preview-close" onClick={onClose}>
        <Xmark width={20} height={20} />
      </button>
    </div>,
    document.body
  )
}
