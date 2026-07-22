import { Button, DateField, DateRangePicker as HeroDateRangePicker, RangeCalendar } from '@heroui/react'
import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date'
import { Xmark } from '@gravity-ui/icons'

interface DateRangePickerProps {
  startDate: string
  endDate: string
  onStartDateChange: (date: string) => void
  onEndDateChange: (date: string) => void
  onRangeComplete?: () => void
}

type HeroDateRangeValue = {
  start: DateValue
  end: DateValue
}

function toDateValue(value: string): DateValue | null {
  if (!value) return null

  try {
    return parseDate(value)
  } catch {
    return null
  }
}

function toRangeValue(startDate: string, endDate: string): HeroDateRangeValue | null {
  const start = toDateValue(startDate)
  const end = toDateValue(endDate)

  if (!start || !end) return null
  return { start, end }
}

function DateRangePicker({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onRangeComplete,
}: DateRangePickerProps) {
  const value = toRangeValue(startDate, endDate)
  const maxValue = today(getLocalTimeZone())
  const hasValue = Boolean(startDate || endDate)

  const handleChange = (range: HeroDateRangeValue | null) => {
    const nextStart = range?.start?.toString() ?? ''
    const nextEnd = range?.end?.toString() ?? ''

    onStartDateChange(nextStart)
    onEndDateChange(nextEnd)

    if ((nextStart && nextEnd) || (!nextStart && !nextEnd)) {
      onRangeComplete?.()
    }
  }

  const handleClear = () => {
    onStartDateChange('')
    onEndDateChange('')
    onRangeComplete?.()
  }

  return (
    <div className="flex w-full items-center gap-2">
      <HeroDateRangePicker
        aria-label="时间范围"
        className="min-w-0 flex-1"
        value={value}
        maxValue={maxValue}
        onChange={handleChange}
      >
        <DateField.Group fullWidth>
          <DateField.Input slot="start">
            {(segment) => <DateField.Segment segment={segment} />}
          </DateField.Input>
          <HeroDateRangePicker.RangeSeparator className="px-2 text-default">-</HeroDateRangePicker.RangeSeparator>
          <DateField.Input slot="end">
            {(segment) => <DateField.Segment segment={segment} />}
          </DateField.Input>
          <DateField.Suffix>
            <HeroDateRangePicker.Trigger>
              <HeroDateRangePicker.TriggerIndicator />
            </HeroDateRangePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <HeroDateRangePicker.Popover>
          <RangeCalendar aria-label="选择时间范围">
            <RangeCalendar.Header>
              <RangeCalendar.YearPickerTrigger>
                <RangeCalendar.YearPickerTriggerHeading />
                <RangeCalendar.YearPickerTriggerIndicator />
              </RangeCalendar.YearPickerTrigger>
              <RangeCalendar.NavButton slot="previous" />
              <RangeCalendar.NavButton slot="next" />
            </RangeCalendar.Header>
            <RangeCalendar.Grid>
              <RangeCalendar.GridHeader>
                {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
              </RangeCalendar.GridHeader>
              <RangeCalendar.GridBody>
                {(date) => <RangeCalendar.Cell date={date} />}
              </RangeCalendar.GridBody>
            </RangeCalendar.Grid>
            <RangeCalendar.YearPickerGrid>
              <RangeCalendar.YearPickerGridBody>
                {({ year }) => <RangeCalendar.YearPickerCell year={year} />}
              </RangeCalendar.YearPickerGridBody>
            </RangeCalendar.YearPickerGrid>
          </RangeCalendar>
        </HeroDateRangePicker.Popover>
      </HeroDateRangePicker>
      {hasValue && (
        <Button type="button" variant="ghost" size="sm" isIconOnly onPress={handleClear} aria-label="清除时间范围">
          <Xmark width={14} height={14} />
        </Button>
      )}
    </div>
  )
}

export default DateRangePicker
