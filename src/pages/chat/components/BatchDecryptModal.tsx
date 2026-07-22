import { CircleDashed, CircleExclamation, Picture } from '@gravity-ui/icons'
import { Button, Checkbox, Label, Modal, ProgressBar } from '@heroui/react'
import type { BatchImageMessage } from '../types'
import { formatBatchDateLabel } from '../utils/time'

type Progress = { current: number; total: number }

interface BatchDecryptModalProps {
  showConfirm: boolean
  onCloseConfirm: () => void
  imageDates: string[]
  countByDate: Map<string, number>
  selectedDates: Set<string>
  selectedCount: number
  onToggleDate: (date: string) => void
  onSelectAllDates: () => void
  onClearAllDates: () => void
  onConfirm: () => void | Promise<void>
  showProgress: boolean
  progress: Progress
  imageMessages: BatchImageMessage[] | null
}

export function BatchDecryptModal({
  showConfirm,
  onCloseConfirm,
  imageDates,
  countByDate,
  selectedDates,
  selectedCount,
  onToggleDate,
  onSelectAllDates,
  onClearAllDates,
  onConfirm,
  showProgress,
  progress
}: BatchDecryptModalProps) {
  return (
    <>
      <Modal.Backdrop isOpen={showConfirm} onOpenChange={(open) => { if (!open) onCloseConfirm() }}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-110">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-default text-foreground">
                <Picture className="size-5" />
              </Modal.Icon>
              <Modal.Heading>批量解密图片</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-muted">选择要解密的日期（仅显示有图片的日期），然后开始解密。</p>

              {imageDates.length > 0 && (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Button size="sm" variant="tertiary" onPress={onSelectAllDates}>全选</Button>
                    <Button size="sm" variant="tertiary" onPress={onClearAllDates}>取消全选</Button>
                  </div>
                  <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {imageDates.map(dateStr => {
                      const count = countByDate.get(dateStr) ?? 0
                      const checked = selectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <Checkbox
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface"
                            isSelected={checked}
                            onChange={() => onToggleDate(dateStr)}
                          >
                            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            <Checkbox.Content className="flex flex-1 items-center justify-between">
                              <Label>{formatBatchDateLabel(dateStr)}</Label>
                              <span className="text-xs text-muted">{count} 张图片</span>
                            </Checkbox.Content>
                          </Checkbox>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="mt-3 text-sm">
                <span className="text-muted">已选：</span>
                <span className="font-medium">{selectedDates.size} 天有图片，共 {selectedCount} 张图片</span>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
                <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                <span>批量解密可能需要较长时间，解密过程中可以继续使用其他功能。已解密过的图片会自动跳过。</span>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="secondary">取消</Button>
              <Button onPress={onConfirm}>
                <Picture className="size-4" />
                开始解密
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showProgress} isDismissable={false}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-90">
            <Modal.Header>
              <Modal.Icon className="bg-default text-foreground">
                <CircleDashed className="size-5 animate-spin" />
              </Modal.Icon>
              <Modal.Heading>正在解密图片...</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <ProgressBar aria-label="解密进度" value={progress.current} maxValue={Math.max(1, progress.total)}>
                <Label>已完成 {progress.current} / {progress.total} 张</Label>
                <ProgressBar.Output />
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
