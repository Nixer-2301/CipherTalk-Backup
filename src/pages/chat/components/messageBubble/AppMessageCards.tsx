import { useEffect, useState } from 'react'
import { Link, Video } from '@gravity-ui/icons'

export function ChannelVideoCard({ info }: { info: { title: string; author: string; avatar?: string; thumbUrl?: string; coverUrl?: string; duration?: number } }) {
  return (
    <div className="channel-video-card">
      <div className="channel-video-cover">
        {info.coverUrl || info.thumbUrl ? (
          <img src={info.coverUrl || info.thumbUrl} alt="" />
        ) : (
          <div className="channel-video-cover-placeholder"><Video width={24} height={24} /></div>
        )}
        {info.duration && (
          <span className="channel-video-duration">{Math.floor(info.duration / 60)}:{String(info.duration % 60).padStart(2, '0')}</span>
        )}
      </div>
      <div className="channel-video-info">
        <div className="channel-video-title">{info.title}</div>
        <div className="channel-video-author">
          {info.avatar && <img src={info.avatar} alt="" className="channel-video-avatar" />}
          <span>{info.author}</span>
          <span className="card-badge">视频号</span>
        </div>
      </div>
    </div>
  )
}

export function LinkThumb({ imageMd5, sessionId }: { imageMd5: string; sessionId: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    window.electronAPI.image.decrypt({ sessionId, imageMd5 }).then(r => {
      if (!cancelled && r.success && r.localPath) setSrc('file://' + r.localPath)
    })
    return () => { cancelled = true }
  }, [imageMd5, sessionId])
  if (!src) return <div className="link-thumb-placeholder"><Link width={24} height={24} /></div>
  return <img className="link-thumb" src={src} alt="" />
}

export function MiniProgramThumb({ imageMd5, sessionId, fallbackUrl, iconUrl }: { imageMd5: string; sessionId: string; fallbackUrl?: string; iconUrl?: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.image.decrypt({ sessionId, imageMd5 }).then(r => {
      if (cancelled) return
      if (r.success && r.localPath) setSrc('file://' + r.localPath)
      else setFailed(true)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [imageMd5, sessionId])
  const imgSrc = src || (failed ? fallbackUrl : '')
  if (imgSrc) return <img className="miniprogram-cover-img" src={imgSrc} alt="" referrerPolicy="no-referrer" />
  if (failed && iconUrl) return <div className="miniprogram-cover-icon"><img src={iconUrl} alt="" referrerPolicy="no-referrer" /></div>
  if (failed) return <div className="miniprogram-cover-placeholder" />
  return null
}

export function LinkSource({ username, name, badge }: { username: string; name: string; badge?: string }) {
  const [avatar, setAvatar] = useState('')
  useEffect(() => {
    if (!username) return
    window.electronAPI.chat.getContactAvatar(username).then(r => {
      if (r?.avatarUrl) setAvatar(r.avatarUrl)
    })
  }, [username])
  return (
    <div className="link-source">
      {avatar && <img className="link-source-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />}
      <span>{name}</span>
      {badge && <span className="card-badge">{badge}</span>}
    </div>
  )
}
