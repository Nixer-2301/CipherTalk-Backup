import type { BrowserWindow, Tray } from 'electron'
import type { DatabaseService } from '../services/database'
import type { ConfigService } from '../services/config'
import type { LogService } from '../services/logService'

export type AppWithQuitFlag = Electron.App & {
  isQuitting?: boolean
}

export type ImageViewerListItem = {
  imagePath: string
  liveVideoPath?: string
}

export type ImageViewerOpenOptions = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

/** 磁贴窗口里单个会话的条目。pending=参与但还没建议；gone=已退出参与，从磁贴移除。 */
export type ReplyTileBatch = {
  id: string
  targetKey: string
  quote: string
  suggestions: string[]
}

export type ReplyTileEntry = {
  sessionId: string
  sessionName: string
  avatarUrl?: string
  state: 'pending' | 'loading' | 'error' | 'ready' | 'gone'
  suggestions?: string[]
  batches?: ReplyTileBatch[]
  pendingContinue?: boolean
  error?: string
}

export interface WindowManager {
  createMainWindow(): BrowserWindow
  createSplashWindow(): BrowserWindow
  closeSplashWindow(): Promise<void>
  createTray(): Tray | null
  destroyTray(): void
  focusMainWindow(route?: string): BrowserWindow
  setDockIcon(): void
  openChatWindow(): BrowserWindow
  openMomentsWindow(filterUsername?: string): BrowserWindow
  openAgreementWindow(): BrowserWindow
  openWelcomeWindow(mode?: 'default' | 'add-account'): BrowserWindow
  openPurchaseWindow(): BrowserWindow
  openImageViewerWindow(
    imagePath: string,
    liveVideoPath?: string,
    options?: ImageViewerOpenOptions
  ): BrowserWindow
  openVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number): BrowserWindow
  openBrowserWindow(url: string, title?: string): BrowserWindow
  openSkillPreviewWindow(skillName: string): BrowserWindow
  openChatHistoryWindow(sessionId: string, messageId: number): BrowserWindow
  openPersonaChatWindow(sessionId: string): BrowserWindow
  openPosterStyleWindow(): BrowserWindow
  completeWelcome(): boolean
  isChatWindowOpen(): boolean
  closeChatWindow(): boolean
  openPluginWindow(pluginId: string, viewId: string, opts?: { width?: number; height?: number; title?: string }): BrowserWindow
  openPetWindow(): BrowserWindow
  closePetWindow(): void
  isPetWindowOpen(): boolean
  showPetContextMenu(): void
  petDragStart(): void
  petDragMove(dx: number, dy: number): void
  petDragEnd(): void
  setPetBubbleExpanded(expanded: boolean): void
  /** 全局磁贴总开关：开=常驻贴微信旁 + 启动后台生成；关=关闭磁贴 + 停后台 */
  setReplyTileEnabled(enabled: boolean): void
  isReplyTileEnabled(): boolean
  /** 更新/移除磁贴里某会话的条目（来自渲染端当前会话或主进程后台生成） */
  updateReplyTileEntry(entry: ReplyTileEntry): void
}

export interface MainProcessContext {
  appWithQuitFlag: AppWithQuitFlag
  allowDevTools: boolean
  getDbService(): DatabaseService | null
  setDbService(service: DatabaseService | null): void
  getConfigService(): ConfigService | null
  setConfigService(service: ConfigService | null): void
  getLogService(): LogService | null
  setLogService(service: LogService | null): void
  getMainWindow(): BrowserWindow | null
  setMainWindow(window: BrowserWindow | null): void
  getSplashWindow(): BrowserWindow | null
  setSplashWindow(window: BrowserWindow | null): void
  getTray(): Tray | null
  setTray(tray: Tray | null): void
  getSplashReady(): boolean
  setSplashReady(ready: boolean): void
  getStartupDbConnected(): boolean
  setStartupDbConnected(connected: boolean): void
  getIsInstallingUpdate(): boolean
  setIsInstallingUpdate(installing: boolean): void
  broadcastToWindows(channel: string, ...args: any[]): void
  getWindowManager(): WindowManager
  setWindowManager(manager: WindowManager): void
}
