import { useState } from 'react'
import { Calendar as CalendarIcon, CircleDashed } from '@gravity-ui/icons'
import { Button, Calendar, Popover } from '@heroui/react'
import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date'

interface DateJumpPickerProps {
  /** 当前选中日期，'YYYY-MM-DD' 或 '' */
  value: string
  /** 更新选中日期 */
  onChange: (date: string) => void
  /** 触发跳转 */
  onJump: (date: string) => void
  disabled?: boolean
  loading?: boolean
}

function toCalendarValue(value: string): DateValue | null {
  if (!value) return null
  try {
    return parseDate(value)
  } catch {
    return null
  }
}

/**
 * 日期跳转选择器：HeroUI Popover + Calendar 替换原自定义 AppDatePicker。
 * 触发按钮沿用现有 icon-btn 样式；选中日期即跳转并收起弹层（禁选未来）。
 */
export function DateJumpPicker({ value, onChange, onJump, disabled, loading }: DateJumpPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const maxValue = today(getLocalTimeZone())

  const handleSelect = (date: DateValue) => {
    const str = date.toString() // CalendarDate → 'YYYY-MM-DD'
    onChange(str)
    onJump(str)
    setIsOpen(false)
  }

  return (
    <Popover isOpen={isOpen && !disabled} onOpenChange={(open) => { if (!disabled) setIsOpen(open) }}>
      <Popover.Trigger>
        <Button isIconOnly size="sm" variant="ghost" isDisabled={disabled} aria-label="跳转到日期">
          {loading ? <CircleDashed width={18} height={18} className="animate-spin" /> : <CalendarIcon width={18} height={18} />}
        </Button>
      </Popover.Trigger>
      <Popover.Content placement="bottom right">
        <Popover.Dialog>
          <Calendar
            aria-label="跳转到日期"
            value={toCalendarValue(value)}
            onChange={handleSelect}
            maxValue={maxValue}
          >
            <Calendar.Header>
              <Calendar.NavButton slot="previous" />
              <Calendar.Heading />
              <Calendar.NavButton slot="next" />
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(date) => <Calendar.Cell date={date} />}
              </Calendar.GridBody>
            </Calendar.Grid>
          </Calendar>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
