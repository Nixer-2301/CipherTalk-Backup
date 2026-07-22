import { ReactNode } from 'react'
import { ArrowsRotateRight } from '@gravity-ui/icons'
import { usePlatformInfo } from '../hooks/usePlatformInfo'
import { useTitleBarStore } from '../stores/titleBarStore'
import { useUpdateStatusStore } from '../stores/updateStatusStore'
import './TitleBar.scss'

interface TitleBarProps {
  className?: string
  rightContent?: ReactNode
  title?: string
  variant?: 'app' | 'standalone'
  showTitle?: boolean
}

function TitleBar({ className, rightContent, title, variant = 'app', showTitle = true }: TitleBarProps) {
  const storeRightContent = useTitleBarStore(state => state.rightContent)
  const storeTitle = useTitleBarStore(state => state.title)
  const displayContent = rightContent ?? storeRightContent
  const displayTitle = title ?? storeTitle
  const isUpdating = useUpdateStatusStore(state => state.isUpdating)
  const { isMac } = usePlatformInfo()
  const titleBarClassName = ['title-bar', `variant-${variant}`, isMac ? 'is-mac' : 'is-win', className]
    .filter(Boolean)
    .join(' ')

  const updateStatusNode = isUpdating ? (
    <div className="update-status">
      <ArrowsRotateRight
        className="update-indicator"
        width={16}
        height={16}
        strokeWidth={2.5}
      />
      <span className="update-text">正在同步数据...</span>
    </div>
  ) : null

  const titleNode = showTitle ? (
    <>
      <img src="./logo.png" alt="密语" className="title-logo" />
      <span className="titles">{displayTitle || 'CipherTalk'}</span>
    </>
  ) : null

  return (
    <div className={titleBarClassName}>
      <div className="title-bar-left">
        {isMac ? (
          <div className="title-bar-traffic-spacer" aria-hidden="true" />
        ) : (
          <>
            {titleNode}
            {updateStatusNode}
          </>
        )}
      </div>
      {isMac && (
        <div className="title-bar-center">
          {titleNode}
        </div>
      )}
      <div className="title-bar-right">
        {isMac && updateStatusNode}
        {displayContent}
      </div>
    </div>
  )
}

export default TitleBar
