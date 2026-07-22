import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Popover, Slider, Tooltip } from '@heroui/react'
// 图标用项目直连的 @gravity-ui/icons（lucide-react 只是 @lobehub 的传递依赖，直接引会在依赖重装后失踪）
import { Bulb, ChevronDown, CircleQuestion } from '@gravity-ui/icons'
import type { AgentReasoningEffort } from '@/features/aiagent/transport/ipcChatTransport'
import { createLiquidGlassMap, type GlassFilterMap } from '@/utils/liquidGlass'
import { AgentReasoningCanvas } from './AgentReasoningCanvas'
import { REASONING_EFFORT_OPTIONS, reasoningEffortLabel } from './agentPromptPresets'

type AgentReasoningEffortControlProps = {
  value: AgentReasoningEffort
  onChange: (value: AgentReasoningEffort) => void
}

const DEFAULT_EFFORT: AgentReasoningEffort = 'high'
const DEFAULT_EFFORT_INDEX = REASONING_EFFORT_OPTIONS.findIndex((option) => option.value === DEFAULT_EFFORT)
const MAX_INDEX = REASONING_EFFORT_OPTIONS.length - 1
const ULTRA_TRANSITION_MS = 450

type StatusDirection = 'higher' | 'lower'

// 滑块滑钮的液态玻璃折射滤镜：完全复用首页玻璃球（LiquidGlassBall）的球面折射参数——
// 实心中心极小 + 大 feather → 折射带铺满整个滑钮面，strength 6 让折射够猛，出玻璃球那种质感。
const THUMB_GLASS = { halfX: 0.1, halfY: 0.1, radius: 0.1, edge: 0.02, feather: 1.1, strength: 6 }

function sliderValue(value: number | number[]): number {
  return Array.isArray(value) ? value[0] ?? DEFAULT_EFFORT_INDEX : value
}

export function AgentReasoningEffortControl({ value, onChange }: AgentReasoningEffortControlProps) {
  const rawIndex = REASONING_EFFORT_OPTIONS.findIndex((option) => option.value === value)
  const selectedIndex = rawIndex >= 0 ? rawIndex : DEFAULT_EFFORT_INDEX
  const selectedEffort = REASONING_EFFORT_OPTIONS[selectedIndex] ?? REASONING_EFFORT_OPTIONS[DEFAULT_EFFORT_INDEX]
  const committedIsMax = selectedEffort.value === 'max'

  // 滑钮液态玻璃：id 带随机后缀避免多实例撞名
  const [thumbGlassId] = useState(() => `agent-reasoning-thumb-glass-${Math.random().toString(36).slice(2, 9)}`)
  const [thumbGlassMap, setThumbGlassMap] = useState<GlassFilterMap | null>(null)
  const thumbRoRef = useRef<ResizeObserver | null>(null)
  const lastThumbSizeRef = useRef(0)
  // 折射贴图必须跟随滑钮真实尺寸重建：拖动放大时（29→34px）用固定 29px 贴图会边缘不折射且球心偏移。
  // 用 ref callback 而非 useEffect：Popover 懒渲染，滑钮只有在弹层打开时才挂载，
  // callback 在挂载那一刻拿到真实尺寸并建 ResizeObserver（同 LiquidGlassBubble 的跟随重建思路），
  // 整数尺寸去重避免过渡期间反复重建；卸载时断开。
  const setThumbNode = useCallback((el: HTMLDivElement | null) => {
    thumbRoRef.current?.disconnect()
    thumbRoRef.current = null
    if (!el) return
    const rebuild = () => {
      const size = Math.round(el.getBoundingClientRect().width)
      if (size < 2 || size === lastThumbSizeRef.current) return
      lastThumbSizeRef.current = size
      const next = createLiquidGlassMap(size, size, THUMB_GLASS)
      if (next) setThumbGlassMap(next)
    }
    rebuild()
    const ro = new ResizeObserver(rebuild)
    ro.observe(el)
    thumbRoRef.current = ro
  }, [])
  // 折射串对齐玻璃球：url(折射贴图) + 轻模糊，不加 saturate，纯折射透出背后轨道内容
  const thumbBackdrop = thumbGlassMap ? `url(#${thumbGlassId}) blur(1.2px)` : undefined

  // 本地浮点值：拖动期间只动它，onChange 留到松手才提交——
  // 拖动中就回写父级会触发 selectedIndex 同步，把滑块拽回整数档，手感生硬
  const [localValue, setLocalValue] = useState<number>(selectedIndex)
  const localValueRef = useRef(selectedIndex)
  const [statusDirection, setStatusDirection] = useState<StatusDirection | null>(null)

  const updateLocalValue = useCallback((nextValue: number) => {
    const previousIndex = Math.min(Math.max(Math.round(localValueRef.current), 0), MAX_INDEX)
    const nextIndex = Math.min(Math.max(Math.round(nextValue), 0), MAX_INDEX)
    if (nextIndex !== previousIndex) {
      setStatusDirection(nextIndex > previousIndex ? 'higher' : 'lower')
    }
    localValueRef.current = nextValue
    setLocalValue(nextValue)
  }, [])

  useEffect(() => {
    updateLocalValue(selectedIndex)
  }, [selectedIndex, updateLocalValue])

  // 拖动期间的实时档位：标题文字和 max 视觉跟手变化
  const displayIndex = Math.min(Math.max(Math.round(localValue), 0), MAX_INDEX)
  const displayEffort = REASONING_EFFORT_OPTIONS[displayIndex] ?? selectedEffort
  const isMax = displayEffort.value === 'max'
  const [renderUltra, setRenderUltra] = useState(isMax)
  const [isUltraExiting, setIsUltraExiting] = useState(false)
  const ultraExitTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (ultraExitTimerRef.current !== null) {
      window.clearTimeout(ultraExitTimerRef.current)
      ultraExitTimerRef.current = null
    }

    if (isMax) {
      setRenderUltra(true)
      setIsUltraExiting(false)
    } else if (renderUltra) {
      setIsUltraExiting(true)
      ultraExitTimerRef.current = window.setTimeout(() => {
        setRenderUltra(false)
        setIsUltraExiting(false)
        ultraExitTimerRef.current = null
      }, ULTRA_TRANSITION_MS)
    }

    return () => {
      if (ultraExitTimerRef.current !== null) {
        window.clearTimeout(ultraExitTimerRef.current)
        ultraExitTimerRef.current = null
      }
    }
  }, [isMax])

  const handleChange = (nextValue: number | number[]) => {
    updateLocalValue(sliderValue(nextValue))
  }

  const handleChangeEnd = (nextValue: number | number[]) => {
    const finalIndex = Math.min(Math.max(Math.round(sliderValue(nextValue)), 0), MAX_INDEX)
    updateLocalValue(finalIndex) // 松手吸附到最近档位
    const option = REASONING_EFFORT_OPTIONS[finalIndex]
    if (option) onChange(option.value)
  }

  // 键盘走整档：step=0.01 是给指针拖动用的，方向键若按 0.01 步进，
  // 松手吸附会把位移抹掉；捕获阶段拦下来直接跳档
  const commitIndex = (nextIndex: number) => {
    const clamped = Math.min(Math.max(nextIndex, 0), MAX_INDEX)
    updateLocalValue(clamped)
    const option = REASONING_EFFORT_OPTIONS[clamped]
    if (option) onChange(option.value)
  }

  const handleSliderKeyDownCapture = (event: React.KeyboardEvent) => {
    const arrowDelta: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
    let nextIndex: number | null = null
    if (event.key in arrowDelta) nextIndex = displayIndex + arrowDelta[event.key]
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = MAX_INDEX
    if (nextIndex === null) return
    event.preventDefault()
    event.stopPropagation()
    commitIndex(nextIndex)
  }

  return (
    <Popover>
      <Button
        aria-label={`思考强度：${selectedEffort.label}`}
        className={committedIsMax
          ? 'ct-agent-trigger-button pl-1.5 [--button-fg:var(--accent)]'
          : 'ct-agent-trigger-button pl-1.5'}
        size="sm"
        variant="ghost"
      >
        <Bulb aria-hidden className="size-3.5 shrink-0" />
        <span className="text-xs">{reasoningEffortLabel(selectedEffort.value, true)}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      </Button>

      <Popover.Content
        className="w-[min(23.5rem,calc(100vw-1.5rem))] overflow-visible border-0 bg-transparent p-0 shadow-none"
        offset={8}
        placement="top end"
        shouldFlip
      >
        <Popover.Dialog className="p-0">
          <Card className="ct-agent-reasoning-card" variant="transparent">
            <Card.Header className="ct-agent-reasoning-card-header">
              <Card.Title className="ct-agent-reasoning-title">
                <span className="ct-agent-reasoning-title-label">思考强度</span>
                <span
                  className={isMax ? 'ct-agent-reasoning-status ct-agent-reasoning-status-active' : 'ct-agent-reasoning-status'}
                  data-direction={statusDirection ?? undefined}
                  key={displayEffort.value}
                >
                  {displayEffort.label}
                </span>
              </Card.Title>
              <Tooltip closeDelay={80} delay={120}>
                <Tooltip.Trigger>
                  <Button
                    aria-label="思考强度说明"
                    className="ct-agent-reasoning-help"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                  >
                    <CircleQuestion aria-hidden className="size-4.5" />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content placement="top end">强度越高，回答通常越深入，但响应更慢、消耗更多</Tooltip.Content>
              </Tooltip>
            </Card.Header>

            <Card.Content className="ct-agent-reasoning-card-content">
              <div aria-hidden className="ct-agent-reasoning-scale-labels">
                <span>更快</span>
                <span>更聪明</span>
              </div>

              {/* step=0.01：react-aria 默认 step=1 会在拖动中把值量化到整数档，拇指一顿一顿；
                  小步长让拖动连续跟手，松手在 onChangeEnd 里吸附 */}
              <div onKeyDownCapture={handleSliderKeyDownCapture}>
                <Slider
                  aria-label="选择思考强度"
                  className="w-full"
                  maxValue={MAX_INDEX}
                  minValue={0}
                  step={0.01}
                  value={localValue}
                  onChange={handleChange}
                  onChangeEnd={handleChangeEnd}
                >
                <Slider.Track className="ct-agent-reasoning-track relative w-full">
                  <div aria-hidden className="ct-agent-reasoning-track-visual">
                    {renderUltra && <AgentReasoningCanvas isExiting={isUltraExiting} />}
                    {!isMax && (
                      <div className="ct-agent-reasoning-dots">
                        {REASONING_EFFORT_OPTIONS.map((option) => (
                          <span
                            className="ct-agent-reasoning-dot"
                            key={option.value}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <Slider.Thumb
                    ref={setThumbNode}
                    className="ct-agent-reasoning-thumb"
                    data-glass={thumbGlassMap ? true : undefined}
                    data-max={isMax || undefined}
                    style={thumbBackdrop ? { backdropFilter: thumbBackdrop, WebkitBackdropFilter: thumbBackdrop } : undefined}
                  />
                </Slider.Track>
                </Slider>
              </div>
              {thumbGlassMap && (
                <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
                  <filter
                    id={thumbGlassId}
                    colorInterpolationFilters="sRGB"
                    filterUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width={thumbGlassMap.width}
                    height={thumbGlassMap.height}
                  >
                    <feImage href={thumbGlassMap.href} xlinkHref={thumbGlassMap.href} width={thumbGlassMap.width} height={thumbGlassMap.height} result="displacementMap" />
                    <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={thumbGlassMap.scale} xChannelSelector="R" yChannelSelector="G" />
                  </filter>
                </svg>
              )}
              <span aria-live="polite" className="sr-only">当前思考强度：{displayEffort.label}</span>
            </Card.Content>
          </Card>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
