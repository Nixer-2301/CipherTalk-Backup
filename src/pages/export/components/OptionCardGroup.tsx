import type { IconComponent } from '@/types/icon'
import { Card, Checkbox } from '@heroui/react'

export interface OptionCardItem {
  key: string
  label: string
  icon: IconComponent
}

interface OptionCardGroupProps {
  items: OptionCardItem[]
  isSelected: (key: string) => boolean
  onToggle: (key: string, checked: boolean) => void
  'aria-label': string
}

// 多选卡片组：与导出格式同样的 Card 外观，但每项可独立勾选
export default function OptionCardGroup({ items, isSelected, onToggle, 'aria-label': ariaLabel }: OptionCardGroupProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="group" aria-label={ariaLabel}>
      {items.map(({ key, label, icon: Icon }) => {
        const selected = isSelected(key)
        return (
          <Card
            key={key}
            variant={selected ? 'secondary' : 'default'}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            onClick={() => onToggle(key, !selected)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(key, !selected) } }}
            className="cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Icon width={18} height={18} className="shrink-0" />
              <span className="flex-1 text-sm">{label}</span>
              <Checkbox isSelected={selected} isReadOnly aria-hidden>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              </Checkbox>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
