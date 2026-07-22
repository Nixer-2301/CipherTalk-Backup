import { Card, Checkbox } from '@heroui/react'
import type { FormatOption } from '../types'

interface FormatPickerProps {
  options: FormatOption[]
  value: string
  onChange: (value: string) => void
  'aria-label': string
}

export default function FormatPicker({ options, value, onChange, 'aria-label': ariaLabel }: FormatPickerProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="group" aria-label={ariaLabel}>
      {options.map(fmt => {
        const selected = value === fmt.value
        return (
          <Card
            key={fmt.value}
            variant={selected ? 'secondary' : 'default'}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            onClick={() => onChange(fmt.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(fmt.value) } }}
            className="cursor-pointer gap-2"
          >
            <Card.Header className="gap-1">
              <div className="flex items-center gap-2">
                <fmt.icon width={18} height={18} className="shrink-0" />
                <Card.Title className="flex-1 text-sm">{fmt.label}</Card.Title>
                <Checkbox isSelected={selected} isReadOnly aria-hidden>
                  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                </Checkbox>
              </div>
              <Card.Description className="text-xs">{fmt.desc}</Card.Description>
            </Card.Header>
          </Card>
        )
      })}
    </div>
  )
}
