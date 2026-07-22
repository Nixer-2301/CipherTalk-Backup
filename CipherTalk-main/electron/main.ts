import { app, BrowserWindow, protocol, type Tray } from 'electron'
import { randomBytes } from 'crypto'
import { autoUpdater } from 'electron-updater'
import {
  getStartupDiagnosticsLogPath,
  installElectronStartupDiagnostics,
  logStartupError,
  markStartupMilestone,
  warnStartupMilestone
} from './main/startupDiagnostics'
import { DatabaseService } from './services/database'
import { ConfigService } from './services/config'
import { LogService } from './services/logService'
import type { MainProcessContext, WindowManager } from './main/context'
import { createWindowManager } from './main/windows/windowManager'
import { registerModularIpcHandlers } from './main/ipc/register'
import { registerLocalProtocols, registerPluginProtocol } from './main/protocols'
import { registerPluginNavigationGuard } from './main/pluginNavigationGuard'
import { pluginManagerService } from './services/pluginManagerService'
import { initAiTelemetry } from './services/ai/telemetry'
import {
  checkAndConnectOnStartup,
  checkForUpdatesOnStartup,
  startBackgroundSync,
  startLocalIntegrationServices,
  startNightlyMemoryConsolidation,
  stopLocalIntegrationServices,
  warmupAgentProcess
} from './main/startup'

type AppWithQuitFlag = typeof app & {
  isQuitting?: boolean
}

const appWithQuitFlag = app as AppWithQuitFlag
let dbService: DatabaseService | null = null
let configService: ConfigService | null = null
let logService: LogService | null = null

function configureWindowsGpuPolicy(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return

  if (!configService) {
    try {
      configService = new ConfigService()
      markStartupMilestone('startup:early-config-service-create-done')
    } catch (error) {
      logStartupError('startup:early-config-service-create-failed', error)
    }
  }

  const hardwareAccelerationEnabled = configService?.get('hardwareAccelerationEnabled') !== false
  const shouldDisableGpu = process.env.CIPHERTALK_DISABLE_GPU === '1'
    || process.argv.includes('--disable-gpu')
    || process.argv.includes('--disable-hardware-acceleration')

  if (hardwareAccelerationEnabled && !shouldDisableGpu) {
    markStartupMilestone('startup:windows-gpu-enabled')
    return
  }

  try {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
    markStartupMilestone('startup:windows-gpu-disabled-by-policy')
  } catch (error) {
    logStartupError('startup:windows-gpu-disable-failed', error)
  }
}

configureWindowsGpuPolicy()
installElectronStartupDiagnostics(app)
initAiTelemetry('ciphertalk-main')

// 注册自定义协议为特权协议（必须在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'local-image',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  },
  {
    // 插件资源协议：standard 使相对路径/origin 语义生效（每个插件独立 origin）
    scheme: 'ct-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  {
    // 插件媒体一次性 URL（token 短时效，见 pluginMediaService）
    scheme: 'ct-plugin-media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])
markStartupMilestone('startup:privileged-protocols-registered')

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，统一使用全量安装包
markStartupMilestone('startup:auto-updater-configured')

// 单例服务

// 系统托盘实例
let tray: Tray | null = null
let isInstallingUpdate = false

// 主窗口引用
let mainWindow: BrowserWindow | null = null
// 启动屏窗口引用
let splashWindow: BrowserWindow | null = null
// 启动屏就绪状态
let splashReady = false
// 启动时是否已成功连接数据库（用于通知主窗口跳过重复连接）
let startupDbConnected = false

const allowDevTools = !!process.env.VITE_DEV_SERVER_URL
let windowManager: WindowManager | null = null

const ctx: MainProcessContext = {
  appWithQuitFlag,
  allowDevTools,
  getDbService: () => dbService,
  setDbService: (service) => {
    dbService = service
  },
  getConfigService: () => configService,
  setConfigService: (service) => {
    configService = service
  },
  getLogService: () => logService,
  setLogService: (service) => {
    logService = service
  },
  getMainWindow: () => mainWindow,
  setMainWindow: (window) => {
    mainWindow = window
  },
  getSplashWindow: () => splashWindow,
  setSplashWindow: (window) => {
    splashWindow = window
  },
  getTray: () => tray,
  setTray: (nextTray) => {
    tray = nextTray
  },
  getSplashReady: () => splashReady,
  setSplashReady: (ready) => {
    splashReady = ready
  },
  getStartupDbConnected: () => startupDbConnected,
  setStartupDbConnected: (connected) => {
    startupDbConnected = connected
  },
  getIsInstallingUpdate: () => isInstallingUpdate,
  setIsInstallingUpdate: (installing) => {
    isInstallingUpdate = installing
  },
  broadcastToWindows: (channel, ...args) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    })
  },
  getWindowManager: () => {
    if (!windowManager) {
      throw new Error('WindowManager 未初始化')
    }
    return windowManager
  },
  setWindowManager: (manager) => {
    windowManager = manager
  }
}

ctx.setWindowManager(createWindowManager(ctx))
markStartupMilestone('startup:window-manager-created')

// Windows 通知用 AppUserModelID 作为显示的应用名，必须与 electron-builder 的 appId 一致，
// 否则 toast 标题会回退成 Electron 默认的 "electron.app.CipherTalk"。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ciphertalk.app')
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  warnStartupMilestone('startup:second-instance-quit')
  app.quit()
} else {
  app.on('second-instance', () => {
    warnStartupMilestone('startup:second-instance')
    const targetWindow = ctx.getMainWindow()
      || ctx.getSplashWindow()
      || BrowserWindow.getAllWindows().find(win => !win.isDestroyed())
    if (targetWindow && !targetWindow.isDestroyed()) {
      if (targetWindow.isMinimized()) targetWindow.restore()
      targetWindow.show()
      targetWindow.focus()
    }
  })
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // 只对微信域名忽略证书错误
  if (url.includes('weixin.qq.com') || url.includes('wechat.com')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    markStartupMilestone('startup:app-ready', {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      diagnosticsLog: getStartupDiagnosticsLogPath()
    })

    if (!configService) {
      markStartupMilestone('startup:config-service-create-start')
      configService = new ConfigService()
      markStartupMilestone('startup:config-service-create-done')
    }

    ctx.getWindowManager().setDockIcon()

    if (!configService.get('mcpProxyToken')) {
      markStartupMilestone('startup:mcp-token-create-start')
      configService.set('mcpProxyToken', randomBytes(24).toString('hex'))
      markStartupMilestone('startup:mcp-token-create-done')
    }

    // 跨 AI utility 进程重启/App 重启保持稳定，否则待处理的工具审批签名会因密钥换新而验证失败；
    // 写入 process.env 后经 getElectronWorkerEnv() 原样传给 utility 子进程（engine.ts 里已有读取该变量的兜底逻辑）
    let agentToolApprovalSecret = configService.get('agentToolApprovalSecret')
    if (!agentToolApprovalSecret) {
      agentToolApprovalSecret = randomBytes(32).toString('base64url')
      configService.set('agentToolApprovalSecret', agentToolApprovalSecret)
    }
    process.env.CT_AGENT_TOOL_APPROVAL_SECRET = agentToolApprovalSecret

    // 注册自定义协议用于加载本地视频
    markStartupMilestone('startup:local-protocols-register-start')
    registerLocalProtocols()
    registerPluginProtocol()
    registerPluginNavigationGuard()
    markStartupMilestone('startup:local-protocols-register-done')

    // 插件目录扫描放到启动空闲期，不占启动关键路径
    setTimeout(() => {
      try {
        pluginManagerService.initialize()
        pluginManagerService.on('changed', () => {
          ctx.broadcastToWindows('plugin:changed')
        })
        ctx.broadcastToWindows('plugin:changed')
      } catch (error) {
        ctx.getLogService()?.warn('Plugin', '插件系统初始化失败', { error: String(error) })
      }
    }, 1500)

    markStartupMilestone('startup:ipc-register-start')
    registerModularIpcHandlers(ctx)
    markStartupMilestone('startup:ipc-register-done')

    markStartupMilestone('startup:check-connect-start')
    const shouldShowSplash = await checkAndConnectOnStartup(ctx)
    markStartupMilestone('startup:check-connect-done', { shouldShowSplash })

    // 启动本地 HTTP API（默认 127.0.0.1:5031）
    markStartupMilestone('startup:local-integration-start')
    await startLocalIntegrationServices(ctx)
    markStartupMilestone('startup:local-integration-done')

    if (shouldShowSplash !== false || configService?.get('myWxid')) {
      // 创建主窗口（但不立即显示）
      markStartupMilestone('startup:main-window-create-start')
      ctx.getWindowManager().createMainWindow()
      markStartupMilestone('startup:main-window-create-done')

      // 创建系统托盘
      markStartupMilestone('startup:tray-create-start')
      ctx.getWindowManager().createTray()
      markStartupMilestone('startup:tray-create-done')

      // 上次开着桌宠就跟着一起唤出
      if (configService?.get('petDesktopEnabled') && configService.get('petCurrent')) {
        ctx.getWindowManager().openPetWindow()
      }
    }

    // 启动后台同步放在窗口编排之后，避免启动连接数据库时抢占磁盘 IO。
    markStartupMilestone('startup:background-sync-start')
    startBackgroundSync(ctx)
    markStartupMilestone('startup:background-sync-dispatched')

    // 如果显示了启动屏，主窗口会在启动屏关闭后自动显示（通过 ready-to-show 事件）
    // 如果没有显示启动屏，主窗口会正常显示（通过 ready-to-show 事件）

    // 启动时检测更新
    checkForUpdatesOnStartup(ctx)

    // 后台预热 AI Agent 子进程，消除首次提问的冷启动等待
    warmupAgentProcess(ctx)

    // 独立夜间记忆整理：无对话也会在应用运行时按小时检查一次。
    startNightlyMemoryConsolidation(ctx)

    app.on('activate', () => {
      const mainWindow = ctx.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      } else {
        ctx.getWindowManager().createMainWindow()
        ctx.getWindowManager().createTray()
      }
    })
  }).catch((error) => {
    logStartupError('startup:app-ready-failed', error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  // macOS 上保持应用运行
  if (process.platform !== 'darwin') {
    // 如果托盘存在，不退出应用
    if (!tray) {
      app.quit()
    }
  }
})

app.on('before-quit', () => {
  // 设置退出标志
  appWithQuitFlag.isQuitting = true

  stopLocalIntegrationServices()

  configService?.close()

  // 销毁托盘
  ctx.getWindowManager().destroyTray()

  // 终止导出 utility process（如有）
  void import('./services/exportProcessService').then(({ exportProcessService }) => {
    exportProcessService.shutdown()
  })
  void import('./services/ai/codexSubscriptionService').then(({ codexSubscriptionService }) => {
    codexSubscriptionService.shutdown()
  })
})
