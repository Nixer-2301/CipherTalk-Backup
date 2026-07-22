import { createPortal } from 'react-dom'
import { Xmark } from '@gravity-ui/icons'
import MessageContent from '../../../../components/MessageContent'
import type { Message } from '../../../../types/models'

interface EnlargeViewModalProps {
  view: { message: Message; content: string } | null
  onClose: () => void
}

export function EnlargeViewModal({ view, onClose }: EnlargeViewModalProps) {
  if (!view) return null

  return createPortal(
    <div className="enlarge-view-overlay" onClick={onClose}>
      <div className="enlarge-view-content" onClick={(e) => e.stopPropagation()}>
        <div className="enlarge-view-header">
          <h3>放大阅读</h3>
          <button className="close-btn" onClick={onClose}>
            <Xmark width={16} height={16} />
          </button>
        </div>
        <div className="enlarge-view-body">
          <MessageContent content={view.content} />
        </div>
      </div>
    </div>,
    document.body
  )
}
