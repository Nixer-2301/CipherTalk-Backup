import { useCallback, useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { Button, Chip, Modal, Toast, toast, Typography } from '@heroui/react'

import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import BottomDock from './components/BottomDock'
import RouteGuard from './components/RouteGuard'
import DecryptProgressOverlay from './components/DecryptProgressOverlay'
import WelcomePage from './pages/WelcomePage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import AgreementPage from './pages/AgreementPage'
import DataManagementPage from './pages/DataManagementPage'
import SettingsPage from './pages/SettingsPage'
import McpPage from './pages/McpPage'
import AgentPage from './pages/agent/AgentPage'
import PersonasPage from './pages/PersonasPage'
import DiaryPage from './pages/DiaryPage'
import ExportPage from './pages/export/ExportPage'
import ActivationPage from './pages/ActivationPage'
import ImageWindow from './pages/ImageWindow'
import VideoWindow from './pages/VideoWindow'
import BrowserWindowPage from './pages/BrowserWindowPage'
import SkillPreviewWindow from './pages/SkillPreviewWindow'
import PosterStyleWindow from './pages/PosterStyleWindow'
import SplashPage from './pages/SplashPage'
import ChatHistoryPage from './pages/ChatHistoryPage'
import PersonaChatPage from './pages/PersonaChatPage'
import MomentsWindow from './pages/MomentsWindow'
import PetWindow from './pages/PetWindow'
import ReplyTileWindow from './pages/ReplyTileWindow'
import PetsPage from './pages/PetsPage'
import PluginViewPage from './features/plugins/PluginViewPage'
import PluginHost from './features/plugins/PluginHost'
import { formatDisplayVersion } from './lib/appVersion'
import { useAppStore } from './stores/appStore'
import { useThemeStore } from './stores/themeStore'
import { useChatStore } from './stores/chatStore'
import { useUpdateStatusStore } from './stores/updateStatusStore'
import { useActivationStore } from './stores/activationStore'
import * as configService from './services/config'
import { initTldList } from './utils/linkify'
import LockScreen from './pages/LockScreen'
import { useAuthStore } from './stores/authStore'
import { Bulb, CircleDashed, Shield } from '@gravity-ui/icons'
import { applyWindowChromeToDocument, syncWindowControlsOverlayToDocument } from './utils/windowChrome'
import type { MemoryMigrationStatusInfo } from './types/electron'
import './App.css'

type AppUpdateInfo = {
  hasUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
  version?: string
  releaseNotes?: string
  title?: string
  message?: string
  minimumSupportedVersion?: string
  reason?: 'minimum-version' | 'blocked-version'
  checkedAt: number
  updateSource: 'r2' | 'github' | 'custom' | 'none'
  policySource: 'r2' | 'github' | 'custom' | 'none'
  diagnostics?: {
    phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
    strategy: 'unknown' | 'differential' | 'full'
    fallbackToFull: boolean
    lastError?: string
    lastEvent?: string
    progressPercent?: number
    downloadedBytes?: number
    totalBytes?: number
    targetVersion?: string
    lastUpdatedAt: number
  }
}

type UpdateDownloadProgressPayload = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

const MAIN_WINDOW_NAV_ROUTES = new Set(['/home', '/agent', '/personas', '/settings', '/pets', '/diary', '/export'])

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setDbConnected } = useAppStore()
  const { themeMode, navLayout, isLoaded, loadTheme } = useThemeStore()
  const { status: activationStatus, checkStatus: checkActivationStatus, initialized: activationInitialized } = useActivationStore()
  const { isLocked, init: initAuth } = useAuthStore()


  // 协议同意状态
  const [showAgreement, setShowAgreement] = useState(false)
  const [agreementLoading, setAgreementLoading] = useState(true)

  // 激活状态
  const [showActivation, setShowActivation] = useState(false)

  // 更新提示状态
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgressPayload | null>(null)
  const updateToastIdRef = useRef<string | null>(null)
  const suppressUpdateToastCloseRef = useRef(false)
  const [memoryMigrationStatus, setMemoryMigrationStatus] = useState<MemoryMigrationStatusInfo | null>(null)
  const [memoryMigrating, setMemoryMigrating] = useState(false)
  const [memoryMigrationError, setMemoryMigrationError] = useState('')
  const [memoryMigrationDismissed, setMemoryMigrationDismissed] = useState(false)

  useEffect(() => {
    const off = window.electronAPI.window.onNavigate((route) => {
      if (MAIN_WINDOW_NAV_ROUTES.has(route)) navigate(route)
    })
    return off
  }, [navigate])

  const formatSpeed = (bytesPerSecond: number) => {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '计算中'
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return '0 B'
    if (bytes < 1024) return `${bytes.toFixed(0)} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const isUpdateDownloading = updateInfo?.diagnostics?.phase === 'downloading' || updateInfo?.diagnostics?.phase === 'installing'
  const progressPercent = downloadProgress?.percent ?? updateInfo?.diagnostics?.progressPercent ?? null

  // 加载主题配置
  useEffect(() => {
    loadTheme()
    // 初始化 TLD 列表（优先从缓存读取）
    initTldList()
    // 初始化认证状态
    initAuth()
  }, [loadTheme])

  useEffect(() => {
    let cancelled = false
    let removeOverlayListeners: (() => void) | undefined

    const bindPlatformChrome = (platform?: string) => {
      const syncPlatformChrome = () => {
        if (cancelled) return
        applyWindowChromeToDocument(platform)
        syncWindowControlsOverlayToDocument(platform)
      }

      syncPlatformChrome()

      const overlay = navigator.windowControlsOverlay
      if (!overlay) {
        return
      }

      overlay.addEventListener('geometrychange', syncPlatformChrome)
      window.addEventListener('resize', syncPlatformChrome)

      removeOverlayListeners = () => {
        overlay.removeEventListener('geometrychange', syncPlatformChrome)
        window.removeEventListener('resize', syncPlatformChrome)
      }
    }

    void window.electronAPI.app.getPlatformInfo().then((info) => {
      if (cancelled) return
      bindPlatformChrome(info.platform)
    }).catch(() => {
      if (cancelled) return
      bindPlatformChrome('win32')
    })

    return () => {
      cancelled = true
      removeOverlayListeners?.()
    }
  }, [])

  // 应用主题
  useEffect(() => {
    if (!isLoaded) return

    const applyMode = (mode: 'light' | 'dark') => {
      document.documentElement.setAttribute('data-theme', mode)
      document.documentElement.setAttribute('data-mode', mode)
      document.documentElement.classList.toggle('light', mode === 'light')
      document.documentElement.classList.toggle('dark', mode === 'dark')
      window.electronAPI.window.setTitleBarOverlay({ symbolColor: mode === 'dark' ? '#ffffff' : '#1a1a1a' })
    }

    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyMode(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent) => applyMode(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyMode(themeMode)
    }
  }, [themeMode, isLoaded])

  // 检查是否需要显示协议
  useEffect(() => {
    const checkAgreement = async () => {
      try {
        const needShow = await configService.needShowAgreement()
        if (needShow) {
          setShowAgreement(true)
        }
      } catch (e) {
        console.error('检查协议状态失败:', e)
      } finally {
        setAgreementLoading(false)
      }
    }
    checkAgreement()
  }, [])

  const handleAgree = async () => {
    await configService.acceptCurrentAgreement()
    setShowAgreement(false)
    // 协议同意后检查激活状态
    const status = await checkActivationStatus()
    if (!status?.isActivated || (status.daysRemaining !== null && status.daysRemaining <= 0)) {
      setShowActivation(true)
    }
  }

  const handleDisagree = () => {
    window.electronAPI.window.close()
  }

  // 检查激活状态（协议同意后）
  useEffect(() => {
    if (!showAgreement && !agreementLoading && !activationInitialized) {
      checkActivationStatus().then(status => {
        if (!status?.isActivated || (status.daysRemaining !== null && status.daysRemaining <= 0)) {
          setShowActivation(true)
        }
      })
    }
  }, [showAgreement, agreementLoading, activationInitialized])

  const handleActivated = () => {
    setShowActivation(false)
  }

  // 监听启动时的更新通知
  useEffect(() => {
    let mounted = true
    window.electronAPI.app.getUpdateState?.().then((info) => {
      if (mounted && info?.hasUpdate) {
        setUpdateInfo(info)
      }
    }).catch((error) => {
      console.error('获取更新状态失败:', error)
    })

    const removeUpdateListener = window.electronAPI.app.onUpdateAvailable?.((info) => {
      setUpdateInfo(info)
    })

    // 监听数据库是否有更新（正在解密同步）
    const removeUpdateAvailableListener = window.electronAPI.dataManagement.onUpdateAvailable?.((hasUpdate) => {
      const time = new Date().toLocaleTimeString()
      if (hasUpdate) {
        console.log(`[${time}] [自动更新] 检测到源数据库有变化，开始同步...`)
        useUpdateStatusStore.getState().setIsUpdating(true)
        useUpdateStatusStore.getState().addLog('检测到源数据库有更新，正在同步...')
      } else {
        console.log(`[${time}] [自动更新] 同步进程结束`)
        useUpdateStatusStore.getState().setIsUpdating(false)
      }
    })

    // 监听会话自动更新（静默增量同步）
    const removeSessionsListener = window.electronAPI.chat.onSessionsUpdated?.((sessions) => {
      const time = new Date().toLocaleTimeString()
      console.log(`[${time}] [自动增量更新] 收到新数据，当前活跃会话:`, sessions.length)
      useUpdateStatusStore.getState().addLog(`自动同步完成 (${sessions.length}个会话)`)
      useChatStore.getState().setSessions(sessions)
    })

    return () => {
      mounted = false
      removeUpdateListener?.()
      removeSessionsListener?.()
      removeUpdateAvailableListener?.()
    }
  }, [])

  // 监听下载进度
  useEffect(() => {
    const removeDownloadListener = window.electronAPI.app.onDownloadProgress?.((progress) => {
      setDownloadProgress(progress)
      setUpdateInfo((current) => {
        if (!current) return current
        return {
          ...current,
          diagnostics: {
            phase: 'downloading',
            strategy: current.diagnostics?.strategy || 'unknown',
            fallbackToFull: current.diagnostics?.fallbackToFull || false,
            lastError: current.diagnostics?.lastError,
            lastEvent: current.diagnostics?.lastEvent,
            progressPercent: progress.percent,
            downloadedBytes: progress.transferred,
            totalBytes: progress.total,
            targetVersion: current.version || current.diagnostics?.targetVersion,
            lastUpdatedAt: Date.now()
          }
        }
      })
    })
    return () => {
      removeDownloadListener?.()
    }
  }, [])

  const closeUpdateToast = useCallback(() => {
    if (!updateToastIdRef.current) return
    suppressUpdateToastCloseRef.current = true
    toast.close(updateToastIdRef.current)
    updateToastIdRef.current = null
  }, [])

  const handleStartUpdate = useCallback(() => {
    if (isUpdateDownloading) return
    closeUpdateToast()
    setUpdateInfo((current) => current ? {
      ...current,
      diagnostics: {
        phase: 'downloading',
        strategy: current.diagnostics?.strategy || 'unknown',
        fallbackToFull: current.diagnostics?.fallbackToFull || false,
        lastError: undefined,
        lastEvent: '开始下载更新',
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: current.diagnostics?.totalBytes,
        targetVersion: current.version || current.diagnostics?.targetVersion,
        lastUpdatedAt: Date.now()
      }
    } : current)
    window.electronAPI.app.downloadAndInstall()
  }, [closeUpdateToast, isUpdateDownloading])

  useEffect(() => {
    if (!updateInfo || updateInfo.forceUpdate || isUpdateDownloading) {
      closeUpdateToast()
      return
    }

    if (updateToastIdRef.current) return

    updateToastIdRef.current = toast.info('发现新版本', {
      actionProps: {
        children: '立即更新',
        onPress: handleStartUpdate,
        variant: 'secondary',
      },
      description: (
        <>
          <div>{formatDisplayVersion(updateInfo.version)} 已发布</div>
          <div>更新源：{updateInfo.updateSource === 'r2' ? 'R2 镜像' : updateInfo.updateSource === 'github' ? 'GitHub Release' : '未知'}</div>
        </>
      ),
      onClose: () => {
        const suppressed = suppressUpdateToastCloseRef.current
        suppressUpdateToastCloseRef.current = false
        updateToastIdRef.current = null
        if (!suppressed) setUpdateInfo(null)
      },
      timeout: 0,
    })
  }, [closeUpdateToast, handleStartUpdate, isUpdateDownloading, updateInfo])

  // 检查是否是独立聊天窗口
  const isChatWindow = location.pathname === '/chat-window'
  const isMomentsWindow = location.pathname === '/moments-window'
  const isAgreementWindow = location.pathname === '/agreement-window'
  const isWelcomeWindow = location.pathname === '/welcome-window'
  const isPosterStyleWindow = location.pathname === '/poster-style-window'

  useEffect(() => {
    if (memoryMigrationDismissed || isChatWindow || isMomentsWindow || isAgreementWindow || isWelcomeWindow || isPosterStyleWindow || location.pathname === '/splash') return
    let cancelled = false
    const checkMemoryMigration = async () => {
      try {
        const res = await window.electronAPI.memory.migrationStatus()
        if (cancelled) return
        if (res.success && res.status?.needed) {
          setMemoryMigrationStatus(res.status)
          setMemoryMigrationError(res.status.error || '')
        }
      } catch (error) {
        if (!cancelled) setMemoryMigrationError(error instanceof Error ? error.message : String(error))
      }
    }
    void checkMemoryMigration()
    return () => { cancelled = true }
  }, [isAgreementWindow, isChatWindow, isMomentsWindow, isPosterStyleWindow, isWelcomeWindow, location.pathname, memoryMigrationDismissed])

  const handleDismissMemoryMigration = () => {
    setMemoryMigrationDismissed(true)
    setMemoryMigrationStatus(null)
    setMemoryMigrationError('')
  }

  const handleMigrateMemory = async () => {
    setMemoryMigrating(true)
    setMemoryMigrationError('')
    try {
      const res = await window.electronAPI.memory.migrateLegacy()
      if (res.success && res.result?.success) {
        setMemoryMigrationStatus(null)
        const skippedCount = res.result.skippedItemCount || 0
        const skippedText = skippedCount > 0 ? `，跳过 ${skippedCount} 条无效记录` : ''
        toast.success(`已迁移 ${Math.max(0, res.result.itemCount - skippedCount)} 条记忆${skippedText}`)
      } else {
        setMemoryMigrationError(res.error || '迁移失败')
      }
    } catch (error) {
      setMemoryMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMemoryMigrating(false)
    }
  }

  // 启动时自动检查配置并连接数据库
  useEffect(() => {
    // 独立窗口不需要自动连接主数据库
    if (isChatWindow || isMomentsWindow || isAgreementWindow || isWelcomeWindow || isPosterStyleWindow || location.pathname === '/image-viewer-window' || location.pathname === '/pet-window' || location.pathname === '/reply-tile-window') return

    const autoConnect = async () => {
      try {
        const dbPath = await configService.getDbPath()
        const decryptKey = await configService.getDecryptKey()
        const wxid = await configService.getMyWxid()

        // 如果配置完整，检查启动时是否已经连接
        if (dbPath && decryptKey && wxid) {
          // 先检查启动屏阶段是否已经成功连接
          const startupConnected = await window.electronAPI.app.getStartupDbConnected?.()
          if (startupConnected) {
            console.log('启动时已通过启动屏连接数据库，跳过重复连接')
            setDbConnected(true, dbPath)
            // 预加载用户信息
            await preloadUserInfo()
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
            return
          }

          // 启动屏未连接，执行自动连接
          console.log('检测到已保存的配置，正在自动连接...')
          const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid, true) // 标记为自动连接

          if (result.success) {
            console.log('自动连接成功')
            setDbConnected(true, dbPath)
            // 预加载用户信息
            await preloadUserInfo()
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
          } else {
            console.log('自动连接失败:', result.error)
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
      }
    }

    // 预加载用户信息
    const preloadUserInfo = async () => {
      try {
        const result = await window.electronAPI.chat.getMyUserInfo()
        if (result.success && result.userInfo) {
          useAppStore.getState().setUserInfo({
            wxid: result.userInfo.wxid,
            nickName: result.userInfo.nickName,
            alias: result.userInfo.alias,
            avatarUrl: result.userInfo.avatarUrl
          })
          console.log('用户信息预加载完成')
        } else {
          useAppStore.getState().setUserInfo(null)
        }
      } catch (e) {
        console.error('预加载用户信息失败:', e)
        useAppStore.getState().setUserInfo(null)
      }
    }

    autoConnect()
  }, [isChatWindow, isMomentsWindow, isAgreementWindow, isPosterStyleWindow, isWelcomeWindow, location.pathname, navigate, setDbConnected])

  // 独立聊天窗口 - 只显示聊天页面，无侧边栏
  if (isChatWindow) {
    return (
      <div className="chat-window-container">
        <ChatPage />
      </div>
    )
  }

  // 独立朋友圈窗口
  if (isMomentsWindow) {
    return (
      <div className="standalone-window">
        <MomentsWindow />
      </div>
    )
  }

  // 独立聊天记录窗口
  if (location.pathname.startsWith('/chat-history/')) {
    return (
      <div className="standalone-window">
        <TitleBar variant="standalone" />
        <ChatHistoryPage />
      </div>
    )
  }

  // 独立克隆好友（数字分身）聊天窗口
  if (location.pathname.startsWith('/persona-chat/')) {
    return (
      <div className="standalone-window standalone-window--persona">
        <div className="persona-chat-drag-region" aria-hidden="true" />
        <PersonaChatPage />
      </div>
    )
  }

  // 独立引导窗口
  if (isWelcomeWindow) {
    return <WelcomePage standalone />
  }

  // 独立图片查看窗口
  if (location.pathname === '/image-viewer-window') {
    return <ImageWindow />
  }

  // 独立视频播放窗口
  if (location.pathname === '/video-player-window') {
    return <VideoWindow />
  }

  // 桌面悬浮桌宠窗口
  if (location.pathname === '/pet-window') {
    return <PetWindow />
  }

  // 回复建议磁贴窗口（贴微信右侧/左侧）
  if (location.pathname === '/reply-tile-window') {
    return <ReplyTileWindow />
  }

  // 独立协议窗口
  if (isAgreementWindow) {
    return <AgreementPage />
  }

  // 独立浏览器窗口
  if (location.pathname === '/browser-window') {
    return (
      <div className="standalone-window">
        <TitleBar variant="standalone" />
        <BrowserWindowPage />
      </div>
    )
  }

  if (location.pathname === '/skill-preview-window') {
    return <SkillPreviewWindow />
  }

  // 插件独立窗口：/plugin-window/:pluginId/:viewId
  if (location.pathname.startsWith('/plugin-window/')) {
    const [, , pluginWindowId, pluginWindowView] = location.pathname.split('/')
    return (
      <div className="standalone-window">
        <TitleBar variant="standalone" />
        <div className="flex-1 min-h-0">
          {pluginWindowId && pluginWindowView && (
            <PluginHost pluginId={pluginWindowId} viewId={pluginWindowView} />
          )}
        </div>
      </div>
    )
  }

  if (isPosterStyleWindow) {
    return (
      <div className="poster-style-standalone-window">
        <div className="poster-style-drag-bar" />
        <PosterStyleWindow />
      </div>
    )
  }

  // 启动屏
  if (location.pathname === '/splash') {
    return <SplashPage />
  }

  // 首次启动协议弹窗 - 全屏遮罩，不可关闭
  if (showAgreement && !agreementLoading) {
    return (
      <div className="app-container">
        <div className="agreement-fullscreen">
          <div className="agreement-window">
            <div className="agreement-window-header">
              <Shield width={28} height={28} />
              <h2>用户协议与隐私政策 <span style={{ fontSize: '14px', fontWeight: 'normal', opacity: 0.6 }}>v{configService.CURRENT_AGREEMENT_VERSION}.0</span></h2>
            </div>
            <div className="agreement-window-body">
              <p className="agreement-intro">欢迎使用密语！在使用本软件前，请仔细阅读并同意以下条款：</p>

              <div className="agreement-scroll">
                <h3>一、用户协议</h3>

                <h4>1. 软件性质与用途说明</h4>
                <p>1.1 本软件是一款技术研究工具，用于读取和查看用户本地设备上已存在的微信数据文件，主要功能包括但不限于：本地数据文件解析、聊天记录查看及数据导出。</p>
                <p>1.2 本软件仅供用户个人学习、研究和技术交流之目的使用，不得用于任何商业用途。</p>
                <p>1.3 本软件仅作为数据查看工具，不具备也不提供任何主动获取、拦截、窃取数据的能力，所有操作均基于用户本地设备上已存在的文件。</p>

                <h4>2. 使用限制</h4>
                <p>2.1 用户不得将本软件用于任何违反中华人民共和国法律法规、行政规章、社会公序良俗的用途，包括但不限于侵犯他人隐私权、个人信息权益、商业秘密或其他合法权益。</p>
                <p>2.2 用户不得将本软件用于任何形式的商业使用、商业分发、商业服务、盈利活动或变相商业用途。</p>
                <p>2.3 用户不得对本软件进行反向工程、反编译、反汇编，或以其他方式试图获取本软件的源代码（法律法规另有明确规定的除外）。</p>

                <h4>3. 数据归属与用户责任</h4>
                <p>3.1 用户理解并确认，本软件所读取的微信聊天数据的知识产权及相关权益归属于腾讯公司及相关权利方，本软件及其开发者不主张对该等数据的任何所有权。</p>
                <p>3.2 用户应自行确保其使用本软件的行为符合微信及腾讯相关产品的服务条款、用户协议及适用的法律法规。因用户使用本软件而产生的任何法律责任、纠纷、索赔、处罚或损失，均由用户自行承担，与本软件开发者无任何关联。</p>
                <p>3.3 用户理解并确认，使用本软件可能涉及对本地数据文件的读取操作，用户应自行评估使用风险并做好数据备份，本软件及其开发者不对任何数据丢失、损坏或不可恢复承担责任。</p>
                <p>3.4 用户不得将通过本软件获取的任何数据用于侵犯他人隐私、诽谤、骚扰或其他违法违规用途。</p>

                <h4>4. 免责声明</h4>
                <p>4.1 本软件按"现状"提供，开发者不对本软件的适用性、准确性、完整性、稳定性、可靠性作出任何明示或暗示的保证。</p>
                <p>4.2 在法律允许的最大范围内，因使用或无法使用本软件所导致的任何直接损失、间接损失、附带损失、后果性损失（包括但不限于数据丢失、业务中断、设备损坏、名誉损失等），均由用户自行承担，开发者不承担任何责任。</p>
                <p>4.3 如因不可抗力、第三方原因、系统环境差异、软件冲突或用户自身操作不当导致的任何损失，开发者不承担任何责任。</p>

                <h4>5. 知识产权声明</h4>
                <p>5.1 本软件及其相关的所有内容（包括但不限于程序代码、界面设计、图标、文档说明等）的知识产权，均归开发者依法所有。</p>
                <p>5.2 未经开发者事先书面许可，任何单位或个人不得以任何形式复制、修改、传播、出租、出售或用于其他侵权行为。</p>

                <h4>6. 协议的变更与终止</h4>
                <p>6.1 开发者有权根据需要不定期对本协议进行修订，修订后的协议一经公布即生效。</p>
                <p>6.2 若用户在协议变更后继续使用本软件，即视为用户已接受修改后的协议内容。</p>
                <p>6.3 用户如不同意协议变更内容，应立即停止使用本软件。</p>

                <h4>7. 适用法律与争议解决</h4>
                <p>7.1 本协议的订立、执行、解释及争议解决均适用中华人民共和国大陆地区法律。</p>
                <p>7.2 因本协议或本软件使用所引起的任何争议，双方应首先友好协商解决；协商不成的，任何一方均可向开发者所在地有管辖权的人民法院提起诉讼。</p>

                <h3>二、第三方服务接入说明（补充协议）</h3>
                <p>8.1 本软件仅保留第三方 AI 服务商接入配置能力，用于保存服务地址、模型名称及 API 密钥等本地配置。</p>
                <p>8.2 用户主动测试连接或刷新模型列表时，软件会向所选服务商发起必要的网络请求。请自行确认所填服务商的隐私与合规政策。</p>
                <p>8.3 本软件不对第三方服务的稳定性、准确性及数据安全性承担责任。</p>

                <h3>三、隐私政策</h3>

                <h4>1. 数据收集声明</h4>
                <p>1.1 本软件不会以任何形式收集、存储、上传、分析或共享任何用户的个人信息或聊天数据。</p>
                <p>1.2 开发者无法也不会获取用户的聊天记录、账号信息或任何本地数据内容。</p>

                <h4>2. 本地数据处理说明</h4>
                <p>2.1 本软件的所有核心功能均在用户本地计算机环境中完成。</p>
                <p>2.2 所有解密、解析、统计、导出等操作均仅作用于用户本地文件，不会通过网络传输任何数据。</p>

                <h4>3. 网络请求说明</h4>
                <p>3.1 本软件仅在用户主动或默认启用"检查更新"功能时，访问网络以获取软件版本更新信息。</p>
                <p>3.2 更新检查过程中，不会上传任何用户数据、设备数据或使用行为数据。</p>

                <h4>4. 数据安全措施</h4>
                <p>4.1 本软件不建立服务器端数据存储，因此不存在服务器端数据泄露风险。</p>
                <p>4.2 用户应自行妥善保管其计算机设备及相关数据环境，因设备安全问题导致的风险由用户自行承担。</p>

                <h4>5. 用户权利</h4>
                <p>5.1 用户有权随时停止使用本软件，并自行删除本软件及相关本地文件。</p>
                <p>5.2 由于本软件不收集、不保存任何用户数据，开发者无需也无法提供数据查询、更正或删除服务。</p>

                <p className="agreement-notice">如您对本协议或隐私政策有任何疑问，请在使用前自行进行充分评估。再次提醒：一旦使用本软件，即视为您已完全理解并同意本协议的全部内容。</p>
                <div style={{
                  marginTop: '30px',
                  paddingTop: '20px',
                  borderTop: '1px dashed var(--border-color)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: 'var(--text-tertiary)',
                  fontSize: '12px'
                }}>
                  <span>协议版本：v{configService.CURRENT_AGREEMENT_VERSION}.0</span>
                  <span>更新日期：2026年01月23日</span>
                </div>
              </div>
            </div>
            <div className="agreement-window-footer">
              <p className="agreement-hint">点击"同意并继续"即表示您已阅读并同意以上条款</p>
              <div className="agreement-actions">
                <button className="btn btn-secondary" onClick={handleDisagree}>不同意并退出</button>
                <button className="btn btn-primary" onClick={handleAgree}>同意并继续</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 激活页面 - 未激活或已过期时显示
  if (showActivation && !showAgreement) {
    return (
      <div className="app-container">
        <TitleBar />
        <ActivationPage onActivated={handleActivated} />
      </div>
    )
  }

  // 主窗口 - 完整布局
  const disableContentOverflow = ['/data-management', '/settings', '/mcp', '/agent', '/personas', '/diary', '/pets'].includes(location.pathname)
  const fullPageRoutes = ['/home']
  const isFullPage = fullPageRoutes.includes(location.pathname)
  const edgeToEdgeRoutes: string[] = []
  const isEdgeToEdge = edgeToEdgeRoutes.includes(location.pathname)
  const isAgentPage = location.pathname === '/agent'
  const isFlushContentPage = isAgentPage || location.pathname === '/personas'
  const pendingMemoryMigrationStatus = !isLocked && memoryMigrationStatus?.needed ? memoryMigrationStatus : null

  return (
    <div className={`app-container${navLayout === 'sidebar' ? ' app-container--sidebar' : ''}`}>
      <Toast.Provider className="ct-toast-region" placement="top" />
      {navLayout === 'sidebar' && <Sidebar autoCollapse={isAgentPage || location.pathname === '/home'} />}
      <div className="app-shell">
      <TitleBar showTitle={false} />
      {pendingMemoryMigrationStatus && (
        <Modal.Backdrop
          isDismissable={!memoryMigrating}
          isKeyboardDismissDisabled={memoryMigrating}
          isOpen
          variant="blur"
          onOpenChange={(open) => {
            if (!open && !memoryMigrating) handleDismissMemoryMigration()
          }}
        >
          <Modal.Container placement="center" scroll="inside" size="lg">
            <Modal.Dialog className="sm:max-w-170">
              <Modal.Header>
                <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                  <Bulb className="size-5" />
                </Modal.Icon>
                <div className="flex min-w-0 flex-col gap-2">
                  <Chip color="accent" size="sm" variant="soft">记忆系统迁移</Chip>
                  <Modal.Heading>需要迁移旧版 AI 记忆</Modal.Heading>
                </div>
              </Modal.Header>
              <Modal.Body>
                <Typography.Paragraph color="muted" size="sm">
                  检测到旧版记忆库里有 {pendingMemoryMigrationStatus.itemCount} 条记忆。新版会迁移到缓存目录下的 memory-bank Markdown 文件夹，迁移完成后会尝试删除旧版记忆数据库文件。
                </Typography.Paragraph>
                <div className="grid gap-2 rounded-lg bg-surface p-3 text-xs text-muted">
                  <div className="break-all">旧库：{pendingMemoryMigrationStatus.legacyDbPath}</div>
                  <div className="break-all">新目录：{pendingMemoryMigrationStatus.memoryBankPath}</div>
                </div>
                {memoryMigrationError && (
                  <Typography.Paragraph className="rounded-lg bg-danger-soft p-3 text-danger-soft-foreground" size="sm">
                    {memoryMigrationError}
                  </Typography.Paragraph>
                )}
              </Modal.Body>
              <Modal.Footer className="justify-end">
                <Button isDisabled={memoryMigrating} type="button" variant="tertiary" onPress={handleDismissMemoryMigration}>
                  稍后
                </Button>
                <Button isPending={memoryMigrating} type="button" variant="primary" onPress={() => void handleMigrateMemory()}>
                  {memoryMigrating ? '迁移中...' : '开始迁移'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      )}
      {updateInfo?.forceUpdate && (
        <div className="force-update-overlay">
          <div className="force-update-card">
            <div className="force-update-badge">
              <Shield width={18} height={18} />
              <span>强制更新</span>
            </div>
            <h2>{updateInfo.title || '必须更新后才能继续使用'}</h2>
            <p className="force-update-desc">
              {updateInfo.message || '当前版本已被标记为需要立即升级，应用将限制继续使用，直到安装最新版本。'}
            </p>

            <div className="force-update-meta">
              <div>当前版本：{formatDisplayVersion(updateInfo.currentVersion)}</div>
              {updateInfo.version && <div>目标版本：{formatDisplayVersion(updateInfo.version)}</div>}
              {updateInfo.minimumSupportedVersion && <div>最低安全版本：{formatDisplayVersion(updateInfo.minimumSupportedVersion)}</div>}
              <div>更新来源：{updateInfo.updateSource === 'r2' ? 'R2 镜像' : updateInfo.updateSource === 'github' ? 'GitHub Release' : '未检测到普通更新源'}</div>
              <div>策略来源：{updateInfo.policySource === 'r2' ? 'R2 策略源' : updateInfo.policySource === 'github' ? 'GitHub 策略源' : updateInfo.policySource === 'custom' ? '自定义策略源' : '无'}</div>
            </div>

            {updateInfo.releaseNotes && (
              <div className="force-update-notes">
                <div className="force-update-notes-title">更新说明</div>
                <pre>{updateInfo.releaseNotes}</pre>
              </div>
            )}

            {progressPercent !== null && (
              <div className="force-update-progress">
                <div className="force-update-progress-label">
                  <CircleDashed width={16} height={16} className="spin" />
                  <span>正在下载更新... {progressPercent.toFixed(0)}%</span>
                </div>
                <div className="force-update-progress-bar">
                  <div className="force-update-progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            <div className="force-update-actions">
              <button className="btn btn-primary" onClick={handleStartUpdate} disabled={isUpdateDownloading}>
                立即更新
              </button>
              <button className="btn btn-secondary" onClick={() => window.electronAPI.window.close()}>
                退出应用
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <main
          className={`flex-1 min-w-0 ${(disableContentOverflow || isFullPage || isEdgeToEdge) ? 'overflow-hidden' : 'overflow-auto'} ${navLayout === 'sidebar' && !isEdgeToEdge ? 'bg-(--bg-primary) rounded-3xl mr-3 mb-3 ct-squircle' : ''}`}
          style={{ paddingLeft: (isFullPage || isEdgeToEdge || isFlushContentPage) ? 0 : 24, paddingRight: (isFullPage || isEdgeToEdge || isFlushContentPage) ? 0 : 24, paddingTop: (isFullPage || isEdgeToEdge || isFlushContentPage) ? 0 : 24 }}
        >
          <RouteGuard>
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/analytics" element={<Navigate to="/home" replace />} />
              <Route path="/annual-report" element={<Navigate to="/home" replace />} />
              <Route path="/group-analytics-window" element={<Navigate to="/home" replace />} />
              <Route path="/annual-report-window" element={<Navigate to="/home" replace />} />
              <Route path="/data-management" element={<DataManagementPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/mcp" element={<McpPage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/personas" element={<PersonasPage />} />
              <Route path="/diary" element={<DiaryPage />} />
              <Route path="/pets" element={<PetsPage />} />
              <Route path="/export" element={<ExportPage />} />
              <Route path="/device-connect" element={<Navigate to="/home" replace />} />
              <Route path="/chat-history/:sessionId/:messageId" element={<ChatHistoryPage />} />
              <Route path="/plugin/:pluginId/:viewId" element={<PluginViewPage />} />
            </Routes>
          </RouteGuard>
        </main>
      </div>
      </div>
      {navLayout === 'dock' && <BottomDock />}
      <DecryptProgressOverlay />
      {progressPercent !== null && (
        <div className="download-progress-capsule">
          <div className="capsule-compact">
            <CircleDashed className="spin" width={14} height={14} />
            <span>更新中 {progressPercent.toFixed(0)}%</span>
          </div>
          <div className="capsule-detail">
            <div className="capsule-detail-head">
              <CircleDashed className="spin" width={14} height={14} />
              <span className="capsule-detail-title">
                正在下载更新{updateInfo?.version ? ` ${formatDisplayVersion(updateInfo.version)}` : ''}
              </span>
              <span className="capsule-detail-pct">{progressPercent.toFixed(0)}%</span>
            </div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="capsule-detail-meta">
              <span>{formatBytes(downloadProgress?.transferred ?? updateInfo?.diagnostics?.downloadedBytes)} / {formatBytes(downloadProgress?.total ?? updateInfo?.diagnostics?.totalBytes)}</span>
              <span>{formatSpeed(downloadProgress?.bytesPerSecond ?? 0)}</span>
            </div>
          </div>
        </div>
      )}
      {isLocked && <LockScreen />}
    </div>
  )
}

export default App
