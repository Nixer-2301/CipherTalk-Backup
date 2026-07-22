import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createLiquidGlassMap, type GlassFilterMap } from '../../utils/liquidGlass'

/**
 * 炫技用的液态玻璃圆球：浮在首页背景上，可鼠标拖动，松手后按抛掷速度飞出，
 * 撞到容器边缘反弹并摩擦衰减，最终静止停在某个位置。
 *
 * 物理：固定 timestep（对齐 rAF），状态全部放在 useRef 里，每帧直接改 DOM transform，
 * 不触发 React 重渲染——否则 60fps 物理会变成 60 次 setState/秒。
 *
 * 玻璃折射复用 createLiquidGlassMap 的位移贴图方案（和 LiquidGlassBubble 同源），
 * 但用圆形参数 + 边缘强折射，做出实心球体的折射观感。
 */

// —— 可调物理常量（均以"每帧 @60fps"为单位）——
const GRAVITY = 0.18            // 轻微下落感
const FRICTION = 0.992         // 自由飞行时的速度衰减（每帧保留 99.2%）
const RESTITUTION = 0.72       // 撞墙恢复系数（损失 28% 能量）
const STOP_THRESHOLD = 0.06    // 速度低于此值直接归零，避免无限微抖
const MAX_THROW_SPEED = 42     // 抛掷初速度上限（px/帧），防止甩飞太快
const SAMPLE_WINDOW_MS = 90    // 松手时回看最近多少 ms 的指针轨迹算瞬时速度

// 圆形玻璃的位移贴图参数：实心中心极小 + 大 feather → 折射带铺满整个球面；strength 拉高 → 折射更猛
const BALL_GLASS = { halfX: 0.1, halfY: 0.1, radius: 0.1, edge: 0.02, feather: 1.1, strength: 6 }

type PointerSample = { x: number; y: number; t: number }

type LiquidGlassBallProps = {
  /** 圆球直径（px），默认 120 */
  size?: number
  className?: string
}

export function LiquidGlassBall({ size = 120, className }: LiquidGlassBallProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLDivElement>(null)
  const [filterId] = useState(() => `liquid-glass-ball-${Math.random().toString(36).slice(2, 9)}`)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  // 物理状态：全放 ref，rAF 循环里直接读写，不进 React 状态
  const pos = useRef({ x: 0, y: 0 })
  const vel = useRef({ x: 0, y: 0 })
  const bounds = useRef({ width: 0, height: 0 }) // 容器可活动范围（已扣球半径）
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 }) // 按下时指针相对球左上角的偏移
  const pointerSamples = useRef<PointerSample[]>([])
  const rafId = useRef<number | null>(null)
  const reducedMotion = useRef(false)

  // 生成一次位移贴图（尺寸固定，无需 ResizeObserver）
  useLayoutEffect(() => {
    const m = createLiquidGlassMap(size, size, BALL_GLASS)
    if (m) setMap(m)
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [size])

  // 初始化位置 + 监听容器尺寸变化（窗口缩放时重算边界，并把球拉回合法范围）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measure = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      bounds.current = { width: Math.max(0, w - size), height: Math.max(0, h - size) }
      // 首次：把球放到容器中心偏上一点
      if (pos.current.x === 0 && pos.current.y === 0) {
        pos.current.x = bounds.current.width / 2
        pos.current.y = bounds.current.height * 0.32
        applyTransform()
      } else {
        // 窗口缩小后球可能在边界外，拉回来
        clampPosition()
        applyTransform()
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [size])

  // 物理主循环
  useEffect(() => {
    const tick = () => {
      if (!dragging.current) {
        const v = vel.current
        const p = pos.current
        v.y += GRAVITY
        p.x += v.x
        p.y += v.y

        const b = bounds.current
        let bounced = false
        if (p.x < 0) { p.x = 0; v.x = -v.x * RESTITUTION; bounced = true }
        else if (p.x > b.width) { p.x = b.width; v.x = -v.x * RESTITUTION; bounced = true }
        if (p.y < 0) { p.y = 0; v.y = -v.y * RESTITUTION; bounced = true }
        else if (p.y > b.height) { p.y = b.height; v.y = -v.y * RESTITUTION; bounced = true }

        // 摩擦 + 静止判定（落在底面时摩擦更大一点，避免无限微弹）
        const onGround = p.y >= b.height - 0.5
        const f = onGround ? 0.94 : FRICTION
        v.x *= f
        v.y *= onGround ? 0.86 : f
        if (Math.abs(v.x) < STOP_THRESHOLD) v.x = 0
        if (Math.abs(v.y) < STOP_THRESHOLD) v.y = 0

        applyTransform()
      }
      rafId.current = requestAnimationFrame(tick)
    }

    // 尊重用户的减少动效偏好：不启动循环，球静止停在初始位置
    if (!reducedMotion.current) {
      rafId.current = requestAnimationFrame(tick)
    }
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    }
  }, [])

  // 直接写 DOM，绕过 React。用 left/top 定位（不能用 transform：会切断球自身的 backdrop-filter 折射采样）
  const applyTransform = () => {
    const el = ballRef.current
    if (el) {
      el.style.left = `${pos.current.x}px`
      el.style.top = `${pos.current.y}px`
    }
  }
  const clampPosition = () => {
    const b = bounds.current
    const p = pos.current
    if (p.x < 0) p.x = 0
    else if (p.x > b.width) p.x = b.width
    if (p.y < 0) p.y = 0
    else if (p.y > b.height) p.y = b.height
  }

  // —— 指针事件 ——
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reducedMotion.current) return
    const el = ballRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    dragging.current = true
    vel.current = { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    // 指针相对球左上角的偏移；后续 move 时 newLeftTop = pointerClient - offset
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    pointerSamples.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }]
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const container = containerRef.current
    if (!container) return
    const crect = container.getBoundingClientRect()
    // 球左上角 = 指针位置 - 容器偏移 - 抓取偏移
    let nx = e.clientX - crect.left - dragOffset.current.x
    let ny = e.clientY - crect.top - dragOffset.current.y
    const b = bounds.current
    if (nx < 0) nx = 0; else if (nx > b.width) nx = b.width
    if (ny < 0) ny = 0; else if (ny > b.height) ny = b.height
    pos.current.x = nx
    pos.current.y = ny
    applyTransform()
    pointerSamples.current.push({ x: e.clientX, y: e.clientY, t: performance.now() })
    // 只保留近 SAMPLE_WINDOW_MS 的采样
    const cutoff = performance.now() - SAMPLE_WINDOW_MS
    const samples = pointerSamples.current
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift()
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const el = ballRef.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    dragging.current = false

    // 用最近两个采样估算瞬时速度（px/ms → px/帧，1帧≈16.67ms）
    const samples = pointerSamples.current
    if (samples.length >= 2) {
      const a = samples[0]
      const b = samples[samples.length - 1]
      const dt = b.t - a.t
      if (dt > 0) {
        const perFrame = 1000 / 60
        let vx = ((b.x - a.x) / dt) * perFrame
        let vy = ((b.y - a.y) / dt) * perFrame
        // 限幅，防甩飞
        const speed = Math.hypot(vx, vy)
        if (speed > MAX_THROW_SPEED) {
          const k = MAX_THROW_SPEED / speed
          vx *= k
          vy *= k
        }
        vel.current = { x: vx, y: vy }
      }
    }
    pointerSamples.current = []
  }

  const backdrop = map ? `url(#${filterId}) blur(1.2px)` : undefined
  // backdrop-filter 直接挂在球自身，用 left/top 定位。绝不能用 transform 移动球或其祖先，
  // 否则会创建新的 containing block，切断 backdrop-filter 对背后内容的采样，折射变空。
  const ballStyle: CSSProperties = {
    width: size,
    height: size,
    left: pos.current.x,
    top: pos.current.y,
    ...(map ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : {}),
  }

  return (
    <div className="liquid-glass-ball-host" ref={containerRef}>
      <div
        ref={ballRef}
        className={`liquid-glass-ball${className ? ` ${className}` : ''}`}
        style={ballStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
      </div>
    </div>
  )
}
