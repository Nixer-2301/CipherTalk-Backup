import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Description, Label, Radio, RadioGroup, Slider, Switch, Tabs, type Key } from '@heroui/react'
import { ArrowUpToLine, Display, LayoutFooter, LayoutSideContentLeft, Moon, Picture, Sun, Video } from '@gravity-ui/icons'
import {
  HOME_BACKGROUND_PRESETS,
  getHomeBackgroundPresetPoster,
  getHomeBackgroundPresetSrc,
  useThemeStore,
  type HomeBackgroundPreset,
  type HomeBackgroundSource,
  type NavLayout
} from '../../../stores/themeStore'
import { useAppStore } from '../../../stores/appStore'
import { useSettingsStore } from '../settingsStore'
import QuoteStyleOptionCard, { type QuoteStyle } from '../QuoteStyleOptionCard'
import Select from '../../Select'

type ThemeMode = 'light' | 'dark' | 'system'

// 磁贴窗口支持 Windows/macOS；Linux 暂不显示入口。
const SUPPORTS_REPLY_TILE = /win|mac/.test(navigator.platform.toLowerCase())

const toThemeMode = (key: Key): ThemeMode => String(key) as ThemeMode
const toNavLayout = (key: Key): NavLayout => String(key) as NavLayout
const toHomeBackgroundSource = (key: Key): HomeBackgroundSource => String(key) as HomeBackgroundSource

const toSliderNumber = (value: number | number[]): number => Array.isArray(value) ? value[0] ?? 0 : value
const normalizeImageSrc = (value?: string): string | undefined => {
  const src = value?.trim()
  if (!src) return undefined
  return /^(https?:|file:|data:image\/|blob:)/i.test(src) ? src : undefined
}
const getAvatarFallback = (name?: string, wxid?: string): string => {
  const text = (name || wxid || '我').trim()
  return text.slice(0, 2) || '我'
}

/**
 * 背景视频预览：默认只展示静态画面，悬停才播放。
 * 有 poster（预设视频的抽帧图）时用 preload="none"，挂载时完全不初始化解码器，
 * 消除进入外观页的卡顿；无 poster（自定义视频）时退回 #t=0.1 画首帧。
 */
function HoverPlayVideo({ src, poster, className, style }: { src: string; poster?: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null)
  return (
    <video
      aria-hidden="true"
      className={className}
      muted
      loop
      playsInline
      poster={poster}
      preload={poster ? 'none' : 'metadata'}
      ref={ref}
      src={(poster || src.includes('#')) ? src : `${src}#t=0.1`}
      style={style}
      title="悬停预览"
      onMouseEnter={() => { void ref.current?.play().catch(() => undefined) }}
      onMouseLeave={() => { ref.current?.pause() }}
    />
  )
}

function AppearanceTab() {
  const {
    themeMode,
    navLayout,
    dockAutoHide,
    homeGlassBall,
    homeBackground,
    setThemeMode,
    setNavLayout,
    setDockAutoHide,
    setHomeGlassBall,
    setHomeBackgroundSource,
    setHomeBackgroundPreset,
    setHomeBackgroundCustom,
    setHomeBackgroundBlur
  } = useThemeStore()
  const quoteStyle = useSettingsStore(s => s.config.quoteStyle)
  const closeToTray = useSettingsStore(s => s.config.closeToTray)
  const hardwareAccelerationEnabled = useSettingsStore(s => s.config.hardwareAccelerationEnabled)
  const setField = useSettingsStore(s => s.setField)
  const userInfo = useAppStore(s => s.userInfo)
  // 磁贴全局开关：立即生效（不走设置页的暂存-保存模型），本地态从主进程读
  const [replyTileEnabled, setReplyTileEnabled] = useState(false)
  useEffect(() => {
    if (SUPPORTS_REPLY_TILE) void window.electronAPI.window.getReplyTileEnabled().then(setReplyTileEnabled)
  }, [])
  const [backgroundImporting, setBackgroundImporting] = useState(false)
  const [backgroundError, setBackgroundError] = useState('')
  const avatarUrl = normalizeImageSrc(userInfo?.avatarUrl)
  const avatarFallback = getAvatarFallback(userInfo?.nickName, userInfo?.wxid)

  const customBackgroundReady = Boolean(homeBackground.customUrl)
    && (homeBackground.customType === 'image' || homeBackground.customType === 'video')
  const presetBackgroundSrc = getHomeBackgroundPresetSrc(homeBackground.preset)
  const presetBackgroundPoster = getHomeBackgroundPresetPoster(homeBackground.preset)
  const backgroundPreviewStyle = {
    '--home-background-preview-blur': `${homeBackground.blur}px`
  } as CSSProperties

  const handlePickBackground = async () => {
    setBackgroundError('')
    setBackgroundImporting(true)
    try {
      const result = await window.electronAPI.dialog.openFile({
        properties: ['openFile'],
        filters: [
          { name: '图片或视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'ogg'] },
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
          { name: '视频', extensions: ['mp4', 'webm', 'ogg'] }
        ]
      })
      const sourcePath = result.filePaths?.[0]
      if (result.canceled || !sourcePath) return

      const imported = await window.electronAPI.file.importHomeBackground(sourcePath)
      if (!imported.success || !imported.path || !imported.url || !imported.mediaType) {
        setBackgroundError(imported.error || '导入背景失败')
        return
      }

      setHomeBackgroundCustom({
        type: imported.mediaType,
        path: imported.path,
        url: imported.url
      })
    } catch (e) {
      setBackgroundError(`导入背景失败：${e}`)
    } finally {
      setBackgroundImporting(false)
    }
  }

  return (
    <div className="tab-content">
      <h3 className="section-title">主题模式</h3>
      <Tabs selectedKey={themeMode} onSelectionChange={(key) => setThemeMode(toThemeMode(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="外观模式" className="*:gap-2">
            <Tabs.Tab id="light"><Sun width={16} height={16} aria-hidden />浅色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dark"><Moon width={16} height={16} aria-hidden />深色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="system"><Display width={16} height={16} aria-hidden />跟随系统<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {SUPPORTS_REPLY_TILE && (
        <>
          <h3 className="section-title" style={{ marginTop: '2rem' }}>回复建议磁贴</h3>
          <Switch
            className="max-w-2xl"
            isSelected={replyTileEnabled}
            onChange={(enabled) => { void window.electronAPI.window.setReplyTileEnabled(enabled).then(setReplyTileEnabled) }}
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label>磁贴窗口常显示</Label>
              <Description>开启后，磁贴会常驻贴在微信主窗口旁（放不下自动翻到左侧），显示已在聊天窗口开启「磁贴窗口」参与的会话的回复建议。关闭则不显示。</Description>
            </Switch.Content>
          </Switch>
        </>
      )}

      <h3 className="section-title" style={{ marginTop: '2rem' }}>导航布局</h3>
      <Tabs selectedKey={navLayout} onSelectionChange={(key) => setNavLayout(toNavLayout(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="导航布局" className="*:gap-2">
            <Tabs.Tab id="sidebar"><LayoutSideContentLeft width={16} height={16} aria-hidden />侧边栏<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dock"><LayoutFooter width={16} height={16} aria-hidden />底部 Dock<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {navLayout === 'dock' && (
        <>
          <h3 className="section-title" style={{ marginTop: '1.5rem' }}>Dock 自动收起</h3>
          <Select<'on' | 'off'>
            style={{ maxWidth: 460 }}
            value={dockAutoHide ? 'on' : 'off'}
            onChange={(v) => setDockAutoHide(v === 'on')}
            options={[
              {
                value: 'on',
                label: '空闲时自动收起',
                description: '鼠标离开 Dock 2.5 秒后收回；移到屏幕底部重新浮出'
              },
              {
                value: 'off',
                label: '始终显示',
                description: 'Dock 一直停留在底部不收起'
              }
            ]}
          />
        </>
      )}

      <h3 className="section-title" style={{ marginTop: '2rem' }}>首页玻璃球</h3>
      <Switch
        className="max-w-2xl"
        isSelected={homeGlassBall}
        onChange={(enabled) => setHomeGlassBall(enabled)}
      >
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Content>
          <Label>首页玻璃球</Label>
          <Description>默认开启。首页显示一个可拖动的液态玻璃球。</Description>
        </Switch.Content>
      </Switch>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>首页背景</h3>
      <div className="home-background-settings">
        <Tabs
          selectedKey={homeBackground.source}
          onSelectionChange={(key) => setHomeBackgroundSource(toHomeBackgroundSource(key))}
          className="w-full max-w-md"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="首页背景来源" className="*:gap-2">
              <Tabs.Tab id="preset"><Video width={16} height={16} aria-hidden />预设背景<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="custom"><Picture width={16} height={16} aria-hidden />自定义<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <div className={`home-background-config home-background-config--${homeBackground.source}`}>
          {homeBackground.source === 'preset' && (
            <RadioGroup
              className="home-background-preset-options"
              name="homeBackgroundPreset"
              orientation="horizontal"
              value={homeBackground.preset}
              variant="secondary"
              onChange={(value) => setHomeBackgroundPreset(value as HomeBackgroundPreset)}
            >
              {HOME_BACKGROUND_PRESETS.map((preset) => (
                <Radio className="home-background-preset-radio" key={preset.id} value={preset.id}>
                  <Radio.Control className="home-background-preset-control">
                    <Radio.Indicator />
                  </Radio.Control>
                  <Radio.Content className="home-background-preset-radio-content">
                    <HoverPlayVideo
                      className="home-background-preset-video"
                      poster={preset.poster}
                      src={preset.src}
                      style={backgroundPreviewStyle}
                    />
                    <span className="home-background-preset-overlay">{preset.label}</span>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
          )}

          {homeBackground.source === 'custom' && (
            <>
              <div className="home-background-preview" aria-label="首页背景预览">
                {customBackgroundReady ? (
                  homeBackground.customType === 'image' ? (
                    <img src={homeBackground.customUrl} alt="" decoding="async" loading="lazy" style={backgroundPreviewStyle} />
                  ) : (
                    <HoverPlayVideo src={homeBackground.customUrl} style={backgroundPreviewStyle} />
                  )
                ) : (
                  <HoverPlayVideo poster={presetBackgroundPoster} src={presetBackgroundSrc} style={backgroundPreviewStyle} />
                )}
                <span className="home-background-preview-badge">
                  {customBackgroundReady
                    ? homeBackground.customType === 'image' ? '图片' : '视频'
                    : '预设视频'}
                </span>
              </div>
              <div className="home-background-controls">
                <button
                  type="button"
                  className="btn btn-secondary home-background-import-btn"
                  onClick={handlePickBackground}
                  disabled={backgroundImporting}
                >
                  <ArrowUpToLine width={16} height={16} aria-hidden />
                  {backgroundImporting ? '导入中...' : customBackgroundReady ? '更换背景' : '选择背景'}
                </button>
                {backgroundError && <div className="home-background-error">{backgroundError}</div>}
              </div>
            </>
          )}
        </div>

        <Slider
          className="home-background-blur-slider"
          value={homeBackground.blur}
          minValue={0}
          maxValue={30}
          step={1}
          onChange={(value) => setHomeBackgroundBlur(toSliderNumber(value))}
        >
          <Label>背景模糊度</Label>
          <Slider.Output>{homeBackground.blur}px</Slider.Output>
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>引用消息样式</h3>
      <RadioGroup
        className="quote-style-options"
        name="quoteStyle"
        orientation="horizontal"
        value={quoteStyle}
        variant="secondary"
        onChange={(value) => setField('quoteStyle', value as QuoteStyle)}
      >
        <QuoteStyleOptionCard
          avatarFallback={avatarFallback}
          avatarUrl={avatarUrl}
          value="default"
        />
        <QuoteStyleOptionCard
          avatarFallback={avatarFallback}
          avatarUrl={avatarUrl}
          value="wechat"
        />
        <QuoteStyleOptionCard
          avatarFallback={avatarFallback}
          avatarUrl={avatarUrl}
          value="card"
        />
      </RadioGroup>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>窗口关闭行为</h3>
      <RadioGroup
        className="window-close-options"
        name="closeToTray"
        orientation="horizontal"
        value={closeToTray ? 'tray' : 'quit'}
        variant="secondary"
        onChange={(value) => setField('closeToTray', value === 'tray')}
      >
        <Radio className="window-close-radio" value="tray">
          <Radio.Control className="absolute top-3 right-4 size-5">
            <Radio.Indicator />
          </Radio.Control>
          <Radio.Content className="window-close-radio-content">
            <Label>最小化到托盘</Label>
            <Description>点击关闭按钮后，应用将最小化到系统托盘继续运行</Description>
          </Radio.Content>
        </Radio>
        <Radio className="window-close-radio" value="quit">
          <Radio.Control className="absolute top-3 right-4 size-5">
            <Radio.Indicator />
          </Radio.Control>
          <Radio.Content className="window-close-radio-content">
            <Label>直接退出应用</Label>
            <Description>点击关闭按钮后，应用将完全退出</Description>
          </Radio.Content>
        </Radio>
      </RadioGroup>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>性能</h3>
      <Switch
        className="max-w-2xl"
        isSelected={hardwareAccelerationEnabled}
        onChange={(enabled) => setField('hardwareAccelerationEnabled', enabled)}
      >
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Content>
          <Label>GPU 加速</Label>
          <Description>默认开启。关闭后需要重启应用，适合显卡驱动异常、黑屏或渲染问题排查。</Description>
        </Switch.Content>
      </Switch>
    </div>
  )
}

export default AppearanceTab
