import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ElementType, type ReactNode } from 'react'
import { createLiquidGlassBubbleMap, type GlassBubbleOptions, type GlassFilterMap } from '../../utils/liquidGlass'

// 形状跟随气泡本身（18/18/18/4 圆角矩形 SDF），折射观感对齐玻璃球：
// 无内部波纹、折射带铺满全表面（edgeSize 盖过半高）、同等强度 strength 6
const BUBBLE_GLASS: GlassBubbleOptions = {
  radii: { topLeft: 18, topRight: 18, bottomRight: 18, bottomLeft: 4 },
  edgeSize: 28,
  edgeStrength: 7,
  surface: 0,
  strength: 6,
}

type LiquidGlassBubbleProps = {
  /** 渲染的元素标签，默认 blockquote（回忆一刻文字气泡） */
  as?: ElementType
  /** 位移贴图参数，默认文字气泡的 18/18/18/4 圆角矩形 */
  glass?: GlassBubbleOptions
  children: ReactNode
  'data-tooltip'?: string
} & ButtonHTMLAttributes<HTMLElement>

/** 液态玻璃外壳：按自身尺寸生成位移贴图，用 backdrop-filter 折射。
 *  内容尺寸会变（文字换行/语音时长不同），故用 ResizeObserver 跟随尺寸重建贴图。 */
export function LiquidGlassBubble({
  as: Tag = 'blockquote',
  glass = BUBBLE_GLASS,
  className = 'random-message-body random-message-body--glass',
  style,
  children,
  ...rest
}: LiquidGlassBubbleProps) {
  const ref = useRef<HTMLElement>(null)
  // 同页可能有多个玻璃实例（文字气泡 + 刷新按钮），filter id 必须实例唯一
  const [filterId] = useState(() => `home-glass-${Math.random().toString(36).slice(2, 9)}`)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width < 2 || height < 2) return
      const next = createLiquidGlassBubbleMap(width, height, glass)
      if (next) setMap(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [glass])

  const backdrop = map ? `url(#${filterId}) blur(1.2px)` : undefined

  return (
    <Tag
      ref={ref}
      className={className}
      style={map ? { ...style, backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : style}
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
