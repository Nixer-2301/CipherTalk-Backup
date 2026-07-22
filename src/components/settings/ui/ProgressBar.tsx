import type { ReactNode } from 'react'
import './ProgressBar.css'

interface ProgressBarProps {
  value: number
  label?: ReactNode
  meta?: ReactNode
  action?: ReactNode
  className?: string
  minVisibleValue?: number
}

function ProgressBar({ value, label, meta, action, className = '', minVisibleValue = 0 }: ProgressBarProps) {
  const safeValue = Number.isFinite(value) ? value : 0
  const width = Math.max(minVisibleValue, Math.min(100, safeValue))
  const classes = ['download-progress', className].filter(Boolean).join(' ')

  if (meta) {
    return (
      <div className={classes}>
        <div className="progress-main">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${width}%` }} />
          </div>
          {label && <span>{label}</span>}
          {action && <div className="progress-action">{action}</div>}
        </div>
        <div className="progress-meta">{meta}</div>
      </div>
    )
  }

  return (
    <div className={classes}>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${width}%` }} />
      </div>
      {label && <span className="progress-text">{label}</span>}
      {action && <div className="progress-action">{action}</div>}
    </div>
  )
}

export default ProgressBar
