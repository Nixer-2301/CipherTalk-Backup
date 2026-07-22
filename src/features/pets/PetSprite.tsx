import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { PET_STATES, type PetStateId } from './petStates'

/**
 * petdex 精灵图渲染器：纯 CSS steps() 逐帧动画，无 JS 帧循环。
 * src 可以是本地宠物的 data URL，也可以是 petdex 在线画廊的精灵图 URL。
 */
export function PetSprite({
  src,
  state = 'idle',
  scale = 0.15,
  className,
  label,
}: {
  src: string
  state?: PetStateId
  scale?: number
  className?: string
  label?: string
}) {
  const spec = PET_STATES[state] ?? PET_STATES.idle
  return (
    <span
      aria-label={label ?? 'AI 宠物'}
      className={cn('ct-pet-sprite-frame shrink-0', className)}
      role="img"
      style={{ '--pet-scale': scale } as CSSProperties}
    >
      <span
        className="ct-pet-sprite"
        style={{
          '--sprite-url': `url("${src.replace(/"/g, '\\"')}")`,
          '--sprite-row': spec.row,
          '--sprite-frames': spec.frames,
          '--sprite-duration': `${spec.durationMs}ms`,
        } as CSSProperties}
      />
    </span>
  )
}
