import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createLiquidGlassMap, type GlassFilterMap } from '@/utils/liquidGlass'

// 液态玻璃折射：宽胶囊。缩小实心中心(halfX/halfY)+加大 feather 让折射带更宽、覆盖面更大。
const DOCK_GLASS = { halfX: 0.24, halfY: 0.14, radius: 0.7, edge: 0.18, feather: 1.1, strength: 1.5 }
const DOCK_GLASS_FILTER_ID = 'dock-liquid-glass'

export interface DockApp {
  id: string
  name: string
  icon: React.ReactNode
}

interface MacOSDockProps {
  apps: DockApp[]
  onAppClick: (appId: string) => void
  openApps?: string[]
  className?: string
}

const MacOSDock: React.FC<MacOSDockProps> = ({
  apps,
  onAppClick,
  openApps = [],
  className = ''
}) => {
  const [mouseX, setMouseX] = useState<number | null>(null)
  const [glassMap, setGlassMap] = useState<GlassFilterMap | null>(null)
  const [currentScales, setCurrentScales] = useState<number[]>(apps.map(() => 1))
  const [currentPositions, setCurrentPositions] = useState<number[]>([])
  const dockRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<(HTMLDivElement | null)[]>([])
  const animationFrameRef = useRef<number | undefined>(undefined)
  const lastMouseMoveTime = useRef<number>(0)

  const getResponsiveConfig = useCallback(() => {
    if (typeof window === 'undefined') {
      return { baseIconSize: 40, maxScale: 1.4, effectWidth: 180 }
    }

    const smallerDimension = Math.min(window.innerWidth, window.innerHeight)

    if (smallerDimension < 480) {
      return {
        baseIconSize: Math.max(28, smallerDimension * 0.06),
        maxScale: 1.3,
        effectWidth: smallerDimension * 0.35
      }
    } else if (smallerDimension < 768) {
      return {
        baseIconSize: Math.max(32, smallerDimension * 0.05),
        maxScale: 1.35,
        effectWidth: smallerDimension * 0.3
      }
    } else if (smallerDimension < 1024) {
      return {
        baseIconSize: Math.max(36, smallerDimension * 0.04),
        maxScale: 1.4,
        effectWidth: smallerDimension * 0.25
      }
    } else {
      return {
        baseIconSize: Math.max(40, Math.min(48, smallerDimension * 0.032)),
        maxScale: 1.45,
        effectWidth: 200
      }
    }
  }, [])

  const [config, setConfig] = useState(getResponsiveConfig)
  const { baseIconSize, maxScale, effectWidth } = config
  const minScale = 1.0
  const baseSpacing = Math.max(14, baseIconSize * 0.3)

  useEffect(() => {
    const handleResize = () => {
      setConfig(getResponsiveConfig())
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [getResponsiveConfig])

  // Authentic macOS cosine-based magnification algorithm
  const calculateTargetMagnification = useCallback((mousePosition: number | null) => {
    if (mousePosition === null) {
      return apps.map(() => minScale)
    }

    return apps.map((_, index) => {
      const normalIconCenter = (index * (baseIconSize + baseSpacing)) + (baseIconSize / 2)
      const minX = mousePosition - (effectWidth / 2)
      const maxX = mousePosition + (effectWidth / 2)

      if (normalIconCenter < minX || normalIconCenter > maxX) {
        return minScale
      }

      const theta = ((normalIconCenter - minX) / effectWidth) * 2 * Math.PI
      const cappedTheta = Math.min(Math.max(theta, 0), 2 * Math.PI)
      const scaleFactor = (1 - Math.cos(cappedTheta)) / 2

      return minScale + (scaleFactor * (maxScale - minScale))
    })
  }, [apps, baseIconSize, baseSpacing, effectWidth, maxScale, minScale])

  const calculatePositions = useCallback((scales: number[]) => {
    let currentX = 0

    return scales.map((scale) => {
      const scaledWidth = baseIconSize * scale
      const centerX = currentX + (scaledWidth / 2)
      currentX += scaledWidth + baseSpacing
      return centerX
    })
  }, [baseIconSize, baseSpacing])

  useEffect(() => {
    const initialScales = apps.map(() => minScale)
    const initialPositions = calculatePositions(initialScales)
    setCurrentScales(initialScales)
    setCurrentPositions(initialPositions)
  }, [apps, calculatePositions, minScale, config])

  const animateToTarget = useCallback(() => {
    const targetScales = calculateTargetMagnification(mouseX)
    const targetPositions = calculatePositions(targetScales)
    const lerpFactor = mouseX !== null ? 0.2 : 0.12

    setCurrentScales(prevScales => {
      return prevScales.map((currentScale, index) => {
        const diff = targetScales[index] - currentScale
        return currentScale + (diff * lerpFactor)
      })
    })

    setCurrentPositions(prevPositions => {
      return prevPositions.map((currentPos, index) => {
        const diff = targetPositions[index] - currentPos
        return currentPos + (diff * lerpFactor)
      })
    })

    const scalesNeedUpdate = currentScales.some((scale, index) =>
      Math.abs(scale - targetScales[index]) > 0.002
    )
    const positionsNeedUpdate = currentPositions.some((pos, index) =>
      Math.abs(pos - targetPositions[index]) > 0.1
    )

    if (scalesNeedUpdate || positionsNeedUpdate || mouseX !== null) {
      animationFrameRef.current = requestAnimationFrame(animateToTarget)
    }
  }, [mouseX, calculateTargetMagnification, calculatePositions, currentScales, currentPositions])

  useEffect(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }
    animationFrameRef.current = requestAnimationFrame(animateToTarget)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [animateToTarget])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const now = performance.now()

    if (now - lastMouseMoveTime.current < 16) {
      return
    }

    lastMouseMoveTime.current = now

    if (dockRef.current) {
      const rect = dockRef.current.getBoundingClientRect()
      const padX = Math.max(24, baseIconSize * 0.5)
      setMouseX(e.clientX - rect.left - padX)
    }
  }, [baseIconSize])

  const handleMouseLeave = useCallback(() => {
    setMouseX(null)
  }, [])

  const createBounceAnimation = (element: HTMLElement) => {
    const bounceHeight = Math.max(-8, -baseIconSize * 0.15)
    element.style.transition = 'transform 0.2s ease-out'
    element.style.transform = `translateY(${bounceHeight}px)`

    setTimeout(() => {
      element.style.transform = 'translateY(0px)'
    }, 200)
  }

  const handleAppClick = (appId: string, index: number) => {
    if (iconRefs.current[index]) {
      createBounceAnimation(iconRefs.current[index]!)
    }

    onAppClick(appId)
  }

  const contentWidth = currentPositions.length > 0
    ? Math.max(...currentPositions.map((pos, index) =>
        pos + (baseIconSize * currentScales[index]) / 2
      ))
    : (apps.length * (baseIconSize + baseSpacing)) - baseSpacing

  // 竖向 padding 小（控制条高，圆角=半高的胶囊不至于太高），横向 padding 大（两端留白，不拥挤）
  const padY = Math.max(10, baseIconSize * 0.22)
  const padX = Math.max(24, baseIconSize * 0.5)

  // 液态玻璃位移贴图：贴图尺寸固定，胶囊宽度随磁化放大而变。宽度按 8px 分桶，避免逐帧重建 canvas；
  // ponytail: 悬停放大瞬间贴图与胶囊最多差 8px，几乎不可见，静止态像素对齐。宽度真要求分毫不差再上逐帧。
  const glassHeight = Math.round(baseIconSize + padY * 2)
  const glassWidth = Math.max(glassHeight, Math.round((contentWidth + padX * 2) / 8) * 8)

  useEffect(() => {
    setGlassMap(createLiquidGlassMap(glassWidth, glassHeight, DOCK_GLASS))
  }, [glassWidth, glassHeight])

  // 折射要放在 blur 之前且 blur 要轻，否则位移会被糊掉，看不出液态玻璃的镜片折弯。
  const glassBackdrop = glassMap
    ? `url(#${DOCK_GLASS_FILTER_ID}) blur(1px) saturate(180%) brightness(1.06)`
    : 'blur(28px) saturate(180%)'

  return (
    <>
      {glassMap && (
        <svg
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
        >
          <filter
            id={DOCK_GLASS_FILTER_ID}
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={glassMap.width}
            height={glassMap.height}
          >
            <feImage href={glassMap.href} xlinkHref={glassMap.href} width={glassMap.width} height={glassMap.height} result="displacementMap" />
            <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={glassMap.scale} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
    <div
      ref={dockRef}
      // 圆角曲率
      className={`${className} [corner-shape:superellipse(1.5)]`.trim()}
      style={{
        width: `${contentWidth + padX * 2}px`,
        background: 'rgba(255, 255, 255, 0.03)',
        backdropFilter: glassBackdrop,
        WebkitBackdropFilter: glassBackdrop,
        // 圆角值
        borderRadius: '24px',
        border: '1px solid rgba(255, 255, 255, 0.28)',
        boxShadow: `
          0 ${Math.max(6, baseIconSize * 0.12)}px ${Math.max(24, baseIconSize * 0.5)}px rgba(0, 0, 0, 0.22),
          0 ${Math.max(2, baseIconSize * 0.04)}px ${Math.max(6, baseIconSize * 0.15)}px rgba(0, 0, 0, 0.12)
        `,
        padding: `${padY}px ${padX}px`
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="relative"
        style={{
          height: `${baseIconSize}px`,
          width: '100%'
        }}
      >
        {apps.map((app, index) => {
          const scale = currentScales[index]
          const position = currentPositions[index] || 0
          const scaledSize = baseIconSize * scale

          return (
            <div
              key={app.id}
              ref={(el) => { iconRefs.current[index] = el }}
              className="group absolute cursor-pointer flex flex-col items-center justify-end"
              onClick={() => handleAppClick(app.id, index)}
              style={{
                left: `${position - scaledSize / 2}px`,
                bottom: '0px',
                width: `${scaledSize}px`,
                height: `${scaledSize}px`,
                transformOrigin: 'bottom center',
                zIndex: Math.round(scale * 10)
              }}
            >
              <div
                className="absolute opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none"
                style={{
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: '12px',
                  padding: '4px 10px',
                  borderRadius: '8px',
                  background: 'rgba(40, 40, 40, 0.92)',
                  color: 'rgba(255, 255, 255, 0.95)',
                  fontSize: '12px',
                  fontWeight: 500,
                  letterSpacing: '0.2px',
                  whiteSpace: 'nowrap',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 6px 16px rgba(0, 0, 0, 0.28)'
                }}
              >
                {app.name}
                <span
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: '50%',
                    transform: 'translateX(-50%) rotate(45deg)',
                    width: '6px',
                    height: '6px',
                    marginTop: '-3px',
                    background: 'rgba(40, 40, 40, 0.92)',
                    borderRight: '1px solid rgba(255, 255, 255, 0.1)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                  }}
                />
              </div>
              {typeof app.icon === 'string' ? (
                <img
                  src={app.icon}
                  alt={app.name}
                  width={scaledSize}
                  height={scaledSize}
                  className="object-contain"
                  style={{
                    filter: `drop-shadow(0 ${scale > 1.2 ? Math.max(2, baseIconSize * 0.05) : Math.max(1, baseIconSize * 0.03)}px ${scale > 1.2 ? Math.max(4, baseIconSize * 0.1) : Math.max(2, baseIconSize * 0.06)}px rgba(0,0,0,${0.2 + (scale - 1) * 0.15}))`
                  }}
                />
              ) : (
                <div
                  style={{
                    width: `${scaledSize}px`,
                    height: `${scaledSize}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    filter: `drop-shadow(0 ${scale > 1.2 ? Math.max(2, baseIconSize * 0.05) : Math.max(1, baseIconSize * 0.03)}px ${scale > 1.2 ? Math.max(4, baseIconSize * 0.1) : Math.max(2, baseIconSize * 0.06)}px rgba(0,0,0,${0.2 + (scale - 1) * 0.15}))`
                  }}
                >
                  {app.icon}
                </div>
              )}

              {openApps.includes(app.id) && (
                <div
                  className="absolute"
                  style={{
                    bottom: `${Math.max(-2, -baseIconSize * 0.05)}px`,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: `${Math.max(3, baseIconSize * 0.06)}px`,
                    height: `${Math.max(3, baseIconSize * 0.06)}px`,
                    borderRadius: '50%',
                    backgroundColor: 'rgba(255, 255, 255, 0.8)',
                    boxShadow: '0 0 4px rgba(0, 0, 0, 0.3)',
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
    </>
  )
}

export default MacOSDock
