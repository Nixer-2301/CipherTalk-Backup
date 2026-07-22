import { Button } from '@heroui/react'
import { FloppyDisk } from '@gravity-ui/icons'

interface FloatingSaveButtonProps {
  hasChanges: boolean
  disabled?: boolean
  onClick: () => void
}

function FloatingSaveButton({ hasChanges, disabled = false, onClick }: FloatingSaveButtonProps) {
  return (
    <Button
      aria-label={hasChanges ? '保存未保存的更改' : '保存配置'}
      className="fixed right-6 bottom-6 z-[1000]"
      isDisabled={disabled}
      isIconOnly
      onPress={onClick}
      size="lg"
      variant={hasChanges ? 'danger' : 'primary'}
    >
      <FloppyDisk width={20} height={20} />
    </Button>
  )
}

export default FloatingSaveButton
