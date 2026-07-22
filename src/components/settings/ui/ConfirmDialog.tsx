import type { ReactNode } from 'react'
import './ConfirmDialog.scss'

interface ConfirmDialogProps {
  title: ReactNode
  message?: ReactNode
  titleIcon?: ReactNode
  actions: ReactNode
}

function ConfirmDialog({ title, message, titleIcon, actions }: ConfirmDialogProps) {
  return (
    <div className="clear-dialog-overlay">
      <div className="clear-dialog">
        <h3 className={`dialog-title ${titleIcon ? 'has-icon' : ''}`}>
          {titleIcon}
          {title}
        </h3>
        {message && <p>{message}</p>}
        <div className="dialog-actions">
          {actions}
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
