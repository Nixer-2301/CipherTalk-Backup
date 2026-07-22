import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
  type BrowserWindowConstructorOptions
} from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { autoUpdater } from 'electron-updater'
import { DatabaseService } from '../../services/database'
import { ConfigService } from '../../services/config'
import { LogService } from '../../services/logService'
import { appUpdateService } from '../../services/appUpdateService'
import { mcpProxyService } from '../../services/mcp/proxyService'
import { voiceTranscribeServiceWhisper } from '../../services/voiceTranscribeServiceWhisper'
import { attachWindowStartupDiagnostics, markStartupMilestone, logStartupError } from '../startupDiagnostics'
import type { ImageViewerOpenOptions, MainProcessContext, ReplyTileEntry, WindowManager } from '../context'
import { placeNativeWindowBehindForeground, probeWeChatWindow, watchWeChatWindowEvents } from '../../services/wechatWindowTracker'

type ReleaseAnnouncementPayload = {
  version: string
  releaseBody?: string
  releaseNotes?: string
  generatedAt?: string
}

const MAIN_WINDOW_ROUTES = new Set(['/home', '/agent', '/settings', '/pets', '/diary', '/export'])

function supportsReplyTileWindow(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function getReleaseAnnouncementPath(): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  return isDev
    ? join(__dirname, '../.tmp/release-announcement.json')
    : join(process.resourcesPath, 'release-announcement.json')
}

function buildReleaseAnnouncementContentId(releaseBody: string, releaseNotes: string): string {
  return createHash('sha256')
    .update(releaseBody)
    .update('\n')
    .update(releaseNotes)
    .digest('hex')
    .slice(0, 16)
}

function buildReleaseAnnouncementId(payload: ReleaseAnnouncementPayload, releaseBody: string, releaseNotes: string): string {
  const version = String(payload.version || '').trim()
  const generatedAt = String(payload.generatedAt || '').trim()
  if (generatedAt) return `${version}:${generatedAt}`

  return `${version}:${buildReleaseAnnouncementContentId(releaseBody, releaseNotes)}`
}

function syncPackagedReleaseAnnouncement(ctx: MainProcessContext) {
  const configService = ctx.getConfigService()
  if (!configService) return

  const announcementPath = getReleaseAnnouncementPath()
  if (!existsSync(announcementPath)) return

  try {
    const raw = readFileSync(announcementPath, 'utf8')
    const payload = JSON.parse(raw) as ReleaseAnnouncementPayload
    if (!payload || typeof payload !== 'object') return

    const version = String(payload.version || '').trim()
    if (!version || version !== app.getVersion()) return

    const releaseBody = String(payload.releaseBody || '').trim()
    const releaseNotes = String(payload.releaseNotes || '').trim()
    const announcementId = buildReleaseAnnouncementId(payload, releaseBody, releaseNotes)
    const announcementContentId = buildReleaseAnnouncementContentId(releaseBody, releaseNotes)

    const storedVersion = configService.get('releaseAnnouncementVersion')
    const storedId = configService.get('releaseAnnouncementId')
    const storedContentId = configService.get('releaseAnnouncementContentId')
    const storedBody = configService.get('releaseAnnouncementBody')
    const storedNotes = configService.get('releaseAnnouncementNotes')

    if (
      storedVersion === version &&
      storedId === announcementId &&
      storedContentId === announcementContentId &&
      storedBody === releaseBody &&
      storedNotes === releaseNotes
    ) {
      return
    }

    configService.set('releaseAnnouncementVersion', version)
    configService.set('releaseAnnouncementId', announcementId)
    configService.set('releaseAnnouncementContentId', announcementContentId)
    configService.set('releaseAnnouncementBody', releaseBody)
    configService.set('releaseAnnouncementNotes', releaseNotes)
    ctx.getLogService()?.info('ReleaseAnnouncement', '已同步本地版本公告', {
      version,
      hasBody: Boolean(releaseBody),
      hasNotes: Boolean(releaseNotes)
    })
  } catch (error) {
    ctx.getLogService()?.warn('ReleaseAnnouncement', '同步本地版本公告失败', { error: String(error) })
  }
}

function getThemeQueryParams(ctx: MainProcessContext): string {
  const configService = ctx.getConfigService()
  if (!configService) return ''
  const theme = configService.get('theme') || 'cloud-dancer'
  const themeMode = configService.get('themeMode') || 'system'
  return `theme=${encodeURIComponent(theme)}&mode=${encodeURIComponent(themeMode)}`
}

function getThemeQuery(ctx: MainProcessContext): Record<string, string> {
  const configService = ctx.getConfigService()
  return {
    theme: configService?.get('theme') || 'cloud-dancer',
    mode: configService?.get('themeMode') || 'system'
  }
}

function getAppIconPath(ctx: MainProcessContext): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL

  if (process.platform === 'darwin') {
    return isDev
      ? join(__dirname, '../public/icon.icns')
      : join(process.resourcesPath, 'icon.icns')
  }

  return isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')
}

function loadNativeImageIfValid(iconPath: string, purpose: string): ReturnType<typeof nativeImage.createFromPath> | null {
  if (!existsSync(iconPath)) {
    console.warn(`[Icon] ${purpose} not found: ${iconPath}`)
    return null
  }

  try {
    const image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) {
      console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`)
      return null
    }
    return image
  } catch (error) {
    console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`, error)
    return null
  }
}

function getWindowIconOptions(ctx: MainProcessContext): Pick<BrowserWindowConstructorOptions, 'icon'> {
  if (process.platform === 'darwin') return {}

  const image = loadNativeImageIfValid(getAppIconPath(ctx), 'window icon')
  return image ? { icon: image } : {}
}

function getDockIconPath(ctx: MainProcessContext): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const devPaddedPath = join(__dirname, '../public/icon-dock.png')
  const devFallbackPath = join(__dirname, '../public/logo.png')
  return isDev
    ? (existsSync(devPaddedPath) ? devPaddedPath : devFallbackPath)
    : join(process.resourcesPath, 'icon.png')
}

/**
 * 系统通知用的图标路径（PNG，比 .ico 在 Windows toast 里渲染更稳）。
 * 返回有效路径，找不到则 null（由调用方决定是否带 icon）。
 */
export function getNotificationIconPath(): string | null {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const candidates = isDev
    ? [join(__dirname, '../public/logo.png'), join(__dirname, '../public/icon-dock.png')]
    : [join(process.resourcesPath, 'icon.png')]
  return candidates.find(p => existsSync(p)) || null
}

function getTrayIconPath(ctx: MainProcessContext): string {
  if (process.platform === 'darwin') {
    const isDev = !!process.env.VITE_DEV_SERVER_URL
    const devTrayPath = join(__dirname, '../public/tray-mac.png')
    const packagedTrayPath = join(process.resourcesPath, 'tray-mac.png')

    if (isDev && existsSync(devTrayPath)) return devTrayPath
    if (!isDev && existsSync(packagedTrayPath)) return packagedTrayPath
  }

  return getAppIconPath(ctx)
}

function getTrayImage(ctx: MainProcessContext) {
  const iconPath = getTrayIconPath(ctx)
  const image = loadNativeImageIfValid(iconPath, 'tray icon')

  if (!image) return nativeImage.createEmpty()
  if (process.platform === 'darwin') {
    const trayImage = image.resize({ height: 22 })
    trayImage.setTemplateImage(true)
    return trayImage
  }
  return image
}

function setupDevToolsShortcut(win: BrowserWindow, getTargetWindow?: () => BrowserWindow | null): void {
  if (!process.env.VITE_DEV_SERVER_URL) return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      const target = getTargetWindow?.() || win
      if (target.webContents.isDevToolsOpened()) {
        target.webContents.closeDevTools()
      } else {
        target.webContents.openDevTools()
      }
      event.preventDefault()
    }
  })
}

function hideMacWindowControls(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  win.setWindowButtonVisibility(false)
  win.setWindowButtonPosition({ x: -100, y: -100 })
}

function loadWindowRoute(
  ctx: MainProcessContext,
  win: BrowserWindow,
  hash: string,
  query?: Record<string, string>,
  devQueryPrefix = true
): void {
  const themeParams = getThemeQueryParams(ctx)

  if (process.env.VITE_DEV_SERVER_URL) {
    const queryString = devQueryPrefix ? `?${themeParams}` : ''
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}${queryString}#${hash}`)
    setupDevToolsShortcut(win)
    return
  }

  win.loadFile(join(__dirname, '../dist/index.html'), {
    hash,
    query: query || getThemeQuery(ctx)
  })
}

function getImageViewerQueryParams(
  ctx: MainProcessContext,
  imagePath: string,
  liveVideoPath?: string,
  options?: ImageViewerOpenOptions
): string {
  const themeParams = getThemeQueryParams(ctx)
  const imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  const liveVideoParam = liveVideoPath ? `&liveVideoPath=${encodeURIComponent(liveVideoPath)}` : ''
  const sessionParam = options?.sessionId ? `&sessionId=${encodeURIComponent(options.sessionId)}` : ''
  const imageMd5Param = options?.imageMd5 ? `&imageMd5=${encodeURIComponent(options.imageMd5)}` : ''
  const imageDatNameParam = options?.imageDatName ? `&imageDatName=${encodeURIComponent(options.imageDatName)}` : ''
  return `${themeParams}&${imageParam}${liveVideoParam}${sessionParam}${imageMd5Param}${imageDatNameParam}`
}

export function createWindowManager(ctx: MainProcessContext): WindowManager {
  let chatWindow: BrowserWindow | null = null
  let momentsWindow: BrowserWindow | null = null
  let agreementWindow: BrowserWindow | null = null
  let purchaseWindow: BrowserWindow | null = null
  let welcomeWindow: BrowserWindow | null = null
  let chatHistoryWindow: BrowserWindow | null = null
  let personaChatWindow: BrowserWindow | null = null
  let posterStyleWindow: BrowserWindow | null = null
  let petWindow: BrowserWindow | null = null
  let replyTileWindow: BrowserWindow | null = null
  let replyTileTimer: NodeJS.Timeout | null = null
  let replyTileEventWatchDisposer: (() => void) | null = null
  let replyTileEventWatchStartedAt = 0
  let replyTileRepositionQueued = false
  let replyTileLastFallbackPollAt = 0
  let replyTileLastBounds = ''
  let replyTileFloating = true
  let replyTileEnabled = false
  // 磁贴里各会话最新条目，供新建/重载窗口后回灌
  const replyTileEntries = new Map<string, ReplyTileEntry>()
  const REPLY_TILE_WIDTH = 340
  let petBaseBounds: { x: number; y: number; width: number; height: number } | null = null
  // 桌宠基础尺寸（与 openPetWindow 一致）；显示消息气泡时临时向上/左扩窗腾出空间
  const PET_BASE_WIDTH = 150
  const PET_BASE_HEIGHT = 170
  const PET_BUBBLE_WIDTH = 300
  const PET_BUBBLE_HEIGHT = 320
  let petBubbleExpanded = false
  // 程序化 setBounds 会触发 'move'，用时间窗抑制，避免桌宠误判成拖动而播跑动画
  let petSuppressMoveUntil = 0
  // 手动拖拽起点：pet:dragStart 时的窗口 bounds，dragMove 的位移以此为基准。
  // 必须连宽高一起记：Windows 缩放屏上 setPosition 每次调用都做 DIP↔物理像素往返换算，
  // 尺寸的舍入误差会逐次累积，拖一段窗口就悄悄变大（右下角锚定的宠物随之向右下漂移）
  let petDragOrigin: { x: number; y: number; width: number; height: number } | null = null
  // 渲染端最近一次请求的气泡态 + 拖拽冻结标志：拖拽中 setBounds 会和 dragMove 的
  // setPosition 打架，把透明窗口留在放大态挡住桌面点击，改为松手时统一应用
  let petBubbleDesired = false
  let petDragging = false
  let petDraggingSince = 0
  let lastPetContextMenuAt = 0

  const closePetWindowInternal = (): void => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.close()
    }
    petWindow = null
    petBaseBounds = null
    petBubbleExpanded = false
    petBubbleDesired = false
    petDragging = false
    petDragOrigin = null
  }

  // 应用气泡扩窗/还原（desired → 实际 bounds）。除状态标志外还校验实际窗口尺寸：
  // 任何竞态把透明窗口留在放大态（挡住桌面点击且不可见）时，下一次应用都会自愈修复
  const applyPetBubbleBounds = (): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    const expanded = petBubbleDesired
    const b = petWindow.getBounds()
    const sizeIsExpanded = b.width !== PET_BASE_WIDTH || b.height !== PET_BASE_HEIGHT
    if (expanded === petBubbleExpanded && sizeIsExpanded === expanded) return
    petBubbleExpanded = expanded

    const { workArea } = screen.getDisplayMatching(b)
    // 宠物格基准：优先用扩窗时记下的；拖拽后已作废时按当前窗口右下角推导（宠物停在松手处）
    const base = petBaseBounds ?? {
      x: b.x + b.width - PET_BASE_WIDTH,
      y: b.y + b.height - PET_BASE_HEIGHT,
      width: PET_BASE_WIDTH,
      height: PET_BASE_HEIGHT,
    }
    if (expanded) petBaseBounds = base
    setPetWindowMaterial(expanded)
    const baseRight = base.x + PET_BASE_WIDTH
    const baseBottom = base.y + PET_BASE_HEIGHT
    const width = expanded ? PET_BUBBLE_WIDTH : PET_BASE_WIDTH
    const height = expanded ? PET_BUBBLE_HEIGHT : PET_BASE_HEIGHT
    const minX = workArea.x
    const minY = workArea.y
    const maxX = Math.max(minX, workArea.x + workArea.width - width)
    const maxY = Math.max(minY, workArea.y + workArea.height - height)
    const x = Math.min(Math.max(expanded ? baseRight - width : base.x, minX), maxX)
    const y = Math.min(Math.max(expanded ? baseBottom - height : base.y, minY), maxY)

    petSuppressMoveUntil = Date.now() + 400
    petWindow.setBounds({ x, y, width, height })
    petWindow.webContents.send('pet:bubbleFrame', {
      expanded,
      baseLeft: base.x - x,
      baseTop: base.y - y,
      baseWidth: PET_BASE_WIDTH,
      baseHeight: PET_BASE_HEIGHT,
    })
    if (!expanded) {
      petBaseBounds = null
    }
  }

  const closeReplyTileInternal = (): void => {
    if (replyTileTimer) { clearInterval(replyTileTimer); replyTileTimer = null }
    if (replyTileEventWatchDisposer) { replyTileEventWatchDisposer(); replyTileEventWatchDisposer = null }
    replyTileEventWatchStartedAt = 0
    if (replyTileWindow && !replyTileWindow.isDestroyed()) replyTileWindow.close()
    replyTileWindow = null
    replyTileRepositionQueued = false
    replyTileLastFallbackPollAt = 0
    replyTileLastBounds = ''
    replyTileFloating = true
  }

  const setReplyTileFloating = (floating: boolean): void => {
    if (!replyTileWindow || replyTileWindow.isDestroyed() || replyTileFloating === floating) return
    replyTileFloating = floating
    if (floating) replyTileWindow.setAlwaysOnTop(true, 'screen-saver')
    else replyTileWindow.setAlwaysOnTop(false)
  }

  const rectsOverlap = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): boolean => {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  // Reply tile follows the WeChat main window edge.
  // Do not hide it just because another app becomes foreground; hide only when WeChat is missing/minimized.
  const repositionReplyTile = (): void => {
    if (!replyTileWindow || replyTileWindow.isDestroyed()) return
    const state = probeWeChatWindow()
    const show = state.found && !state.minimized && state.bounds
    if (!show) {
      if (replyTileWindow.isVisible()) replyTileWindow.hide()
      return
    }
    const tileFocused = replyTileWindow.isFocused()
    const shouldFloat = state.foregroundActive || tileFocused
    setReplyTileFloating(shouldFloat)
    const wx = state.bounds!
    const wa = screen.getDisplayMatching(wx).workArea
    let x = wx.x + wx.width
    if (x + REPLY_TILE_WIDTH > wa.x + wa.width) x = wx.x - REPLY_TILE_WIDTH // 翻到左侧
    x = Math.max(wa.x, x)
    const y = Math.max(wa.y, wx.y)
    const height = Math.min(wx.height, wa.y + wa.height - y)
    const bounds = { x: Math.round(x), y: Math.round(y), width: REPLY_TILE_WIDTH, height: Math.round(height) }
    const key = `${bounds.x},${bounds.y},${bounds.height}`
    if (key !== replyTileLastBounds) {
      replyTileWindow.setBounds(bounds)
      replyTileLastBounds = key
    }
    if (!replyTileWindow.isVisible()) replyTileWindow.showInactive()
    if (!shouldFloat && state.otherForegroundActive && state.foregroundBounds && rectsOverlap(bounds, state.foregroundBounds)) {
      placeNativeWindowBehindForeground(replyTileWindow.getNativeWindowHandle())
    }
  }

  const scheduleReplyTileReposition = (): void => {
    if (replyTileRepositionQueued) return
    replyTileRepositionQueued = true
    setImmediate(() => {
      replyTileRepositionQueued = false
      repositionReplyTile()
    })
  }

  const startReplyTileEventWatch = (): void => {
    if (replyTileEventWatchDisposer) return
    replyTileEventWatchDisposer = watchWeChatWindowEvents(scheduleReplyTileReposition)
    replyTileEventWatchStartedAt = replyTileEventWatchDisposer ? Date.now() : 0
  }

  const refreshReplyTileEventWatch = (): void => {
    if (replyTileEventWatchDisposer && Date.now() - replyTileEventWatchStartedAt < 10000) return
    if (replyTileEventWatchDisposer) { replyTileEventWatchDisposer(); replyTileEventWatchDisposer = null }
    replyTileEventWatchStartedAt = 0
    startReplyTileEventWatch()
  }

  const openReplyTileWindow = (): void => {
    if (replyTileWindow && !replyTileWindow.isDestroyed()) return
    replyTileWindow = new BrowserWindow({
      width: REPLY_TILE_WIDTH,
      height: 400,
      frame: false,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: -100, y: -100 },
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        devTools: ctx.allowDevTools,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false
      }
    })
    hideMacWindowControls(replyTileWindow)
    replyTileWindow.once('ready-to-show', () => {
      if (replyTileWindow && !replyTileWindow.isDestroyed()) hideMacWindowControls(replyTileWindow)
    })
    replyTileWindow.on('show', () => {
      if (replyTileWindow && !replyTileWindow.isDestroyed()) hideMacWindowControls(replyTileWindow)
    })
    replyTileWindow.on('focus', () => {
      if (replyTileWindow && !replyTileWindow.isDestroyed()) hideMacWindowControls(replyTileWindow)
    })
    replyTileWindow.setAlwaysOnTop(true, 'screen-saver')
    replyTileWindow.on('closed', () => {
      if (replyTileTimer) { clearInterval(replyTileTimer); replyTileTimer = null }
      if (replyTileEventWatchDisposer) { replyTileEventWatchDisposer(); replyTileEventWatchDisposer = null }
      replyTileEventWatchStartedAt = 0
      replyTileWindow = null
      replyTileRepositionQueued = false
      replyTileLastFallbackPollAt = 0
      replyTileLastBounds = ''
      replyTileFloating = true
    })
    // 窗口加载完成后回灌现有条目（新建/重载都能拿到当前全量）
    replyTileWindow.webContents.on('did-finish-load', () => {
      if (!replyTileWindow || replyTileWindow.isDestroyed()) return
      for (const entry of replyTileEntries.values()) {
        replyTileWindow.webContents.send('reply-tile:update', entry)
      }
    })
    loadWindowRoute(ctx, replyTileWindow, '/reply-tile-window')
    startReplyTileEventWatch()
    replyTileTimer = setInterval(() => {
      const now = Date.now()
      const fallbackMs = replyTileEventWatchDisposer ? 1000 : (process.platform === 'darwin' ? 600 : 120)
      if (now - replyTileLastFallbackPollAt >= fallbackMs) {
        replyTileLastFallbackPollAt = now
        repositionReplyTile()
      }
      refreshReplyTileEventWatch()
    }, 120)
    replyTileTimer.unref?.()
    repositionReplyTile()
  }

  const setPetWindowMaterial = (_expanded: boolean): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    try {
      // BrowserWindow 本身必须保持透明，气泡观感由 .pet-notice 自身的 CSS 负责。
      petWindow.setBackgroundColor('#00000000')
      if (process.platform === 'darwin') {
        petWindow.setVibrancy(null)
      }
    } catch {
      // 透明窗口本身仍可用。
    }
  }

  const disablePetDesktopWindow = (): void => {
    closePetWindowInternal()
    ctx.getConfigService()?.set('petDesktopEnabled', false)
    ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: false })
  }

  const showPetContextMenu = (): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastPetContextMenuAt < 150) return
    lastPetContextMenuAt = now
    petWindow.webContents.send('pet:contextMenuOpened')
    const menu = Menu.buildFromTemplate([
      {
        label: '退出宠物',
        click: disablePetDesktopWindow
      }
    ])
    menu.popup({ window: petWindow })
  }

  const createTray = (): Tray | null => {
    const existingTray = ctx.getTray()
    if (existingTray) return existingTray

    const focusMainWindow = (route?: string): BrowserWindow => manager.focusMainWindow(route)

    const toggleMainWindow = () => {
      const mainWindow = ctx.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide()
        return
      }
      focusMainWindow()
    }

    const togglePetWindow = () => {
      const configService = ctx.getConfigService()
      const enabled = Boolean(configService?.get('petDesktopEnabled')) && manager.isPetWindowOpen()
      if (enabled) {
        manager.closePetWindow()
        configService?.set('petDesktopEnabled', false)
        ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: false })
        return
      }

      configService?.set('petDesktopEnabled', true)
      ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: true })
      const currentPet = configService?.get('petCurrent')
      if (currentPet) manager.openPetWindow()
    }

    const showTrayMenu = async () => {
      const tray = ctx.getTray()
      if (!tray) return
      const configService = ctx.getConfigService()
      const petEnabled = Boolean(configService?.get('petDesktopEnabled')) && manager.isPetWindowOpen()
      const mainWindow = ctx.getMainWindow()
      const mainVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized())

      const contextMenu = Menu.buildFromTemplate([
        {
          label: mainVisible ? '隐藏主窗口' : '显示主窗口',
          click: toggleMainWindow,
        },
        { type: 'separator' },
        { label: 'AI 助手', click: () => focusMainWindow('/agent') },
        { label: '导出', click: () => focusMainWindow('/export') },
        {
          label: '桌宠',
          type: 'checkbox',
          checked: petEnabled,
          click: togglePetWindow,
        },
        { label: '设置', click: () => focusMainWindow('/settings') },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            ctx.appWithQuitFlag.isQuitting = true
            app.quit()
          },
        },
      ])
      tray.popUpContextMenu(contextMenu)
    }

    let tray: Tray
    try {
      tray = new Tray(getTrayImage(ctx))
    } catch (error) {
      console.warn('[Icon] tray creation failed:', error)
      return null
    }

    ctx.setTray(tray)

    if (process.platform === 'darwin') {
      tray.setIgnoreDoubleClickEvents(true)
    }

    tray.setToolTip('密语 CipherTalk')
    tray.on('click', () => { void showTrayMenu() })
    tray.on('right-click', () => { void showTrayMenu() })

    return tray
  }

  const manager: WindowManager = {
    createMainWindow() {
      const configService = ctx.getConfigService() ?? new ConfigService()
      const initialThemeMode = configService.get('themeMode')
      const isInitialDark = initialThemeMode === 'dark' || (initialThemeMode === 'system' && nativeTheme.shouldUseDarkColors)
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isInitialDark ? '#ffffff' : '#1a1a1a',
          height: 40
        },
        backgroundColor: isInitialDark ? '#1A1A1A' : '#FFFFFF',
        show: false
      })

      attachWindowStartupDiagnostics(win, 'main')
      ctx.setMainWindow(win)
      markStartupMilestone('window:main-services-init-start')
      ctx.setConfigService(configService)
      ctx.setDbService(new DatabaseService())

      const logService = new LogService(configService)
      ctx.setLogService(logService)
      syncPackagedReleaseAnnouncement(ctx)
      mcpProxyService.setLogger(logService)
      autoUpdater.logger = {
        info(message: string) {
          logService.info('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'info')
        },
        warn(message: string) {
          logService.warn('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'warn')
        },
        error(message: string) {
          logService.error('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'error')
        },
        debug(message: string) {
          logService.debug('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'info')
        }
      }
      logService.info('App', '应用启动', { version: app.getVersion() })
      markStartupMilestone('window:main-services-init-done')

      const cachePath = configService.get('cachePath')
      if (cachePath) {
        voiceTranscribeServiceWhisper.setGPUComponentsDir(cachePath)
      }

      win.once('ready-to-show', () => {
        win.show()
      })

      win.on('close', (event) => {
        const updateInfo = appUpdateService.getCachedUpdateInfo()
        if (updateInfo?.forceUpdate || ctx.getIsInstallingUpdate()) {
          ctx.appWithQuitFlag.isQuitting = true
          return
        }

        if (ctx.appWithQuitFlag.isQuitting) return

        const closeToTray = ctx.getConfigService()?.get('closeToTray')
        if (closeToTray !== false) {
          event.preventDefault()
          win.hide()
          if (!ctx.getTray()) createTray()
          return
        }

        event.preventDefault()
        ctx.appWithQuitFlag.isQuitting = true
        app.quit()
      })

      // 启动屏阶段已成功连库：直接落地首页，避免首帧闪现新增账号引导页
      const initialHash = ctx.getStartupDbConnected() ? '/home' : ''
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}${initialHash ? `#${initialHash}` : ''}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          query: getThemeQuery(ctx),
          ...(initialHash ? { hash: initialHash } : {})
        })
      }

      return win
    },

    createSplashWindow() {
      const splash = new BrowserWindow({
        width: 480,
        height: 270,
        ...getWindowIconOptions(ctx),
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        backgroundColor: '#00000000'
      })

      hideMacWindowControls(splash)
      attachWindowStartupDiagnostics(splash, 'splash')
      ctx.setSplashWindow(splash)
      splash.center()

      const showSplash = (via: string) => {
        if (splash.isDestroyed() || splash.isVisible()) return
        hideMacWindowControls(splash)
        splash.show()
        markStartupMilestone('splash:show-called', {
          via,
          visible: splash.isVisible(),
          bounds: splash.getBounds()
        })
      }

      splash.once('ready-to-show', () => {
        markStartupMilestone('splash:ready-to-show')
        showSplash('ready-to-show')
      })

      // 兜底：Windows 透明窗口偶发不触发 ready-to-show，导致 show() 永不调用、窗口不可见。
      splash.webContents.once('did-finish-load', () => showSplash('did-finish-load'))
      setTimeout(() => showSplash('timeout-2s'), 2000)

      const splashUrl = process.env.VITE_DEV_SERVER_URL
        ? `${process.env.VITE_DEV_SERVER_URL}#/splash`
        : `file://${join(__dirname, '../dist/index.html')}#/splash`
      markStartupMilestone('splash:load-start', { url: splashUrl })

      if (process.env.VITE_DEV_SERVER_URL) {
        splash.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/splash`).catch((e) => {
          logStartupError('splash:load-failed', e, { url: splashUrl })
        })
      } else {
        splash.loadFile(join(__dirname, '../dist/index.html'), { hash: '/splash' }).catch((e) => {
          logStartupError('splash:load-failed', e, { url: splashUrl })
        })
      }

      return splash
    },

    async closeSplashWindow() {
      const splashWindow = ctx.getSplashWindow()
      if (!splashWindow || splashWindow.isDestroyed()) {
        ctx.setSplashWindow(null)
        return
      }

      splashWindow.webContents.send('splash:fadeOut')
      await new Promise(resolve => setTimeout(resolve, 350))

      const currentSplashWindow = ctx.getSplashWindow()
      if (currentSplashWindow && !currentSplashWindow.isDestroyed()) {
        currentSplashWindow.close()
        ctx.setSplashWindow(null)
      }
    },

    createTray,

    destroyTray() {
      const tray = ctx.getTray()
      if (tray) {
        tray.destroy()
        ctx.setTray(null)
      }
    },

    focusMainWindow(route?: string) {
      const targetRoute = route && MAIN_WINDOW_ROUTES.has(route) ? route : undefined
      let win = ctx.getMainWindow()
      if (!win || win.isDestroyed()) {
        win = manager.createMainWindow()
      }

      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()

      if (targetRoute) {
        const sendNavigate = () => {
          if (!win || win.isDestroyed()) return
          win.webContents.send('window:navigate', targetRoute)
        }
        if (win.webContents.isLoading()) {
          win.webContents.once('did-finish-load', sendNavigate)
        } else {
          sendNavigate()
        }
      }

      return win
    },

    setDockIcon() {
      if (process.platform !== 'darwin') return

      const dockIconPath = getDockIconPath(ctx)
      if (!existsSync(dockIconPath)) return

      const dockIcon = nativeImage.createFromPath(dockIconPath)
      if (!dockIcon.isEmpty()) {
        app.dock?.setIcon(dockIcon)
      }
    },

    openChatWindow() {
      if (chatWindow && !chatWindow.isDestroyed()) {
        if (chatWindow.isMinimized()) chatWindow.restore()
        chatWindow.focus()
        return chatWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      chatWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#666666',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
      })

      chatWindow.once('ready-to-show', () => chatWindow?.show())
      loadWindowRoute(ctx, chatWindow, '/chat-window')
      chatWindow.on('closed', () => {
        chatWindow = null
      })
      return chatWindow
    },

    openMomentsWindow(filterUsername?: string) {
      if (momentsWindow && !momentsWindow.isDestroyed()) {
        if (momentsWindow.isMinimized()) momentsWindow.restore()
        momentsWindow.focus()
        if (filterUsername) {
          momentsWindow.webContents.send('moments:filterUser', filterUsername)
        }
        return momentsWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      momentsWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#666666',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
      })

      momentsWindow.once('ready-to-show', () => momentsWindow?.show())

      const filterParam = filterUsername ? `&filterUsername=${encodeURIComponent(filterUsername)}` : ''
      if (process.env.VITE_DEV_SERVER_URL) {
        momentsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}${filterParam}#/moments-window`)
        setupDevToolsShortcut(momentsWindow)
      } else {
        const query = getThemeQuery(ctx)
        if (filterUsername) query.filterUsername = filterUsername
        momentsWindow.loadFile(join(__dirname, '../dist/index.html'), {
          hash: '/moments-window',
          query
        })
      }

      momentsWindow.on('closed', () => {
        momentsWindow = null
      })
      return momentsWindow
    },

    openChatHistoryWindow(sessionId: string, messageId: number) {
      if (chatHistoryWindow && !chatHistoryWindow.isDestroyed()) {
        if (chatHistoryWindow.isMinimized()) chatHistoryWindow.restore()
        chatHistoryWindow.focus()

        if (process.env.VITE_DEV_SERVER_URL) {
          chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#/chat-history/${sessionId}/${messageId}`)
        } else {
          chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
            hash: `/chat-history/${sessionId}/${messageId}`,
            query: getThemeQuery(ctx)
          })
        }
        return chatHistoryWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      chatHistoryWindow = new BrowserWindow({
        width: 600,
        height: 800,
        minWidth: 400,
        minHeight: 500,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#ffffff' : '#1a1a1a',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
        autoHideMenuBar: true
      })

      chatHistoryWindow.once('ready-to-show', () => chatHistoryWindow?.show())

      if (process.env.VITE_DEV_SERVER_URL) {
        chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#/chat-history/${sessionId}/${messageId}`)
        setupDevToolsShortcut(chatHistoryWindow, () => chatHistoryWindow)
      } else {
        chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/chat-history/${sessionId}/${messageId}`,
          query: getThemeQuery(ctx)
        })
      }

      chatHistoryWindow.on('closed', () => {
        chatHistoryWindow = null
      })
      return chatHistoryWindow
    },

    // 克隆好友（数字分身）独立聊天窗口：手机聊天软件比例的窄窗
    openPersonaChatWindow(sessionId: string) {
      const hash = `/persona-chat/${encodeURIComponent(sessionId)}`
      if (personaChatWindow && !personaChatWindow.isDestroyed()) {
        if (personaChatWindow.isMinimized()) personaChatWindow.restore()
        personaChatWindow.focus()
        if (process.env.VITE_DEV_SERVER_URL) {
          personaChatWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#${hash}`)
        } else {
          personaChatWindow.loadFile(join(__dirname, '../dist/index.html'), {
            hash,
            query: getThemeQuery(ctx)
          })
        }
        return personaChatWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      personaChatWindow = new BrowserWindow({
        width: 420,
        height: 760,
        minWidth: 360,
        minHeight: 560,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#ffffff' : '#1a1a1a',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
        autoHideMenuBar: true
      })

      personaChatWindow.once('ready-to-show', () => personaChatWindow?.show())

      if (process.env.VITE_DEV_SERVER_URL) {
        personaChatWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#${hash}`)
        setupDevToolsShortcut(personaChatWindow, () => personaChatWindow)
      } else {
        personaChatWindow.loadFile(join(__dirname, '../dist/index.html'), {
          hash,
          query: getThemeQuery(ctx)
        })
      }

      personaChatWindow.on('closed', () => {
        personaChatWindow = null
      })
      return personaChatWindow
    },

    openPosterStyleWindow() {
      if (posterStyleWindow && !posterStyleWindow.isDestroyed()) {
        if (posterStyleWindow.isMinimized()) posterStyleWindow.restore()
        posterStyleWindow.show()
        posterStyleWindow.focus()
        return posterStyleWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      posterStyleWindow = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 860,
        minHeight: 560,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#ffffff' : '#1a1a1a',
          height: 34
        },
        title: '海报编辑器',
        show: false,
        backgroundColor: '#15161a',
        autoHideMenuBar: true
      })

      posterStyleWindow.once('ready-to-show', () => posterStyleWindow?.show())
      loadWindowRoute(ctx, posterStyleWindow, '/poster-style-window')
      posterStyleWindow.on('closed', () => {
        posterStyleWindow = null
      })
      return posterStyleWindow
    },

    openAgreementWindow() {
      if (agreementWindow && !agreementWindow.isDestroyed()) {
        agreementWindow.focus()
        return agreementWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      agreementWindow = new BrowserWindow({
        width: 800,
        height: 700,
        minWidth: 600,
        minHeight: 500,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#FFFFFF' : '#333333',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
      })

      agreementWindow.once('ready-to-show', () => agreementWindow?.show())
      loadWindowRoute(ctx, agreementWindow, '/agreement-window')
      agreementWindow.on('closed', () => {
        agreementWindow = null
      })
      return agreementWindow
    },

    openWelcomeWindow(mode: 'default' | 'add-account' = 'default') {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.focus()
        return welcomeWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      welcomeWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 900,
        minHeight: 640,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#FFFFFF' : '#333333',
          height: 40
        },
        transparent: false,
        backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF',
        hasShadow: true,
        autoHideMenuBar: true,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        show: false
      })

      attachWindowStartupDiagnostics(welcomeWindow, 'welcome')
      welcomeWindow.once('ready-to-show', () => welcomeWindow?.show())

      const welcomeHash = mode === 'add-account' ? '/welcome-window?mode=add-account' : '/welcome-window'
      if (process.env.VITE_DEV_SERVER_URL) {
        welcomeWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${welcomeHash}`)
      } else {
        welcomeWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: welcomeHash })
      }

      welcomeWindow.on('closed', () => {
        welcomeWindow = null
      })
      return welcomeWindow
    },

    openPurchaseWindow() {
      if (purchaseWindow && !purchaseWindow.isDestroyed()) {
        purchaseWindow.focus()
        return purchaseWindow
      }

      purchaseWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        title: '获取激活码 - 密语',
        show: false,
        backgroundColor: '#FFFFFF',
        autoHideMenuBar: true
      })

      purchaseWindow.once('ready-to-show', () => purchaseWindow?.show())
      purchaseWindow.loadURL('https://pay.ldxp.cn/shop/aiqiji')
      purchaseWindow.on('closed', () => {
        purchaseWindow = null
      })
      return purchaseWindow
    },

    openImageViewerWindow(imagePath: string, liveVideoPath?: string, options?: ImageViewerOpenOptions) {
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 560,
        minHeight: 300,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#000000',
        autoHideMenuBar: true
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = getImageViewerQueryParams(ctx, imagePath, liveVideoPath, options)
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/image-viewer-window?${queryParams}`
        })
      }

      return win
    },

    openVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
      const { screen } = require('electron')
      const primaryDisplay = screen.getPrimaryDisplay()
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

      let winWidth = 854
      let winHeight = 520
      const titleBarHeight = 40

      if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
        const aspectRatio = videoWidth / videoHeight
        const maxWidth = Math.floor(screenWidth * 0.85)
        const maxHeight = Math.floor(screenHeight * 0.85)

        if (aspectRatio >= 1) {
          winWidth = Math.min(videoWidth, maxWidth)
          winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
          if (winHeight > maxHeight) {
            winHeight = maxHeight
            winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
          }
        } else {
          const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
          winHeight = videoDisplayHeight + titleBarHeight
          winWidth = Math.floor(videoDisplayHeight * aspectRatio)
          if (winWidth < 300) {
            winWidth = 300
            winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
          }
        }

        winWidth = Math.max(winWidth, 360)
        winHeight = Math.max(winHeight, 280)
      }

      const win = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        minWidth: 360,
        minHeight: 280,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#000000',
        autoHideMenuBar: true
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = `${getThemeQueryParams(ctx)}&videoPath=${encodeURIComponent(videoPath)}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/video-player-window?${queryParams}`
        })
      }

      return win
    },

    openBrowserWindow(url: string, title?: string) {
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          webviewTag: true
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#ffffff',
        title: title || '浏览器'
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = `${getThemeQueryParams(ctx)}&url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ''}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/browser-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/browser-window?${queryParams}`
        })
      }

      return win
    },

    openSkillPreviewWindow(skillName: string) {
      const safeSkillName = String(skillName || '').trim()
      const win = new BrowserWindow({
        width: 1180,
        height: 780,
        minWidth: 760,
        minHeight: 520,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 36
        },
        show: false,
        backgroundColor: '#ffffff',
        title: `Skill Preview - ${safeSkillName}`
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = `${getThemeQueryParams(ctx)}&skill=${encodeURIComponent(safeSkillName)}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/skill-preview-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/skill-preview-window?${queryParams}`
        })
      }

      return win
    },

    openPluginWindow(pluginId: string, viewId: string, opts?: { width?: number; height?: number; title?: string }) {
      const win = new BrowserWindow({
        width: Math.min(Math.max(opts?.width ?? 960, 360), 1920),
        height: Math.min(Math.max(opts?.height ?? 680, 240), 1200),
        minWidth: 360,
        minHeight: 240,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 36
        },
        show: false,
        backgroundColor: '#ffffff',
        title: opts?.title || '插件'
      })

      win.once('ready-to-show', () => win.show())
      const hash = `/plugin-window/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}?${getThemeQueryParams(ctx)}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${hash}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), { hash })
      }

      return win
    },

    completeWelcome() {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.close()
      }

      const mainWindow = ctx.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        manager.createMainWindow()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }

      return true
    },

    isChatWindowOpen() {
      return chatWindow !== null && !chatWindow.isDestroyed()
    },

    closeChatWindow() {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.close()
        chatWindow = null
      }
      return true
    },

    openPetWindow() {
      if (petWindow && !petWindow.isDestroyed()) {
        hideMacWindowControls(petWindow)
        petWindow.show()
        return petWindow
      }

      // 默认落在主屏右下角（任务栏上方），透明无边框；宠物区域走手动拖拽（pet:dragStart/dragMove），空白边缘仍是 app-region 拖动
      const { workArea } = screen.getPrimaryDisplay()
      const width = 150
      const height = 170
      petWindow = new BrowserWindow({
        width,
        height,
        x: workArea.x + workArea.width - width - 24,
        y: workArea.y + workArea.height - height - 16,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        }
      })

      hideMacWindowControls(petWindow)
      petWindow.setAlwaysOnTop(true, 'screen-saver')
      petWindow.once('ready-to-show', () => {
        if (!petWindow || petWindow.isDestroyed()) return
        hideMacWindowControls(petWindow)
        petWindow.show()
      })
      loadWindowRoute(ctx, petWindow, '/pet-window')

      petWindow.on('system-context-menu', (event) => {
        event.preventDefault()
        showPetContextMenu()
      })

      petWindow.webContents.on('context-menu', (event) => {
        event.preventDefault()
        showPetContextMenu()
      })

      // 拖动时把窗口横坐标转发给渲染端，宠物按移动方向播跑/跳动画
      petWindow.on('move', () => {
        if (!petWindow || petWindow.isDestroyed()) return
        if (Date.now() < petSuppressMoveUntil) return // 程序化扩窗，非用户拖动
        petWindow.webContents.send('pet:windowMove', petWindow.getPosition()[0])
      })

      petWindow.on('closed', () => {
        petWindow = null
      })
      return petWindow
    },

    closePetWindow() {
      closePetWindowInternal()
    },

    isPetWindowOpen() {
      return petWindow !== null && !petWindow.isDestroyed()
    },

    showPetContextMenu() {
      showPetContextMenu()
    },

    // 手动拖拽（代替 app-region: drag——它会吞掉宠物区域的左键 DOM 事件，点击对话打不开）：
    // 按下时记录窗口原点，move 传按下点起算的累计位移，松手时统一应用被冻结的气泡态
    petDragStart() {
      if (!petWindow || petWindow.isDestroyed()) return
      const b = petWindow.getBounds()
      petDragOrigin = { x: b.x, y: b.y, width: b.width, height: b.height }
      petDragging = true
      petDraggingSince = Date.now()
    },

    petDragMove(dx: number, dy: number) {
      if (!petWindow || petWindow.isDestroyed() || !petDragOrigin) return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      // setBounds 显式带固定宽高（而不是 setPosition 只传位置）：同样的尺寸输入每次同样舍入，
      // 缩放屏上的 DIP 换算误差不会逐次累积把窗口越拖越大
      petWindow.setBounds({
        x: Math.round(petDragOrigin.x + dx),
        y: Math.round(petDragOrigin.y + dy),
        width: petDragOrigin.width,
        height: petDragOrigin.height,
      })
      // 拖走之后扩窗时记的基准位置作废；还原时按窗口右下角重推，宠物停在松手处不回跳
      petBaseBounds = null
    },

    petDragEnd() {
      petDragging = false
      petDragOrigin = null
      // 拖拽期间被冻结的扩窗/还原请求在这里统一落地；顺带自愈修复卡在放大态的窗口
      applyPetBubbleBounds()
    },

    // 显示消息气泡时向右下角锚点扩窗腾出气泡空间，气泡消失后还原。仅尺寸变化，桌宠仍停在原处。
    setPetBubbleExpanded(expanded: boolean) {
      petBubbleDesired = expanded
      if (petDragging) {
        // 拖拽中冻结 setBounds，避免和 dragMove 的 setPosition 竞态把窗口留在放大态；
        // 超时兜底：dragEnd 事件丢失（渲染端异常）时不至于永久冻结
        if (Date.now() - petDraggingSince < 15000) return
        petDragging = false
      }
      applyPetBubbleBounds()
    },

    setReplyTileEnabled(enabled: boolean) {
      if (!supportsReplyTileWindow()) return
      replyTileEnabled = enabled
      if (enabled) {
        openReplyTileWindow()
      } else {
        replyTileEntries.clear()
        closeReplyTileInternal()
      }
    },

    isReplyTileEnabled() {
      return replyTileEnabled
    },

    updateReplyTileEntry(entry: ReplyTileEntry) {
      if (!replyTileEnabled) return
      if (entry.state === 'gone') replyTileEntries.delete(entry.sessionId)
      else replyTileEntries.set(entry.sessionId, entry)
      if (replyTileWindow && !replyTileWindow.isDestroyed() && !replyTileWindow.webContents.isLoading()) {
        replyTileWindow.webContents.send('reply-tile:update', entry)
      }
      // 窗口还在加载时不单独发：did-finish-load 会回灌全量
    }
  }

  return manager
}
