import { useEffect, useState } from 'react'
import { Button, Calendar, Modal } from '@heroui/react'
import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date'
import { Calendar as CalendarIcon } from '@gravity-ui/icons'
import { formatDateValue, parseDateValue } from './AppDatePicker'

interface JumpToDateDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (date: Date) => void
  currentDate?: Date | null
}

function toDateValue(value: string): DateValue | null {
  if (!value) return null

  try {
    return parseDate(value)
  } catch {
    return null
  }
}

function JumpToDateDialog({ isOpen, onClose, onSelect, currentDate }: JumpToDateDialogProps) {
  const [selectedDate, setSelectedDate] = useState('')
  const maxValue = today(getLocalTimeZone())

  useEffect(() => {
    if (isOpen) {
      setSelectedDate(currentDate ? formatDateValue(currentDate) : '')
    }
  }, [isOpen, currentDate])

  const handleJump = () => {
    const date = parseDateValue(selectedDate)
    if (!date) return
    onSelect(date)
    onClose()
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-90">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Icon>
              <CalendarIcon width={18} height={18} />
            </Modal.Icon>
            <Modal.Heading>选择日期</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <Calendar
              aria-label="选择跳转日期"
              value={toDateValue(selectedDate)}
              maxValue={maxValue}
              onChange={(date) => setSelectedDate(date.toString())}
            >
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
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
              <Calendar.YearPickerGrid>
                <Calendar.YearPickerGridBody>
                  {({ year }) => <Calendar.YearPickerCell year={year} />}
                </Calendar.YearPickerGridBody>
              </Calendar.YearPickerGrid>
            </Calendar>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="tertiary" slot="close">取消</Button>
            <Button type="button" onPress={handleJump} isDisabled={!selectedDate}>跳转</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

export default JumpToDateDialog
