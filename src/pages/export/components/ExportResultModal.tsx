import { ArrowUpRightFromSquare, CircleCheck, CircleXmark } from '@gravity-ui/icons'
import { Modal, Button, Typography } from '@heroui/react'
import type { ExportResult } from '../types'

interface ExportResultModalProps {
  result: ExportResult
  /** 成功数量的单位，例如「个会话」「个联系人」「条朋友圈」 */
  unitLabel: string
  onOpenFolder: () => void
  onClose: () => void
}

export default function ExportResultModal({ result, unitLabel, onOpenFolder, onClose }: ExportResultModalProps) {
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className={result.success ? 'bg-success-soft text-success-soft-foreground' : 'bg-danger-soft text-danger-soft-foreground'}>
                {result.success ? <CircleCheck className="size-5" /> : <CircleXmark className="size-5" />}
              </Modal.Icon>
              <Modal.Heading>{result.success ? '导出完成' : '导出失败'}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {result.success ? (
                <Typography type="body-sm" className="text-muted">
                  {result.successCount !== undefined
                    ? `成功导出 ${result.successCount} ${unitLabel}`
                    : '导出成功'}
                  {result.failCount ? `，${result.failCount} 个失败` : ''}
                </Typography>
              ) : (
                <Typography type="body-sm" className="text-danger">{result.error}</Typography>
              )}
            </Modal.Body>
            <Modal.Footer>
              {result.success && (
                <Button variant="tertiary" onPress={onOpenFolder}>
                  <ArrowUpRightFromSquare width={16} height={16} />
                  打开文件夹
                </Button>
              )}
              <Button slot="close" variant="primary">关闭</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
