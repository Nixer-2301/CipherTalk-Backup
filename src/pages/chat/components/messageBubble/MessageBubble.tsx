import { memo, useEffect, useRef, useState } from 'react'
import { Check } from '@gravity-ui/icons'

import { useChatStore } from '../../../../stores/chatStore'
import type { ChatSession, Message } from '../../../../types/models'
import { emojiDataUrlCache, enqueueDecrypt, imageDataUrlCache } from './mediaState'
import ImageBubble from './ImageBubble'
import SystemBubble from './SystemBubble'
import TextBubble from './TextBubble'
import VideoBubble from './VideoBubble'
import VoiceBubble from './VoiceBubble'

interface MessageBubbleProps {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
  hasImageKey?: boolean;
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void;
  isSelected?: boolean;
  selectMode?: boolean;
  quoteStyle?: 'default' | 'wechat' | 'card';
}

/**
 * 消息气泡入口组件
 * 根据 message.localType 路由分发到对应的子组件
 *
 * localType 路由规则：
 *   10000          → SystemBubble（系统消息）
 *   3              → ImageBubble（图片消息）
 *   34             → VoiceBubble（语音消息）
 *   43             → VideoBubble（视频消息）
 *   other (含 47)  → TextBubble（文本/表情包/富卡片消息）
 *
 * 注意：拍一拍消息（appmsg type=62）虽为 localType 49，但由 isSystem 检测捕获并路由到 SystemBubble
 */
function MessageBubble({ message, session, showTime, myAvatarUrl, isGroupChat, hasImageKey, onContextMenu, isSelected, selectMode, quoteStyle = 'default' }: MessageBubbleProps) {
  const syncVersion = useChatStore(state => state.syncVersion)
  const lastSyncVersionRef = useRef(syncVersion)

  const isPatAppMsg = (() => {
    const content = message.rawContent || message.parsedContent || ''
    if (!content) return false
    return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
  })()

  const isSystem = message.localType === 10000 || isPatAppMsg
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isSent = message.isSend === 1

  // Debug log when image messages are miscategorized
  useEffect(() => {
    if (isImage || message.parsedContent !== '[图片]') return
    console.warn('[ChatPage] 图片消息被当文本渲染', {
      localType: message.localType,
      localTypeType: typeof message.localType,
      localId: message.localId,
      createTime: message.createTime,
      sortSeq: message.sortSeq
    })
  }, [isImage, message.parsedContent, message.localType, message.localId, message.createTime, message.sortSeq])

  // 群聊发送者信息
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [senderCorp, setSenderCorp] = useState<string | undefined>(undefined)
  const [isLoadingSender, setIsLoadingSender] = useState(false)

  // 引用图片/表情缓存
  const [isVisible, setIsVisible] = useState(false)
  const [quotedImageLocalPath, setQuotedImageLocalPath] = useState<string | undefined>(() => {
    return message.quotedImageMd5 ? imageDataUrlCache.get(message.quotedImageMd5) : undefined
  })
  const [quotedEmojiLocalPath, setQuotedEmojiLocalPath] = useState<string | undefined>(() => {
    return message.quotedEmojiMd5 ? emojiDataUrlCache.get(message.quotedEmojiMd5) : undefined
  })

  const bubbleRef = useRef<HTMLDivElement>(null)

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // 获取头像首字母
  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // 群聊中获取发送者信息
  useEffect(() => {
    if (isGroupChat && !isSent && message.senderUsername) {
      setIsLoadingSender(true)
      window.electronAPI.chat.getContactAvatar(message.senderUsername).then((result: { avatarUrl?: string; displayName?: string; weComCorp?: string } | null) => {
        if (result) {
          setSenderAvatarUrl(result.avatarUrl)
          setSenderName(result.displayName)
          setSenderCorp(result.weComCorp)
        }
        setIsLoadingSender(false)
      }).catch(() => {
        setIsLoadingSender(false)
      })
    }
  }, [isGroupChat, isSent, message.senderUsername])

  // 引用图片/表情按消息气泡可见性延后加载
  useEffect(() => {
    const hasQuotedMedia = Boolean(message.quotedImageMd5 || message.quotedEmojiMd5 || message.quotedEmojiCdnUrl)
    if (!hasQuotedMedia || isVisible || !bubbleRef.current) return

    const scrollRoot = bubbleRef.current.closest('.message-list') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        root: scrollRoot,
        rootMargin: '1000px 0px',
        threshold: 0
      }
    )

    observer.observe(bubbleRef.current)
    return () => observer.disconnect()
  }, [message.quotedImageMd5, message.quotedEmojiMd5, message.quotedEmojiCdnUrl, isVisible])

  // 引用图片自动解密
  useEffect(() => {
    if (!message.quotedImageMd5) return
    if (!isVisible) return
    if (quotedImageLocalPath) return

    let cancelled = false
    const doDecrypt = async () => {
      if (cancelled) return
      try {
        const cached = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5
        })
        if (cancelled) return
        if (cached.success && cached.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, cached.localPath)
          setQuotedImageLocalPath(cached.localPath)
          return
        }

        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5,
          force: false,
          quick: true
        })
        if (cancelled) return
        if (result.success && result.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, result.localPath)
          setQuotedImageLocalPath(result.localPath)
        }
      } catch { }
    }

    enqueueDecrypt(doDecrypt)
    return () => {
      cancelled = true
    }
  }, [message.quotedImageMd5, quotedImageLocalPath, session.username, isVisible])

  // 引用表情包自动下载
  useEffect(() => {
    if (!message.quotedEmojiMd5 && !message.quotedEmojiCdnUrl) return
    if (!isVisible) return
    if (quotedEmojiLocalPath) return

    const cdnUrl = message.quotedEmojiCdnUrl || ''
    const md5 = message.quotedEmojiMd5 || ''

    if (md5 && emojiDataUrlCache.has(md5)) {
      setQuotedEmojiLocalPath(emojiDataUrlCache.get(md5))
      return
    }

    let cancelled = false
    window.electronAPI.chat.downloadEmoji(cdnUrl, md5).then((result: any) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        if (md5) emojiDataUrlCache.set(md5, result.localPath)
        setQuotedEmojiLocalPath(result.localPath)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [message.quotedEmojiMd5, message.quotedEmojiCdnUrl, quotedEmojiLocalPath, isVisible])

  // ========= 系统消息：直接渲染，无气泡外壳 =========
  if (isSystem) {
    return <SystemBubble message={message} />
  }

  // ========= 普通消息气泡外壳 =========
  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：使用 myAvatarUrl
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const avatarUrl = isSent
    ? myAvatarUrl
    : (isGroupChat ? senderAvatarUrl : session.avatarUrl)
  const avatarLetter = isSent
    ? '我'
    : getAvatarLetter(isGroupChat ? (senderName || '?') : (session.displayName || session.username))

  const hasQuote = message.quotedContent && message.quotedContent.length > 0

  // 渲染消息内容（按 localType 路由分发）
  const renderContent = () => {
    // 带引用的消息（经典模式，引用在上方）
    if (!isImage && hasQuote && quoteStyle === 'default') {
      return (
        <div className="bubble-content">
          <div className="quoted-message" onClick={(quotedImageLocalPath || quotedEmojiLocalPath) ? (e) => { e.stopPropagation(); window.electronAPI.window.openImageViewerWindow((quotedImageLocalPath || quotedEmojiLocalPath)!) } : undefined} style={(quotedImageLocalPath || quotedEmojiLocalPath) ? { cursor: 'pointer' } : undefined}>
            <div className="quoted-message-content">
              <div className="quoted-text-container">
                {message.quotedSender && <span className="quoted-sender">{message.quotedSender}</span>}
                <span className="quoted-text">{(quotedImageLocalPath || quotedEmojiLocalPath) ? null : message.quotedContent}</span>
              </div>
              {quotedImageLocalPath && (
                <div className="quoted-image-container">
                  <img src={quotedImageLocalPath} alt="引用图片" className="quoted-image-thumb" />
                </div>
              )}
              {!quotedImageLocalPath && quotedEmojiLocalPath && (
                <div className="quoted-image-container">
                  <img src={quotedEmojiLocalPath} alt="表情" className="quoted-image-thumb" />
                </div>
              )}
            </div>
          </div>
          <div className="message-text">
            {renderContentBody()}
          </div>
        </div>
      )
    }

    return renderContentBody()
  }

  // 实际消息体路由（无 quotes）
  const renderContentBody = () => {
    if (isImage) {
      return <ImageBubble message={message} session={session} hasImageKey={hasImageKey} onContextMenu={onContextMenu} />
    }
    if (isVideo) {
      return <VideoBubble message={message} session={session} isSent={isSent} onContextMenu={onContextMenu} />
    }
    if (isVoice) {
      return <VoiceBubble message={message} session={session} isSent={isSent} onContextMenu={onContextMenu} />
    }
    return <TextBubble message={message} session={session} isSent={isSent} onContextMenu={onContextMenu} />
  }

  return (
    <>
      {showTime && (
        <div className="time-divider">
          <span>{formatTime(message.createTime)}</span>
        </div>
      )}
      <div
        ref={bubbleRef}
        className={`message-bubble ${bubbleClass} quote-style-${quoteStyle} ${isEmoji && message.emojiCdnUrl ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVideo ? 'video' : ''} ${isVoice ? 'voice' : ''} ${selectMode ? 'select-mode' : ''} ${isSelected ? 'selected' : ''}`}
        onContextMenu={(e) => {
          if (onContextMenu) {
            onContextMenu(e, message)
          }
        }}
      >
        <div className="bubble-avatar">
          {isLoadingSender && isGroupChat && !isSent ? (
            <div className="avatar-skeleton-wrapper">
              <span className="avatar-skeleton" />
            </div>
          ) : avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="avatar-letter">{avatarLetter}</span>
          )}
        </div>
        <div className="bubble-body">
          {/* 群聊中显示发送者名称 */}
          {isGroupChat && !isSent && (
            <div className="sender-name">
              {isLoadingSender ? (
                <span className="sender-skeleton" />
              ) : (
                <>
                  {senderName || '群成员'}
                  {message.senderUsername && message.senderUsername.includes('@openim') && !message.senderUsername.includes('@kefu.openim') && (
                    senderCorp
                      ? <span className="wecom-corp" title="企业微信">@{senderCorp}</span>
                      : <span className="wecom-badge" title="企业微信">企</span>
                  )}
                </>
              )}
            </div>
          )}
          <div className="bubble-select-line">
            {renderContent()}
            {selectMode && (
              <div className={`select-checkbox${isSelected ? ' checked' : ''}`}>
                {isSelected && <Check width={13} height={13} strokeWidth={3} />}
              </div>
            )}
          </div>

          {/* 引用消息 - 移至下方，单行显示（微信风格） */}
          {hasQuote && quoteStyle === 'wechat' && (
            <div className="bubble-quote">
              <div className="quote-content" onClick={(quotedImageLocalPath || quotedEmojiLocalPath) ? (e) => { e.stopPropagation(); window.electronAPI.window.openImageViewerWindow((quotedImageLocalPath || quotedEmojiLocalPath)!) } : undefined} style={(quotedImageLocalPath || quotedEmojiLocalPath) ? { cursor: 'pointer' } : undefined}>
                <span className="quote-text">
                  {(() => {
                    let sender = message.quotedSender
                    if (!sender && message.rawContent) {
                      const match = message.rawContent.match(/<displayname>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/displayname>/)
                      if (match) sender = match[1]
                    }
                    return sender ? <span className="quote-sender">{sender}: </span> : null
                  })()}
                  {(quotedImageLocalPath || quotedEmojiLocalPath) ? null : message.quotedContent}
                </span>
                {quotedImageLocalPath && (
                  <img src={quotedImageLocalPath} alt="" className="quote-image-thumb" />
                )}
                {!quotedImageLocalPath && quotedEmojiLocalPath && (
                  <img src={quotedEmojiLocalPath} alt="表情" className="quote-image-thumb" />
                )}
              </div>
            </div>
          )}

          {/* 引用消息 - 左线条风格 */}
          {hasQuote && quoteStyle === 'card' && (
            <div className="bubble-quote-line">
              <div className="quote-line-content" onClick={(quotedImageLocalPath || quotedEmojiLocalPath) ? (e) => { e.stopPropagation(); window.electronAPI.window.openImageViewerWindow((quotedImageLocalPath || quotedEmojiLocalPath)!) } : undefined} style={(quotedImageLocalPath || quotedEmojiLocalPath) ? { cursor: 'pointer' } : undefined}>
                <span className="quote-line-text">
                  {(() => {
                    let sender = message.quotedSender
                    if (!sender && message.rawContent) {
                      const match = message.rawContent.match(/<displayname>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/displayname>/)
                      if (match) sender = match[1]
                    }
                    return sender ? <span className="quote-line-sender">{sender}: </span> : null
                  })()}
                  {(quotedImageLocalPath || quotedEmojiLocalPath) ? null : message.quotedContent}
                </span>
                {quotedImageLocalPath && (
                  <img src={quotedImageLocalPath} alt="" className="quote-line-image-thumb" />
                )}
                {!quotedImageLocalPath && quotedEmojiLocalPath && (
                  <img src={quotedEmojiLocalPath} alt="表情" className="quote-line-image-thumb" />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function areMessageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.showTime === next.showTime &&
    prev.myAvatarUrl === next.myAvatarUrl &&
    prev.isGroupChat === next.isGroupChat &&
    prev.hasImageKey === next.hasImageKey &&
    prev.isSelected === next.isSelected &&
    prev.selectMode === next.selectMode &&
    prev.quoteStyle === next.quoteStyle
}

export default memo(MessageBubble, areMessageBubblePropsEqual)
