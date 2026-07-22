import { ArrowDownToLine } from '@gravity-ui/icons'
import { Button } from '@heroui/react'

interface ExportActionButtonProps {
  label: string
  isExporting: boolean
  disabled: boolean
  onClick: () => void
}

export default function ExportActionButton({ label, isExporting, disabled, onClick }: ExportActionButtonProps) {
  return (
    <Button
      variant="primary"
      fullWidth
      isPending={isExporting}
      isDisabled={disabled}
      onPress={onClick}
    >
      {!isExporting && <ArrowDownToLine width={18} height={18} />}
      {isExporting ? '导出中...' : label}
    </Button>
  )
}
