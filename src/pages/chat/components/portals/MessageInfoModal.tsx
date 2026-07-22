import { createPortal } from 'react-dom'
import { CircleInfo, Xmark } from '@gravity-ui/icons'
import type { Message } from '../../../../types/models'

interface MessageInfoModalProps {
  message: Message | null
  onClose: () => void
}

export function MessageInfoModal({ message, onClose }: MessageInfoModalProps) {
  if (!message) return null

  return createPortal(
    <div className="message-info-overlay" onClick={onClose}>
      <div className="message-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="message-info-header">
          <div className="message-info-title">
            <CircleInfo width={18} height={18} />
            <h3>消息详细信息</h3>
          </div>
          <button className="message-info-close-btn" onClick={onClose} aria-label="关闭消息详情">
            <Xmark width={18} height={18} />
          </button>
        </div>
        <div className="message-info-body">
          <div className="info-section">
            <h4>基础字段</h4>
            <div className="info-grid">
              <div className="info-item">
                <span className="label">Local ID</span>
                <span className="value select-text">{message.localId}</span>
              </div>
              <div className="info-item">
                <span className="label">Server ID</span>
                <span className="value select-text">{message.serverId}</span>
              </div>
              <div className="info-item">
                <span className="label">Local Type</span>
                <span className="value select-text">{message.localType}</span>
              </div>
              <div className="info-item">
                <span className="label">发送者</span>
                <span className="value select-text">{message.senderUsername}</span>
              </div>
              <div className="info-item">
                <span className="label">创建时间</span>
                <span className="value select-text">{new Date(message.createTime * 1000).toLocaleString()} ({message.createTime})</span>
              </div>
              <div className="info-item">
                <span className="label">发送状态</span>
                <span className="value select-text">{message.isSend === 1 ? '发送' : '接收'}</span>
              </div>
            </div>
          </div>

          {(message.emojiMd5 || message.emojiCdnUrl) && (
            <div className="info-section">
              <h4>表情包信息</h4>
              <div className="info-list">
                {message.emojiMd5 && (
                  <div className="info-item block">
                    <span className="label">MD5</span>
                    <span className="value select-text code">{message.emojiMd5}</span>
                  </div>
                )}
                {message.emojiCdnUrl && (
                  <div className="info-item block">
                    <span className="label">CDN URL</span>
                    <span className="value select-text code break-all">{message.emojiCdnUrl}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {message.rawContent && (
            <div className="info-section">
              <h4>原始消息内容 (XML/Raw)</h4>
              <div className="raw-content-container">
                <pre className="select-text">{message.rawContent}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
