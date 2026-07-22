import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Comment, FileText, FileZipper, Handset, Link, MapPin, Person, Play, Video } from '@gravity-ui/icons'
import MessageContent from '../../../../components/MessageContent'
import { ChannelVideoCard, LinkSource, LinkThumb, MiniProgramThumb } from './AppMessageCards'
import { emojiDataUrlCache } from './mediaState'
import type { ChatSession, Message } from '../../../../types/models'

interface TextBubbleProps {
  message: Message
  session: ChatSession
  isSent: boolean
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void
}

/**
 * 文字/富文本消息气泡（localType !== 3/34/43/10000）
 * 处理：表情包、AppMessage（链接/文件/转账/红包/礼物/音乐/视频号/小程序等）、
 * 名片、位置、通话、以及普通文本消息
 */
function TextBubble({ message, session, isSent, onContextMenu }: TextBubbleProps) {
  const isEmoji = message.localType === 47

  // 表情包相关状态
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey)
  )
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)

  // 转账相关状态
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    if (!message.transferPayerUsername || !message.transferReceiverUsername) return
    if (message.localType !== 49 && message.localType !== 8589934592049) return
    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      message.transferPayerUsername,
      message.transferReceiverUsername
    ).then((result: { payerName: string; receiverName: string }) => {
      setTransferPayerName(result.payerName)
      setTransferReceiverName(result.receiverName)
    }).catch(() => {})
  }, [message.transferPayerUsername, message.transferReceiverUsername, session.username])

  // 下载表情包
  const downloadEmoji = useCallback(() => {
    if (emojiLoading) return
    if (!message.emojiCdnUrl && !message.emojiMd5) return

    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      setEmojiLocalPath(cached)
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)

    const cdnUrl = message.emojiCdnUrl || ''
    window.electronAPI.chat.downloadEmoji(cdnUrl, message.emojiMd5, message.productId, message.createTime, message.emojiEncryptUrl, message.emojiAesKey).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setEmojiLocalPath(result.localPath)
      } else {
        console.error('[ChatPage] 表情包下载失败:', result.error)
        setEmojiError(true)
      }
    }).catch((e) => {
      console.error('[ChatPage] 表情包下载异常:', e)
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }, [emojiLoading, message.emojiCdnUrl, message.emojiMd5, message.productId, message.createTime, message.emojiEncryptUrl, message.emojiAesKey, cacheKey])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    if (isEmoji && (message.emojiCdnUrl || message.emojiMd5) && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiMd5, message.productId, emojiLocalPath, emojiLoading, emojiError, downloadEmoji])

  // 获取头像首字母
  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // ======= 表情包消息 =======
  if (isEmoji) {
    const cannotFetch = !message.emojiCdnUrl && !message.emojiMd5
    if (cannotFetch || emojiError) {
      return (
        <div
          className="emoji-unavailable"
          onClick={() => {
            setEmojiError(false)
            downloadEmoji()
          }}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 15s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
          <span>表情包未缓存</span>
        </div>
      )
    }

    if (emojiLoading || !emojiLocalPath) {
      return (
        <div className="emoji-loading" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
      )
    }

    return (
      <img
        src={emojiLocalPath}
        alt="表情"
        className="emoji-image"
        decoding="async"
        onError={() => setEmojiError(true)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
      />
    )
  }

  // ======= AppMessage (链接/文件/转账/红包等) =======
  const isAppMsg = message.rawContent?.includes('<appmsg') || (message.parsedContent && message.parsedContent.includes('<appmsg'))

  if (isAppMsg) {
    let title = '链接'
    let desc = ''
    let url = ''
    let thumbUrl = ''
    let appMsgType = ''
    let isPat = false
    let textAnnouncement = ''
    let cdnthumbmd5 = ''
    let sourcedisplayname = ''
    let sourceusername = ''
    let coverPicUrl = ''

    try {
      const content = message.rawContent || message.parsedContent || ''
      const xmlContent = content.substring(content.indexOf('<msg>'))

      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlContent, 'text/xml')

      title = doc.querySelector('title')?.textContent || '链接'
      desc = (doc.querySelector('des')?.textContent || '').replace(/\\n/g, '\n')
      url = doc.querySelector('url')?.textContent || ''
      appMsgType = doc.querySelector('appmsg > type')?.textContent || doc.querySelector('type')?.textContent || ''
      isPat = appMsgType === '62' || Boolean(doc.querySelector('patinfo'))
      textAnnouncement = doc.querySelector('textannouncement')?.textContent || ''
      cdnthumbmd5 = doc.querySelector('cdnthumbmd5')?.textContent || ''
      sourcedisplayname = doc.querySelector('sourcedisplayname')?.textContent || ''
      sourceusername = doc.querySelector('sourceusername')?.textContent || ''
      coverPicUrl = doc.querySelector('coverpicimageurl')?.textContent || ''
    } catch (e) {
      console.error('解析 AppMsg 失败:', e)
    }

    // 拍一拍 (appmsg type=62)
    if (isPat) {
      const text = (title || '').trim() || '[拍一拍]'
      return (
        <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
          <MessageContent content={text} />
        </div>
      )
    }

    // 群公告 (type=87)
    if (appMsgType === '87') {
      const announcementText = textAnnouncement || desc || '群公告'
      return (
        <div className="announcement-message" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
          <div className="announcement-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <div className="announcement-content">
            <div className="announcement-label">群公告</div>
            <div className="announcement-text">{announcementText}</div>
          </div>
        </div>
      )
    }

    // 聊天记录 (type=19)
    if (appMsgType === '19') {
      const displayTitle = title || '群聊的聊天记录'
      return (
        <div
          className="link-message chat-record-message"
          onClick={(e) => {
            e.stopPropagation()
            window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
          }}
          title="点击查看详细聊天记录"
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
        >
          <div className="link-header">
            <div className="link-title" title={displayTitle}>{displayTitle}</div>
          </div>
          <div className="link-body">
            <div className="chat-record-preview">
              <div className="chat-record-desc">{desc || '点击打开查看完整聊天记录'}</div>
            </div>
            <div className="chat-record-icon"><Comment width={18} height={18} /></div>
          </div>
        </div>
      )
    }

    // 文件消息 (type=6)
    if (appMsgType === '6') {
      const fileName = message.fileName || title || '文件'
      const fileSize = message.fileSize
      const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''

      const formatFileSize = (bytes: number | undefined): string => {
        if (!bytes) return ''
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
        return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      }

      const getFileIcon = (ext: string) => {
        const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
        if (archiveExts.includes(ext)) return <FileZipper width={28} height={28} />
        return <FileText width={28} height={28} />
      }

      const handleFileClick = async () => {
        try {
          const wechatDir = await window.electronAPI.config.get('dbPath') as string
          if (!wechatDir) return

          const userInfo = await window.electronAPI.chat.getMyUserInfo()
          if (!userInfo.success || !userInfo.userInfo) return

          const wxid = userInfo.userInfo.wxid
          const msgDate = new Date(message.createTime * 1000)
          const year = msgDate.getFullYear()
          const month = String(msgDate.getMonth() + 1).padStart(2, '0')
          const dateFolder = `${year}-${month}`
          const isWin = window.navigator.platform.toLowerCase().includes('win')
          const sep = isWin ? '\\' : '/'

          const candidates = [
            `${wechatDir}${sep}${wxid}${sep}msg${sep}file${sep}${dateFolder}${sep}${fileName}`,
            `${wechatDir}${sep}${wxid}${sep}FileStorage${sep}File${sep}${dateFolder}${sep}${fileName}`,
            `${wechatDir}${sep}FileStorage${sep}File${sep}${dateFolder}${sep}${fileName}`,
          ]

          let opened = false
          for (const filePath of candidates) {
            try {
              await window.electronAPI.shell.showItemInFolder(filePath)
              opened = true
              break
            } catch { /* try next */ }
          }

          if (!opened) {
            const fileDir = `${wechatDir}${sep}${wxid}${sep}msg${sep}file${sep}${dateFolder}`
            try {
              const result = await window.electronAPI.shell.openPath(fileDir)
              if (result) {
                await window.electronAPI.shell.openPath(`${wechatDir}${sep}${wxid}${sep}msg${sep}file`)
              }
            } catch {
              await window.electronAPI.shell.openPath(wechatDir)
            }
          }
        } catch (error) {
          console.error('打开文件夹失败:', error)
        }
      }

      return (
        <div
          className="file-message"
          onClick={handleFileClick}
          style={{ cursor: 'pointer' }}
          title="点击定位到文件所在文件夹"
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
        >
          <div className="file-icon">{getFileIcon(fileExt)}</div>
          <div className="file-info">
            <div className="file-name" title={fileName}>{fileName}</div>
            <div className="file-meta">{fileSize ? formatFileSize(fileSize) : ''}</div>
          </div>
        </div>
      )
    }

    // 转账消息 (type=2000)
    if (appMsgType === '2000') {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const transferDoc = parser.parseFromString(xmlStr, 'text/xml')

        const feedesc = transferDoc.querySelector('feedesc')?.textContent || ''
        const payMemo = transferDoc.querySelector('pay_memo')?.textContent || ''
        const paysubtype = transferDoc.querySelector('paysubtype')?.textContent || '1'
        const isReceived = paysubtype === '3'
        const transferDesc = transferPayerName && transferReceiverName
          ? `${transferPayerName} 转账给 ${transferReceiverName}`
          : ''

        return (
          <div className={`transfer-message ${isReceived ? 'received' : ''}`} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <div className="transfer-icon">
              {isReceived ? (
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                  <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                  <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <div className="transfer-info">
              {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
              <div className="transfer-amount">{feedesc}</div>
              {payMemo && <div className="transfer-memo">{payMemo}</div>}
              <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
            </div>
          </div>
        )
      } catch {
        return (
          <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <MessageContent content={message.parsedContent} />
          </div>
        )
      }
    }

    // 红包消息 (type=2001)
    if (appMsgType === '2001') {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlStr, 'text/xml')
        const greeting = doc.querySelector('receivertitle')?.textContent || doc.querySelector('sendertitle')?.textContent || ''
        return (
          <div className="hongbao-message" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <div className="hongbao-icon">
              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                <rect x="4" y="6" width="32" height="28" rx="4" fill="white" fillOpacity="0.3" />
                <rect x="4" y="6" width="32" height="14" rx="4" fill="white" fillOpacity="0.2" />
                <circle cx="20" cy="20" r="6" fill="white" fillOpacity="0.4" />
                <text x="20" y="24" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">¥</text>
              </svg>
            </div>
            <div className="hongbao-info">
              <div className="hongbao-greeting">{greeting || '恭喜发财，大吉大利'}</div>
              <div className="hongbao-label">微信红包</div>
            </div>
          </div>
        )
      } catch {
        return (
          <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <MessageContent content={message.parsedContent} />
          </div>
        )
      }
    }

    // 微信礼物 (type=115)
    if (appMsgType === '115') {
      try {
        const content = message.rawContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlStr, 'text/xml')
        const wish = doc.querySelector('wishmessage')?.textContent || '送你一份心意'
        const skutitle = doc.querySelector('skutitle')?.textContent || ''
        const skuimg = doc.querySelector('skuimgurl')?.textContent || ''
        const skuprice = doc.querySelector('skuprice')?.textContent || ''
        const priceYuan = skuprice ? (parseInt(skuprice) / 100).toFixed(2) : ''
        return (
          <div className="gift-message" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            {skuimg && <img className="gift-img" src={skuimg} alt="" referrerPolicy="no-referrer" />}
            <div className="gift-info">
              <div className="gift-wish">{wish}</div>
              {skutitle && <div className="gift-name">{skutitle}</div>}
              {priceYuan && <div className="gift-price">¥{priceYuan}</div>}
              <div className="gift-label">微信礼物</div>
            </div>
          </div>
        )
      } catch {
        return (
          <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <MessageContent content={message.parsedContent} />
          </div>
        )
      }
    }

    // 音乐分享 (type=3)
    if (appMsgType === '3') {
      try {
        const content = message.rawContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlStr, 'text/xml')
        const musicTitle = doc.querySelector('title')?.textContent || ''
        const des = doc.querySelector('des')?.textContent || ''
        const musicUrl = doc.querySelector('url')?.textContent || ''
        const albumUrl = doc.querySelector('songalbumurl')?.textContent || ''
        const appname = doc.querySelector('appname')?.textContent || ''
        return (
          <div className="music-message" onClick={() => musicUrl && window.electronAPI.shell.openExternal(musicUrl)} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <div className="music-cover">
              {albumUrl ? <img src={albumUrl} alt="" referrerPolicy="no-referrer" /> : <Play width={24} height={24} />}
            </div>
            <div className="music-info">
              <div className="music-title">{musicTitle || '未知歌曲'}</div>
              {des && <div className="music-artist">{des}</div>}
              {appname && <div className="music-source">{appname}</div>}
            </div>
          </div>
        )
      } catch {
        return (
          <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <MessageContent content={message.parsedContent} />
          </div>
        )
      }
    }

    // 视频号消息 (type=51)
    if (appMsgType === '51') {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const p = new DOMParser()
        const d = p.parseFromString(xmlStr, 'text/xml')
        const finder = d.querySelector('finderFeed')
        if (finder) {
          const getCDATA = (tag: string) => finder.querySelector(tag)?.textContent?.trim() || ''
          const media = finder.querySelector('mediaList media')
          const getMediaCDATA = (tag: string) => media?.querySelector(tag)?.textContent?.trim() || ''
          const channelInfo = {
            title: getCDATA('desc') || '视频号视频',
            author: getCDATA('nickname'),
            avatar: getCDATA('avatar'),
            thumbUrl: getMediaCDATA('thumbUrl'),
            coverUrl: getMediaCDATA('coverUrl'),
            duration: parseInt(getMediaCDATA('videoPlayDuration')) || undefined,
          }
          return <ChannelVideoCard info={channelInfo} />
        }
      } catch { /* fallthrough */ }
    }

    // 小程序消息 (type=33 或 type=36)
    if (appMsgType === '33' || appMsgType === '36') {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const p = new DOMParser()
        const d = p.parseFromString(xmlStr, 'text/xml')
        const weappinfo = d.querySelector('weappinfo')
        const weappiconurl = weappinfo?.querySelector('weappiconurl')?.textContent?.trim() || ''
        const thumbRawUrl = weappinfo?.querySelector('weapppagethumbrawurl')?.textContent?.trim() || ''

        return (
          <div className="miniprogram-card" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
            <div className="miniprogram-header">
              {weappiconurl ? (
                <img className="miniprogram-icon" src={weappiconurl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="miniprogram-icon-placeholder" />
              )}
              <span className="miniprogram-name">{sourcedisplayname || '小程序'}</span>
            </div>
            <div className="miniprogram-title">{title}</div>
            <div className="miniprogram-cover">
              {cdnthumbmd5 && session ? (
                <MiniProgramThumb imageMd5={cdnthumbmd5} sessionId={session.username} fallbackUrl={thumbRawUrl} iconUrl={weappiconurl} />
              ) : thumbRawUrl ? (
                <img className="miniprogram-cover-img" src={thumbRawUrl} alt="" referrerPolicy="no-referrer" />
              ) : weappiconurl ? (
                <div className="miniprogram-cover-icon"><img src={weappiconurl} alt="" referrerPolicy="no-referrer" /></div>
              ) : (
                <div className="miniprogram-cover-placeholder" />
              )}
            </div>
            <div className="miniprogram-footer">
              <svg className="miniprogram-logo" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4" /></svg>
              <span>小程序</span>
            </div>
          </div>
        )
      } catch { /* fallthrough */ }
    }

    // 公众号图文 (type=5)
    if (url && coverPicUrl && appMsgType === '5') {
      return (
        <div className="link-message link-message--cover" onClick={(e) => { e.stopPropagation(); window.electronAPI.window.openBrowserWindow(url, title) }} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
          <div className="link-cover">
            <img src={coverPicUrl} alt="" referrerPolicy="no-referrer" />
          </div>
          <div className="link-header"><span className="link-title">{title}</span></div>
          {sourcedisplayname ? <LinkSource username={sourceusername} name={sourcedisplayname} badge="公众号图文" /> : <div className="link-source"><span className="card-badge">公众号图文</span></div>}
        </div>
      )
    }

    // 通用链接卡片
    if (url) {
      return (
        <div
          className="link-message"
          onClick={(e) => {
            e.stopPropagation()
            window.electronAPI.window.openBrowserWindow(url, title)
          }}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}
        >
          <div className="link-header">
            <span className="link-title">{title}</span>
          </div>
          <div className="link-body">
            <div className="link-desc">{desc}</div>
            {cdnthumbmd5 && session ? (
              <LinkThumb imageMd5={cdnthumbmd5} sessionId={session.username} />
            ) : (
              <div className="link-thumb-placeholder"><Link width={24} height={24} /></div>
            )}
          </div>
          {sourcedisplayname && <LinkSource username={sourceusername} name={sourcedisplayname} badge="公众号文章" />}
        </div>
      )
    }

    // AppMessage XML 解析成功但未匹配已知类型，降级显示
    return (
      <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <MessageContent content={message.parsedContent} />
      </div>
    )
  }

  // ======= 名片消息 (type=42) =======
  if (message.localType === 42) {
    const raw = message.rawContent || ''
    const nickname = raw.match(/nickname="([^"]*)"/)?.[1] || '未知'
    const avatar = raw.match(/bigheadimgurl="([^"]*)"/)?.[1] || raw.match(/smallheadimgurl="([^"]*)"/)?.[1]
    const alias = raw.match(/alias="([^"]*)"/)?.[1]
    const province = raw.match(/province="([^"]*)"/)?.[1]
    return (
      <div className="contact-card-message" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <div className="contact-card-avatar">
          {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <Person width={24} height={24} />}
        </div>
        <div className="contact-card-info">
          <div className="contact-card-name">{nickname}</div>
          {(alias || province) && <div className="contact-card-detail">{[alias, province].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="contact-card-badge">个人名片</div>
      </div>
    )
  }

  // ======= 位置消息 (type=48) =======
  if (message.localType === 48) {
    const raw = message.rawContent || ''
    const poiname = raw.match(/poiname="([^"]*)"/)?.[1] || ''
    const label = raw.match(/label="([^"]*)"/)?.[1] || ''
    const lat = parseFloat(raw.match(/x="([^"]*)"/)?.[1] || '0')
    const lng = parseFloat(raw.match(/y="([^"]*)"/)?.[1] || '0')
    const zoom = 15
    const n = Math.pow(2, zoom)
    const tileX = Math.floor((lng + 180) / 360 * n)
    const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)
    const tileUrl = `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
    return (
      <div className="location-message" onClick={() => window.electronAPI.shell.openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(poiname || label)}`)} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <div className="location-text">
          <MapPin width={16} height={16} className="location-icon" />
          <div className="location-info">
            {poiname && <div className="location-name">{poiname}</div>}
            {label && <div className="location-label">{label}</div>}
          </div>
        </div>
        {lat !== 0 && lng !== 0 && (
          <div className="location-map">
            <img src={tileUrl} alt="" referrerPolicy="no-referrer" />
            <div className="location-pin"><MapPin width={20} height={20} fill="#e25b4a" color="#fff" /></div>
          </div>
        )}
      </div>
    )
  }

  // ======= 通话消息 (type=50) =======
  if (message.localType === 50) {
    const raw = message.rawContent || ''
    const isVideoCall = /<room_type>0<\/room_type>/.test(raw)
    const Icon = isVideoCall ? Video : Handset
    return (
      <div className="bubble-content" style={{ display: 'flex', alignItems: 'center', gap: 6, flexDirection: isSent ? 'row-reverse' : 'row' }} onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
        <Icon width={16} height={16} style={{ transform: isSent ? 'scaleX(-1)' : undefined }} />
        <span>{message.parsedContent}</span>
      </div>
    )
  }

  // ======= 调试：未适配的消息类型 =======
  if (message.localType !== 1) {
    console.log('[ChatPage] 未适配的消息:', message)
  }

  // ======= 普通文本消息 (type=1 或兜底) =======
  return (
    <div className="bubble-content" onContextMenu={onContextMenu ? (e) => onContextMenu(e, message) : undefined}>
      <MessageContent content={message.parsedContent} />
    </div>
  )
}

function areTextBubblePropsEqual(prev: TextBubbleProps, next: TextBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.isSent === next.isSent
}

export default memo(TextBubble, areTextBubblePropsEqual)
