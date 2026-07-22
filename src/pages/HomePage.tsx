import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowsRotateLeft, FaceSmile, Person, QuoteOpen } from '@gravity-ui/icons'
import { useAppStore } from '../stores/appStore'
import { getHomeBackgroundPresetSrc, useThemeStore } from '../stores/themeStore'
import WhatsNewModal from '../components/WhatsNewModal'
import { RandomMomentBubble } from '../features/home/RandomMomentBubble'
import { LiquidGlassBubble } from '../features/home/LiquidGlassBubble'
import { LiquidGlassBall } from '../features/home/LiquidGlassBall'
import {
  loadRandomMomentSnippet,
  MOMENT_EMOJI_TYPE,
  MOMENT_IMAGE_TYPE,
  MOMENT_TEXT_TYPE,
  MOMENT_VOICE_TYPE,
  type RandomMomentSnippet
} from '../features/home/randomMoment'
import './HomePage.css'

// 刷新按钮是 32px 圆形，玻璃贴图用全圆角 + 折射带铺满（edgeSize 盖过半径）
const REFRESH_BTN_GLASS = {
  radii: { topLeft: 16, topRight: 16, bottomRight: 16, bottomLeft: 16 },
  edgeSize: 14,
  edgeStrength: 7,
  surface: 0,
  strength: 6,
}

function HomePage() {
  const { isDbConnected } = useAppStore()
  const homeBackground = useThemeStore(s => s.homeBackground)
  const homeGlassBall = useThemeStore(s => s.homeGlassBall)

  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [currentAnnouncementId, setCurrentAnnouncementId] = useState('')
  const [currentAnnouncementContentId, setCurrentAnnouncementContentId] = useState('')
  const [failedBackgroundKey, setFailedBackgroundKey] = useState('')

  const [randomSnippet, setRandomSnippet] = useState<RandomMomentSnippet | null>(null)
  const [randomSnippetLoading, setRandomSnippetLoading] = useState(false)
  const [randomSnippetFetched, setRandomSnippetFetched] = useState(false)
  const [momentHint, setMomentHint] = useState<string | null>(null)
  const randomSnippetRunRef = useRef(0)

  useEffect(() => {
    checkNewVersion()
  }, [])

  const fetchRandomSnippet = useCallback(async () => {
    if (!isDbConnected) return

    const runId = ++randomSnippetRunRef.current
    const stale = () => runId !== randomSnippetRunRef.current

    setRandomSnippet(null)
    setMomentHint(null)
    setRandomSnippetFetched(false)
    setRandomSnippetLoading(true)

    try {
      const { snippet, hint } = await loadRandomMomentSnippet()
      if (stale()) return
      setRandomSnippet(snippet)
      setMomentHint(hint)
    } catch (e) {
      console.error('首页回忆一刻加载失败:', e)
      if (!stale()) {
        setRandomSnippet(null)
        setMomentHint(String(e))
      }
    } finally {
      if (!stale()) {
        setRandomSnippetLoading(false)
        setRandomSnippetFetched(true)
      }
    }
  }, [isDbConnected])

  useEffect(() => {
    if (!isDbConnected) {
      randomSnippetRunRef.current += 1
      setRandomSnippet(null)
      setMomentHint(null)
      setRandomSnippetLoading(false)
      setRandomSnippetFetched(false)
      return
    }
    fetchRandomSnippet()
  }, [isDbConnected, fetchRandomSnippet])

  const checkNewVersion = async () => {
    try {
      const version = await window.electronAPI.app.getVersion()
      setCurrentVersion(version)

      const [announcementVersion, announcementId, announcementContentId, seenVersion, seenId, seenContentId] = await Promise.all([
        window.electronAPI.config.get('releaseAnnouncementVersion'),
        window.electronAPI.config.get('releaseAnnouncementId'),
        window.electronAPI.config.get('releaseAnnouncementContentId')
          .catch(() => ''),
        window.electronAPI.config.get('releaseAnnouncementSeenVersion')
          .catch(() => ''),
        window.electronAPI.config.get('releaseAnnouncementSeenId')
          .catch(() => ''),
        window.electronAPI.config.get('releaseAnnouncementSeenContentId')
          .catch(() => '')
      ])

      const normalizedAnnouncementVersion = String(announcementVersion || '').trim()
      const normalizedAnnouncementId = String(announcementId || '').trim()
      const normalizedAnnouncementContentId = String(announcementContentId || '').trim()
      const normalizedSeenVersion = String(seenVersion || '').trim()
      const normalizedSeenId = String(seenId || '').trim()
      const normalizedSeenContentId = String(seenContentId || '').trim()
      setCurrentAnnouncementId(normalizedAnnouncementId)
      setCurrentAnnouncementContentId(normalizedAnnouncementContentId)

      const shouldShowAnnouncement = normalizedAnnouncementId
        ? normalizedSeenId !== normalizedAnnouncementId
        : normalizedSeenVersion !== version

      if (normalizedAnnouncementVersion === version && shouldShowAnnouncement) {
        setShowWhatsNew(true)
      }
    } catch (e) {
      console.error('检查新版本失败:', e)
    }
  }

  const handleCloseWhatsNew = () => {
    setShowWhatsNew(false)
    if (currentVersion) {
      window.electronAPI.config.set('releaseAnnouncementSeenVersion', currentVersion)
    }
    if (currentAnnouncementId) {
      window.electronAPI.config.set('releaseAnnouncementSeenId', currentAnnouncementId)
    }
    if (currentAnnouncementContentId) {
      window.electronAPI.config.set('releaseAnnouncementSeenContentId', currentAnnouncementContentId)
    }
  }

  const momentLt = randomSnippet?.message.localType
  const isTextBubble = momentLt === MOMENT_TEXT_TYPE
  const isVoiceBubble = momentLt === MOMENT_VOICE_TYPE
  const isImageOrEmojiBare = momentLt === MOMENT_IMAGE_TYPE || momentLt === MOMENT_EMOJI_TYPE
  const customBackgroundKey = `${homeBackground.customType}:${homeBackground.customUrl}`
  const presetBackgroundSrc = getHomeBackgroundPresetSrc(homeBackground.preset)
  const canUseCustomBackground = homeBackground.source === 'custom'
    && Boolean(homeBackground.customUrl)
    && (homeBackground.customType === 'image' || homeBackground.customType === 'video')
    && failedBackgroundKey !== customBackgroundKey
  const backgroundStyle = {
    '--home-background-blur': `${homeBackground.blur}px`
  } as CSSProperties

  useEffect(() => {
    setFailedBackgroundKey('')
  }, [customBackgroundKey, homeBackground.source])

  const handleBackgroundError = () => {
    if (canUseCustomBackground) {
      setFailedBackgroundKey(customBackgroundKey)
    }
  }

  return (
    <div className="home-page">
      {canUseCustomBackground && homeBackground.customType === 'image' ? (
        <img
          className="home-background-media"
          src={homeBackground.customUrl}
          alt=""
          decoding="async"
          style={backgroundStyle}
          onError={handleBackgroundError}
          aria-hidden="true"
        />
      ) : (
        <video
          className="home-background-media"
          src={canUseCustomBackground ? homeBackground.customUrl : presetBackgroundSrc}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          style={backgroundStyle}
          onError={handleBackgroundError}
          aria-hidden="true"
        />
      )}
      {homeGlassBall && <LiquidGlassBall size={120} />}
      <button
        className="whats-new-btn"
        aria-label="打开开发者愿景"
        onClick={() => setShowWhatsNew(true)}
      >
        <FaceSmile width={18} height={18} />
      </button>
      {showWhatsNew && (
        <WhatsNewModal
          version={currentVersion}
          onClose={handleCloseWhatsNew}
        />
      )}

      {isDbConnected && (
        <div className="random-message-card" aria-busy={randomSnippetLoading}>
          <div className="random-message-card-header">
            <h3 className="random-message-heading">
              <QuoteOpen width={16} height={16} aria-hidden />
              <span>回忆一刻</span>
            </h3>
          </div>
          {randomSnippetLoading && (
            <div className="random-message-skeleton" aria-busy="true" aria-label="加载回忆一刻">
              <div className="random-message-skel-avatar" />
              <div className="random-message-skel-main">
                <div className="random-message-skel-name" />
                <div className="random-message-skel-bubble-wrap">
                  <div className="random-message-skel-bubble">
                    <span className="random-message-skel-line" />
                    <span className="random-message-skel-line random-message-skel-line--mid" />
                    <span className="random-message-skel-line random-message-skel-line--short" />
                  </div>
                </div>
              </div>
            </div>
          )}
          {!randomSnippetLoading && randomSnippetFetched && randomSnippet && (
            <div className="random-message-inner">
              <div className="random-message-avatar">
                {randomSnippet.avatarUrl ? (
                  <img src={randomSnippet.avatarUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <Person width={22} height={22} />
                )}
              </div>
              <div className="random-message-main">
                <div className="random-message-name">{randomSnippet.displayName}</div>
                <div className="random-message-bubble-row">
                  <div className="random-message-body-wrap">
                    {isImageOrEmojiBare ? (
                      <div className="random-message-body-wrap--bare">
                        <RandomMomentBubble sessionId={randomSnippet.sessionId} message={randomSnippet.message} />
                      </div>
                    ) : isTextBubble ? (
                      <LiquidGlassBubble>
                        <RandomMomentBubble sessionId={randomSnippet.sessionId} message={randomSnippet.message} />
                      </LiquidGlassBubble>
                    ) : isVoiceBubble ? (
                      <LiquidGlassBubble as="div" className="random-message-body random-message-body--glass random-message-body--media">
                        <RandomMomentBubble sessionId={randomSnippet.sessionId} message={randomSnippet.message} />
                      </LiquidGlassBubble>
                    ) : (
                      <div className="random-message-body random-message-body--media">
                        <RandomMomentBubble sessionId={randomSnippet.sessionId} message={randomSnippet.message} />
                      </div>
                    )}
                  </div>
                  <LiquidGlassBubble
                    as="button"
                    type="button"
                    glass={REFRESH_BTN_GLASS}
                    className="random-message-refresh-btn random-message-refresh-btn--glass"
                    onClick={() => fetchRandomSnippet()}
                    disabled={randomSnippetLoading}
                    data-tooltip="换一条"
                    aria-label="换一条"
                  >
                    <ArrowsRotateLeft width={15} height={15} className={randomSnippetLoading ? 'spinning' : undefined} aria-hidden />
                  </LiquidGlassBubble>
                </div>
              </div>
            </div>
          )}
          {!randomSnippetLoading && randomSnippetFetched && !randomSnippet && (
            <p className="random-message-placeholder muted">
              {momentHint || '暂无可展示的回忆。'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default HomePage
