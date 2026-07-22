import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { useSearchParams, useLocation } from 'react-router-dom'
import { Tabs, ScrollShadow, Skeleton, toast, type Key as HeroKey } from '@heroui/react'
import { useAppStore } from '../../stores/appStore'
import type { UpdateDownloadProgressPayload } from '../../types/electron'
import type { AccountProfile } from '../../types/account'
import { dialog } from '../../services/ipc'
import * as configService from '../../services/config'
import AboutTab from './tabs/AboutTab'
import ActivationTab from './tabs/ActivationTab'
import AppearanceTab from './tabs/AppearanceTab'
import SecurityTab from './tabs/SecurityTab'
import type { UpdateInfo } from './types'
import { formatFileSize } from './utils'
import { useSettingsStore } from './settingsStore'
import { usePluginStore, ensurePluginStoreSubscribed, selectEnabledPlugins } from '../../stores/pluginStore'
import PluginHost from '../../features/plugins/PluginHost'
import { ConfirmDialog, FloatingSaveButton } from './ui'
import { ArrowDownToLine, ArrowRotateLeft, ArrowsRotateLeft, Bulb, Check, ChevronDown, CircleCheck, CircleExclamation, CircleInfo, Database, Eye, EyeSlash, FaceSmile, FolderMagnifier, FolderOpen, HardDrive, Key, Layers, Lock, Magnifier, Microphone, Minus, Palette, Person, Picture, PlugConnection, Plus, Shield, ShieldCheck, Sparkles, Thunderbolt, TrashBin, Xmark } from '@gravity-ui/icons'
import '../../pages/SettingsPage.css'

const AISummarySettings = lazy(() => import('../ai/AISummarySettings'))
const DataManagementTab = lazy(() => import('./tabs/DataManagementTab'))
const DatabaseTab = lazy(() => import('./tabs/DatabaseTab'))
const SttTab = lazy(() => import('./tabs/SttTab'))
const MemoryTab = lazy(() => import('./tabs/MemoryTab'))
const PluginsTab = lazy(() => import('./tabs/PluginsTab'))

type SettingsTab = 'appearance' | 'database' | 'stt' | 'ai' | 'memory' | 'data' | 'plugins' | 'security' | 'activation' | 'about'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'database', label: '数据解密', icon: Database },
  { id: 'security', label: '安全设置', icon: Lock },
  { id: 'stt', label: '语音转文字', icon: Microphone },
  { id: 'ai', label: 'AI 接入', icon: Sparkles },
  { id: 'memory', label: '记忆', icon: Bulb },
  { id: 'data', label: '数据管理', icon: HardDrive },
  { id: 'plugins', label: '插件', icon: PlugConnection },
  // { id: 'activation', label: '激活', icon: Shield },
  { id: 'about', label: '关于', icon: CircleInfo }
]

const sttLanguageOptions = [
  { value: 'zh', label: '中文', enLabel: 'Chinese' },
  { value: 'en', label: '英语', enLabel: 'English' },
  { value: 'ja', label: '日语', enLabel: 'Japanese' },
  { value: 'ko', label: '韩语', enLabel: 'Korean' },
  { value: 'yue', label: '粤语', enLabel: 'Cantonese' }
]

const sttModelTypeOptions = [
  { value: 'int8', label: 'int8 量化版', size: '235 MB', desc: '推荐，体积小、速度快' },
  { value: 'float32', label: 'float32 完整版', size: '920 MB', desc: '更高精度，体积较大' }
]

const sttOnlineLanguageOptions = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' }
]

const sttOnlineProviderOptions = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'aliyun-qwen-asr', label: '阿里云 Qwen-ASR' },
  { value: 'custom', label: '自定义接口' }
] as const

const STT_ONLINE_DEFAULTS = {
  'openai-compatible': {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe'
  },
  'aliyun-qwen-asr': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash'
  },
  custom: {
    baseURL: '',
    model: ''
  }
} as const

function SettingsTabSkeleton() {
  return (
    <div className="tab-content" aria-busy="true" aria-label="设置页内容占位">
      <div className="mx-auto w-full max-w-290 space-y-6 px-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-6 w-36 rounded-lg" />
            <Skeleton className="h-4 w-72 max-w-full rounded-lg" />
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-9 w-36 rounded-lg" />
          </div>
        </div>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
          <div className="space-y-5 rounded-lg border border-border bg-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <Skeleton className="h-5 w-24 rounded-lg" />
              <Skeleton className="size-7 rounded-lg" />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-10 w-full rounded-lg" />
              <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="h-10 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </div>
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Skeleton className="h-9 w-24 rounded-lg" />
              <Skeleton className="h-9 w-24 rounded-lg" />
              <Skeleton className="h-9 w-32 rounded-lg" />
            </div>
          </div>

          <div className="space-y-5">
            <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
              <Skeleton className="h-5 w-28 rounded-lg" />
              <div className="space-y-3">
                <Skeleton className="h-4 w-full rounded-lg" />
                <Skeleton className="h-4 w-5/6 rounded-lg" />
                <Skeleton className="h-4 w-2/3 rounded-lg" />
              </div>
            </div>
            <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
              <Skeleton className="h-5 w-24 rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsLayout() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const { setDbConnected, setLoading, setMyWxid: setCurrentWxid, userInfo } = useAppStore()
  const hydrateSettings = useSettingsStore(s => s.hydrate)
  const commitSettings = useSettingsStore(s => s.commit)
  const storeHasUnsavedChanges = useSettingsStore(s => s.hasUnsavedChanges)
  const storeIsSaving = useSettingsStore(s => s.isSaving)

  const [accountsList, setAccountsList] = useState<AccountProfile[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [editingAccountId, setEditingAccountId] = useState('')

  // 账号相关操作的通用确认弹窗(删除账号、清理配置等)
  const [securityConfirm, setSecurityConfirm] = useState<{
    show: boolean
    title: string
    message: string
    onConfirm: () => void
  }>({ show: false, title: '', message: '', onConfirm: () => { } })

  const [activeTab, setActiveTab] = useState<SettingsTab | string>(() => {
    const tab = searchParams.get('tab')
    if (tab && (tabs.some(t => t.id === tab) || tab.startsWith('plugin:'))) {
      return tab
    }
    return 'appearance'
  })

  // 插件设置 tab 贡献点（声明式，只读 manifest）
  const installedPlugins = usePluginStore(state => state.plugins)
  useEffect(() => { ensurePluginStoreSubscribed() }, [])
  const pluginTabs = selectEnabledPlugins(installedPlugins).flatMap((plugin) =>
    (plugin.contributes.settingsTabs ?? []).map((tab) => ({
      id: `plugin:${plugin.id}:${tab.view}`,
      label: tab.label,
      pluginId: plugin.id,
      view: tab.view,
    }))
  )
  const activePluginTab = pluginTabs.find(t => t.id === activeTab)

  const [decryptKey, setDecryptKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [showWxidDropdown, setShowWxidDropdown] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [cachePath, setCachePath] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [defaultExportPath, setDefaultExportPath] = useState('')

  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isGettingKey, setIsGettingKey] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadProgressDetail, setDownloadProgressDetail] = useState<UpdateDownloadProgressPayload | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [keyStatus, setKeyStatus] = useState('')
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [showXorKey, setShowXorKey] = useState(false)
  const [closeToTray, setCloseToTray] = useState(true)
  const [showAesKey, setShowAesKey] = useState(false)
  const [showClearDialog, setShowClearDialog] = useState<{
    type: 'images' | 'emojis' | 'aiData' | 'all' | 'currentAccount' | 'allAccounts'
    title: string
    message: string
  } | null>(null)
  const [sttLanguages, setSttLanguagesState] = useState<string[]>([])
  const [sttModelType, setSttModelType] = useState<'int8' | 'float32'>('int8')
  const [sttMode, setSttMode] = useState<'cpu' | 'gpu' | 'online'>('cpu')
  const [sttOnlineProvider, setSttOnlineProvider] = useState<'openai-compatible' | 'aliyun-qwen-asr' | 'volcano-doubao' | 'custom'>('openai-compatible')
  const [sttOnlineApiKey, setSttOnlineApiKey] = useState('')
  const [sttOnlineBaseURL, setSttOnlineBaseURL] = useState('https://api.openai.com/v1')
  const [sttOnlineModel, setSttOnlineModel] = useState('gpt-4o-mini-transcribe')
  const [sttOnlineLanguage, setSttOnlineLanguage] = useState('auto')
  const [sttOnlineTimeoutMs, setSttOnlineTimeoutMs] = useState(60000)
  const [sttOnlineMaxConcurrency, setSttOnlineMaxConcurrency] = useState(2)
  const [showSttOnlineLanguageDropdown, setShowSttOnlineLanguageDropdown] = useState(false)
  const [quoteStyle, setQuoteStyle] = useState<'default' | 'wechat' | 'card'>('default')
  const [skipIntegrityCheck, setSkipIntegrityCheck] = useState(false)
  const [exportDefaultDateRange, setExportDefaultDateRange] = useState<number>(0)
  const [autoUpdateDatabase, setAutoUpdateDatabase] = useState(true)
  // 自动同步高级参数
  const [autoUpdateCheckInterval, setAutoUpdateCheckInterval] = useState(60) // 检查间隔（秒）
  const [autoUpdateMinInterval, setAutoUpdateMinInterval] = useState(1000)   // 最小更新间隔（毫秒）
  const [autoUpdateDebounceTime, setAutoUpdateDebounceTime] = useState(500)  // 防抖时间（毫秒）

  // AI 相关配置状态
  const [aiProvider, setAiProviderState] = useState('deepseek')
  const [aiApiKey, setAiApiKeyState] = useState('')
  const [aiModel, setAiModelState] = useState('')

  // 日志相关状态
  const [logFiles, setLogFiles] = useState<Array<{ name: string; size: number; mtime: Date }>>([])
  const [selectedLogFile, setSelectedLogFile] = useState<string>('')
  const [logContent, setLogContent] = useState<string>('')
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [isLoadingLogContent, setIsLoadingLogContent] = useState(false)
  const [logSize, setLogSize] = useState<number>(0)
  const [currentLogLevel, setCurrentLogLevel] = useState<string>('WARN')
  const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({
    platform: 'win32',
    arch: 'x64'
  })

  const sttOnlineLanguageRef = useRef<HTMLDivElement>(null)
  const isMac = platformInfo.platform === 'darwin'

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!sttOnlineLanguageRef.current?.contains(event.target as Node)) {
        setShowSttOnlineLanguageDropdown(false)
      }
    }

    if (showSttOnlineLanguageDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSttOnlineLanguageDropdown])

  const getAccountDisplayName = (account?: AccountProfile | null) => {
    if (!account) return '未命名账号'

    const activeNickname = account.id === activeAccountId ? userInfo?.nickName?.trim() : ''
    if (activeNickname) return activeNickname

    const savedName = account.displayName?.trim()
    if (savedName && savedName !== '未命名账号') return savedName

    return account.wxid?.trim() || '未命名账号'
  }

  const buildAccountPayload = () => {
    const currentAccount = accountsList.find(item => item.id === editingAccountId)
    const currentDisplayName = currentAccount?.displayName?.trim()
    const preferredDisplayName = userInfo?.nickName?.trim()
      || (currentDisplayName && currentDisplayName !== '未命名账号' ? currentDisplayName : '')
      || wxid.trim()
      || '未命名账号'

    return {
      wxid: wxid.trim(),
      dbPath: dbPath.trim(),
      decryptKey: decryptKey.trim(),
      cachePath: cachePath.trim(),
      imageXorKey: imageXorKey.trim(),
      imageAesKey: imageAesKey.trim(),
      displayName: preferredDisplayName
    }
  }

  const applyAccountToForm = (account: AccountProfile | null) => {
    setEditingAccountId(account?.id || '')
    setDecryptKey(account?.decryptKey || '')
    setDbPath(account?.dbPath || '')
    setWxid(account?.wxid || '')
    setCachePath(account?.cachePath || '')
    setImageXorKey(account?.imageXorKey || '')
    setImageAesKey(account?.imageAesKey || '')
    setIsAccountVerified(Boolean(account?.decryptKey && account?.dbPath && account?.wxid))
  }

  const refreshAccountsState = async (preferredEditingId?: string) => {
    const [accounts, activeAccount] = await Promise.all([
      configService.listAccounts(),
      configService.getActiveAccount()
    ])
    setAccountsList(accounts)
    setActiveAccountId(activeAccount?.id || '')

    const editingId = preferredEditingId || editingAccountId || activeAccount?.id || accounts[0]?.id || ''
    const editingAccount = accounts.find(item => item.id === editingId) || activeAccount || accounts[0] || null
    applyAccountToForm(editingAccount)
    return { accounts, activeAccount, editingAccount }
  }

  useEffect(() => {
    const syncActiveAccountDisplayName = async () => {
      const activeNickname = userInfo?.nickName?.trim()
      if (!activeNickname || !activeAccountId) return

      const activeAccount = accountsList.find(item => item.id === activeAccountId)
      if (!activeAccount) return

      const savedName = activeAccount.displayName?.trim()
      if (savedName && savedName !== activeAccount.wxid && savedName !== '未命名账号') return

      const updated = await configService.updateAccount(activeAccount.id, { displayName: activeNickname })
      if (!updated) return

      await refreshAccountsState(editingAccountId || activeAccount.id)
    }

    void syncActiveAccountDisplayName()
  }, [userInfo?.nickName, activeAccountId, accountsList])

  useEffect(() => {
    loadConfig()
    loadDefaultExportPath()
    loadAppVersion()
    loadLogFiles()
    void window.electronAPI.app.getPlatformInfo().then(setPlatformInfo).catch(() => {
      // ignore
    })
  }, [])

  const loadConfig = async () => {
    try {
      // 账号信息和各项配置并发拉取，避免几十次串行 IPC 拖慢进入设置页
      const accountsPromise = refreshAccountsState()
      const [
        savedKey, savedPath, savedWxid, savedCachePath, savedXorKey, savedAesKey,
        savedExportPath, savedSttLanguages, savedSttModelType, savedSttMode,
        savedSttOnlineProvider, savedSttOnlineApiKey, savedSttOnlineBaseURL,
        savedSttOnlineModel, savedSttOnlineLanguage, savedSttOnlineTimeoutMs,
        savedSttOnlineMaxConcurrency, savedSkipIntegrityCheck, savedAutoUpdateDatabase,
        savedCheckInterval, savedMinInterval, savedDebounceTime,
        savedQuoteStyle, savedExportDefaultDateRange,
       savedAiProvider, savedAiApiKey, savedAiModel,
        savedCloseToTray, savedHardwareAccelerationEnabled, savedDiaryEnabled
     ] = await Promise.all([
        configService.getDecryptKey(), configService.getDbPath(), configService.getMyWxid(), configService.getCachePath(),
        configService.getImageXorKey(), configService.getImageAesKey(), configService.getExportPath(), configService.getSttLanguages(),
        configService.getSttModelType(), configService.getSttMode(), configService.getSttOnlineProvider(), configService.getSttOnlineApiKey(),
        configService.getSttOnlineBaseURL(), configService.getSttOnlineModel(), configService.getSttOnlineLanguage(), configService.getSttOnlineTimeoutMs(),
        configService.getSttOnlineMaxConcurrency(), configService.getSkipIntegrityCheck(), configService.getAutoUpdateDatabase(),
        configService.getAutoUpdateCheckInterval(), configService.getAutoUpdateMinInterval(), configService.getAutoUpdateDebounceTime(),
        configService.getQuoteStyle(), configService.getExportDefaultDateRange(),
        configService.getAiProvider(), configService.getAiApiKey(), configService.getAiModel(),
       configService.getCloseToTray(), configService.getHardwareAccelerationEnabled(), configService.getDiaryEnabled(),
     ])
     const { activeAccount, editingAccount } = await accountsPromise

      if (!editingAccount && savedKey) setDecryptKey(savedKey)
      if (!editingAccount && savedPath) setDbPath(savedPath)
      if (!editingAccount && savedWxid) setWxid(savedWxid)
      if (!editingAccount && savedCachePath) setCachePath(savedCachePath)
      if (!editingAccount && savedXorKey) setImageXorKey(savedXorKey)
      if (!editingAccount && savedAesKey) setImageAesKey(savedAesKey)
      setIsAccountVerified(Boolean((editingAccount || activeAccount)?.decryptKey && (editingAccount || activeAccount)?.dbPath && (editingAccount || activeAccount)?.wxid))
      if (savedExportPath) setExportPath(savedExportPath)
      if (savedSttLanguages && savedSttLanguages.length > 0) {
        setSttLanguagesState(savedSttLanguages)
      } else {
        setSttLanguagesState(['zh'])
      }
      setSttModelType(savedSttModelType)
      setSttMode(savedSttMode)
      setSttOnlineProvider(savedSttOnlineProvider)
      setSttOnlineApiKey(savedSttOnlineApiKey)
      setSttOnlineBaseURL(savedSttOnlineBaseURL)
      setSttOnlineModel(savedSttOnlineModel)
      setSttOnlineLanguage(savedSttOnlineLanguage)
      setSttOnlineTimeoutMs(savedSttOnlineTimeoutMs)
      setSttOnlineMaxConcurrency(savedSttOnlineMaxConcurrency)
      setSkipIntegrityCheck(savedSkipIntegrityCheck)
      setAutoUpdateDatabase(savedAutoUpdateDatabase)

      // 自动同步高级参数
      setAutoUpdateCheckInterval(savedCheckInterval)
      setAutoUpdateMinInterval(savedMinInterval)
      setAutoUpdateDebounceTime(savedDebounceTime)

      setQuoteStyle(savedQuoteStyle)
      setExportDefaultDateRange(savedExportDefaultDateRange)

      // AI 配置
      setAiProviderState(savedAiProvider)
      setAiApiKeyState(savedAiApiKey)
      setAiModelState(savedAiModel)

      // 关闭行为配置
      setCloseToTray(savedCloseToTray)

      // 保存初始配置用于比较
      const sourceAccount = editingAccount || activeAccount
      const loadedConfig = {
        decryptKey: savedKey || '',
        dbPath: savedPath || '',
        wxid: savedWxid || '',
        cachePath: savedCachePath || '',
        imageXorKey: savedXorKey || '',
        imageAesKey: savedAesKey || '',
        displayName: sourceAccount?.displayName || '',
        wechatNumber: sourceAccount?.wechatNumber || '',
        phone: sourceAccount?.phone || '',
        exportPath: savedExportPath || '',
        sttLanguages: savedSttLanguages && savedSttLanguages.length > 0 ? savedSttLanguages : ['zh'],
        sttModelType: savedSttModelType,
        sttMode: savedSttMode,
        sttOnlineProvider: savedSttOnlineProvider,
        sttOnlineApiKey: savedSttOnlineApiKey,
        sttOnlineBaseURL: savedSttOnlineBaseURL,
        sttOnlineModel: savedSttOnlineModel,
        sttOnlineLanguage: savedSttOnlineLanguage,
        sttOnlineTimeoutMs: savedSttOnlineTimeoutMs,
        sttOnlineMaxConcurrency: savedSttOnlineMaxConcurrency,
        skipIntegrityCheck: savedSkipIntegrityCheck,
        autoUpdateDatabase: savedAutoUpdateDatabase,
        autoUpdateCheckInterval: savedCheckInterval,
        autoUpdateMinInterval: savedMinInterval,
        autoUpdateDebounceTime: savedDebounceTime,
        quoteStyle: savedQuoteStyle,
        exportDefaultDateRange: savedExportDefaultDateRange,
        aiProvider: savedAiProvider,
        aiApiKey: savedAiApiKey,
        aiModel: savedAiModel,
       closeToTray: savedCloseToTray,
       hardwareAccelerationEnabled: savedHardwareAccelerationEnabled,
        diaryEnabled: savedDiaryEnabled,
       editingAccountId: (editingAccount || activeAccount)?.id || ''
      }
      hydrateSettings(loadedConfig)

    } catch (e) {
      console.error('加载配置失败:', e)
    }
  }

  const loadDefaultExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setDefaultExportPath(downloadsPath)
    } catch (e) {
      console.error('获取默认导出路径失败:', e)
    }
  }

  const loadAppVersion = async () => {
    try {
      const version = await window.electronAPI.app.getVersion()
      setAppVersion(version)
    } catch (e) {
      console.error('获取版本号失败:', e)
    }
  }

  const loadLogFiles = async () => {
    setIsLoadingLogs(true)
    try {
      const [filesResult, sizeResult, levelResult] = await Promise.all([
        window.electronAPI.log.getLogFiles(),
        window.electronAPI.log.getLogSize(),
        window.electronAPI.log.getLogLevel()
      ])

      if (filesResult.success && filesResult.files) {
        setLogFiles(filesResult.files)
      }

      if (sizeResult.success && sizeResult.size !== undefined) {
        setLogSize(sizeResult.size)
      }

      if (levelResult.success && levelResult.level) {
        setCurrentLogLevel(levelResult.level)
      }
    } catch (e) {
      console.error('获取日志文件失败:', e)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadLogContent = async (filename: string) => {
    if (!filename) return

    setIsLoadingLogContent(true)
    try {
      const result = await window.electronAPI.log.readLogFile(filename)
      if (result.success && result.content) {
        setLogContent(result.content)
      } else {
        setLogContent('无法读取日志文件')
      }
    } catch (e) {
      console.error('读取日志文件失败:', e)
      setLogContent('读取日志文件失败')
    } finally {
      setIsLoadingLogContent(false)
    }
  }

  const handleClearLogs = async () => {
    try {
      const result = await window.electronAPI.log.clearLogs()
      if (result.success) {
        showMessage('日志清除成功', true)
        setLogFiles([])
        setLogContent('')
        setSelectedLogFile('')
        setLogSize(0)
      } else {
        showMessage(result.error || '日志清除失败', false)
      }
    } catch (e) {
      showMessage(`日志清除失败: ${e}`, false)
    }
  }

  const handleLogFileSelect = (filename: string) => {
    setSelectedLogFile(filename)
    loadLogContent(filename)
  }

  const handleOpenLogDirectory = async () => {
    try {
      const result = await window.electronAPI.log.getLogDirectory()
      if (result.success && result.directory) {
        await window.electronAPI.shell.openPath(result.directory)
      }
    } catch (e) {
      showMessage('打开日志目录失败', false)
    }
  }

  const handleLogLevelChange = async (level: string) => {
    try {
      const result = await window.electronAPI.log.setLogLevel(level)
      if (result.success) {
        setCurrentLogLevel(level)
        showMessage(`日志级别已设置为 ${level}`, true)
      } else {
        showMessage(result.error || '设置日志级别失败', false)
      }
    } catch (e) {
      showMessage('设置日志级别失败', false)
    }
  }

  const syncUpdateState = async () => {
    try {
      const state = await window.electronAPI.app.getUpdateState?.()
      if (!state) return
      setUpdateInfo(state)
      const phase = state.diagnostics?.phase
      setIsDownloading(phase === 'downloading' || phase === 'installing')
      if (typeof state.diagnostics?.progressPercent === 'number') {
        setDownloadProgress(state.diagnostics.progressPercent)
      }
    } catch (error) {
      console.error('同步更新状态失败:', error)
    }
  }

  // 监听下载进度
  useEffect(() => {
    syncUpdateState()

    const removeListener = window.electronAPI.app.onDownloadProgress?.((progress: UpdateDownloadProgressPayload) => {
      setDownloadProgress(progress.percent)
      setDownloadProgressDetail(progress)
      setIsDownloading(true)
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
    return () => removeListener?.()
  }, [])

  const handleCheckUpdate = async () => {
    if (isDownloading || updateInfo?.diagnostics?.phase === 'installing') return
    setIsCheckingUpdate(true)
    try {
      const result = await window.electronAPI.app.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateInfo(result)
        showMessage(result.forceUpdate ? `检测到强制更新 ${result.version}` : `发现新版本 ${result.version}`, true)
      } else {
        showMessage('当前已是最新版本', true)
      }
    } catch (e) {
      showMessage(`检查更新失败: ${e}`, false)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const showMessage = (text: string, success: boolean) => {
    if (success) toast.success(text, { timeout: 3000 })
    else toast.danger(text, { timeout: 3000 })
  }

  const handleClearImages = () => {
    setShowClearDialog({
      type: 'images',
      title: '清除图片',
      message: '此操作将删除所有解密后的图片文件，清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearAllCache = () => {
    setShowClearDialog({
      type: 'all',
      title: '清除所有',
      message: '此操作将删除所有缓存数据（包括解密后的图片、表情包、日志和历史 AI 功能数据库），清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearEmojis = () => {
    setShowClearDialog({
      type: 'emojis',
      title: '清除表情包',
      message: '此操作将删除所有解密后的表情包缓存文件，清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearAIData = () => {
    setShowClearDialog({
      type: 'aiData',
      title: '清除 AI 数据',
      message: '此操作将删除历史 AI 摘要、AI 记忆、语义索引等功能产生的本地数据，不会删除 AI 接入配置、API Key、模型和服务地址。确定要继续吗？'
    })
  }

  const handleClearCurrentAccount = () => {
    setShowClearDialog({
      type: 'currentAccount',
      title: '清除当前账号',
      message: '此操作将清除当前账号的密钥、路径等配置，不影响其他账号。确定要继续吗？'
    })
  }

  const handleClearAllAccounts = () => {
    setShowClearDialog({
      type: 'allAccounts',
      title: '清空全部账号配置',
      message: '此操作将删除所有账号配置和账号级密钥/路径信息，不删除全局主题、AI、MCP、HTTP API 等通用设置。确定要继续吗？'
    })
  }

  const confirmClear = async () => {
    if (!showClearDialog) return

    try {
      let result
        switch (showClearDialog.type) {
          case 'images':
            result = await window.electronAPI.cache.clearImages()
            break
        case 'emojis':
          result = await window.electronAPI.cache.clearEmojis()
          break
        case 'aiData':
          result = await window.electronAPI.cache.clearAIData()
          break
          case 'all':
            result = await window.electronAPI.cache.clearAll()
            break
          case 'currentAccount':
            result = await window.electronAPI.cache.clearCurrentAccount(false)
            break
          case 'allAccounts':
            result = await window.electronAPI.cache.clearAllAccountConfigs()
            break
        }

        if (result.success) {
          showMessage(`${showClearDialog.title}成功`, true)
          if (showClearDialog.type === 'currentAccount' || showClearDialog.type === 'allAccounts') {
            await loadConfig()
          }
      } else {
        showMessage(result.error || `${showClearDialog.title}失败`, false)
      }
    } catch (e) {
      showMessage(`${showClearDialog.title}失败: ${e}`, false)
    } finally {
      setShowClearDialog(null)
    }
  }

  const handleUpdateNow = async () => {
    if (isDownloading) return
    setIsDownloading(true)
    setDownloadProgress(0)
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
    try {
      showMessage('正在下载更新...', true)
      await window.electronAPI.app.downloadAndInstall()
    } catch (e) {
      showMessage(`更新失败: ${e}`, false)
      setIsDownloading(false)
      await syncUpdateState()
    }
  }

  const handleGetKey = async () => {
    if (isGettingKey) return
    setIsGettingKey(true)
    setKeyStatus(isMac ? '正在准备 macOS helper...' : '正在检查微信进程...')

    try {
      if (isMac) {
        const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
          setKeyStatus(status)
        })

        const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
        removeListener()

        if (result.success && result.key) {
          setDecryptKey(result.key)

          if (dbPath) {
            const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
            if (resolved.success && resolved.wxid) {
              setWxid(resolved.wxid)
              setIsAccountVerified(true)
              showMessage(`密钥获取成功！已验证账号: ${resolved.wxid}`, true)
              setKeyStatus('')
              return
            }
          }

          if (result.validatedWxid) {
            setWxid(result.validatedWxid)
            setIsAccountVerified(true)
            showMessage(`密钥获取成功！已验证账号: ${result.validatedWxid}`, true)
            setKeyStatus('')
            return
          }

          setKeyStatus('正在检测当前登录账号...')

          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo) {
            setWxid(accountInfo.wxid)
            setIsAccountVerified(false)
            showMessage(`密钥获取成功！已识别候选账号: ${accountInfo.wxid}，请继续验证目录。`, true)
          } else {
            const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
            setWxidOptions(wxids)
            setIsAccountVerified(false)

            if (wxids.length === 1) {
              setWxid(wxids[0])
              showMessage('密钥获取成功，已识别到 1 个候选账号目录，请继续验证。', true)
            } else if (wxids.length > 1) {
              setShowWxidDropdown(true)
              showMessage(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证。`, true)
            } else {
              showMessage('密钥获取成功，请手动填写或扫描账号目录后继续验证。', true)
            }
          }

          setKeyStatus('')
        } else {
          showMessage(result.error || '获取密钥失败', false)
          setKeyStatus('')
        }

        return
      }

      const isRunning = await window.electronAPI.wxKey.isWeChatRunning()
      if (isRunning) {
        const shouldKill = window.confirm('检测到微信正在运行，需要重启微信才能获取密钥。\n是否关闭当前微信？')
        if (!shouldKill) {
          setKeyStatus('已取消')
          setIsGettingKey(false)
          return
        }
        setKeyStatus('正在关闭微信...')
        await window.electronAPI.wxKey.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      setKeyStatus('正在启动微信...')
      const launched = await window.electronAPI.wxKey.launchWeChat()
      if (!launched) {
        showMessage('微信启动失败，请检查安装路径', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      setKeyStatus('等待微信窗口加载...')
      const windowReady = await window.electronAPI.wxKey.waitForWindow(15)
      if (!windowReady) {
        showMessage('等待微信窗口超时', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
        setKeyStatus(status)
      })

      setKeyStatus('正在启动微信并扫描内存获取密钥...')
      const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
      removeListener()

      if (result.success && result.key) {
        setDecryptKey(result.key)

        // 自动检测当前登录的微信账号
        setKeyStatus('正在检测当前登录账号...')

        // 先尝试较短的时间范围（刚登录的情况）
        let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10) // 10分钟

        // 如果没找到，尝试更长的时间范围
        if (!accountInfo) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60) // 1小时
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          showMessage(`密钥获取成功！已自动绑定账号: ${accountInfo.wxid}`, true)
        } else {
          showMessage('密钥获取成功，已自动保存！（未能自动检测账号，请手动输入 wxid）', true)
        }
        setKeyStatus('')
      } else {
        showMessage(result.error || '获取密钥失败', false)
        setKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取密钥失败: ${e}`, false)
      setKeyStatus('')
    } finally {
      setIsGettingKey(false)
    }
  }

  const handleCancelGetKey = async () => {
    await window.electronAPI.wxKey.cancel()
    setIsGettingKey(false)
    setKeyStatus('')
  }

  const handleOpenWelcomeWindow = async () => {
    try {
      await window.electronAPI.window.openWelcomeWindow('add-account')
    } catch (e) {
      showMessage('打开引导窗口失败', false)
    }
  }

  const handleSelectAccountForEdit = (account: AccountProfile) => {
    applyAccountToForm(account)
    useSettingsStore.getState().setFields({
      decryptKey: account.decryptKey || '',
      dbPath: account.dbPath || '',
      wxid: account.wxid || '',
      cachePath: account.cachePath || '',
      imageXorKey: account.imageXorKey || '',
      imageAesKey: account.imageAesKey || '',
      editingAccountId: account.id
    })
    useSettingsStore.getState().commit()
  }

  const handleSwitchAccountAndReconnect = async () => {
    if (!editingAccountId || editingAccountId === activeAccountId) {
      showMessage('当前没有待切换账号', false)
      return
    }

    if (useSettingsStore.getState().hasUnsavedChanges) {
      showMessage('请先保存当前账号表单，再执行切换', false)
      return
    }

    const target = accountsList.find((item) => item.id === editingAccountId)
    if (!target) {
      showMessage('待切换账号不存在', false)
      return
    }

    if (!target.dbPath || !target.decryptKey || !target.wxid) {
      showMessage('待切换账号配置不完整，请先保存并补全账号信息', false)
      return
    }

    setIsLoadingState(true)
    setLoading(true, '正在切换账号...')
    try {
      const switched = await configService.setActiveAccount(target.id)
      if (!switched) {
        throw new Error('切换账号失败')
      }

      const result = await window.electronAPI.wcdb.testConnection(target.dbPath, target.decryptKey, target.wxid)
      if (!result.success) {
        throw new Error(result.error || '账号重连失败')
      }

      await window.electronAPI.chat.close()
      await window.electronAPI.chat.refreshCache()
      await window.electronAPI.chat.connect()
      setDbConnected(true, target.dbPath)
      setCurrentWxid(target.wxid)
      await refreshAccountsState(target.id)
      showMessage(`已切换到账号：${getAccountDisplayName(target)}`, true)
    } catch (e) {
      showMessage(`切换账号失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleDeleteAccount = (account: AccountProfile) => {
    setSecurityConfirm({
      show: true,
      title: '删除账号',
      message: `删除账号 ${getAccountDisplayName(account)}？此操作仅删除配置，不删除本地解密数据。`,
      onConfirm: async () => {
        const result = await configService.deleteAccount(account.id, false)
        if (result.success) {
          await refreshAccountsState(result.nextActiveAccountId)
          showMessage('账号已删除', true)
        } else {
          showMessage(result.error || '删除账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleDeleteAccountWithLocalData = (account: AccountProfile) => {
    setSecurityConfirm({
      show: true,
      title: '删除账号并清理本地数据',
      message: `将删除账号 ${getAccountDisplayName(account)} 的配置，并尝试删除该账号对应的本地解密数据库缓存。`,
      onConfirm: async () => {
        const result = await configService.deleteAccount(account.id, true)
        if (result.success) {
          await refreshAccountsState(result.nextActiveAccountId)
          showMessage('账号及其本地数据已删除', true)
        } else {
          showMessage(result.error || '删除账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleClearCurrentAccountConfig = (deleteLocalData = false) => {
    setSecurityConfirm({
      show: true,
      title: deleteLocalData ? '清除当前账号并删除本地数据' : '清除当前账号',
      message: deleteLocalData
        ? '将清除当前账号配置，并尝试删除该账号对应的本地解密数据库缓存。'
        : '将只清除当前账号配置，不影响其他账号和全局设置。',
      onConfirm: async () => {
        const result = await window.electronAPI.cache.clearCurrentAccount(deleteLocalData)
        if (result.success) {
          await refreshAccountsState(activeAccountId)
          showMessage('当前账号配置已清除', true)
        } else {
          showMessage(result.error || '清除当前账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleClearAllAccountConfigs = () => {
    setSecurityConfirm({
      show: true,
      title: '清空全部账号配置',
      message: '将删除所有账号配置和账号级密钥/路径信息，不会删除主题、AI、MCP、HTTP API 等通用设置。',
      onConfirm: async () => {
        const result = await window.electronAPI.cache.clearAllAccountConfigs()
        if (result.success) {
          await refreshAccountsState()
          await loadConfig()
          showMessage('已清空全部账号配置', true)
        } else {
          showMessage(result.error || '清空全部账号配置失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setWxid('')
        setWxidOptions([])
        setShowWxidDropdown(false)
        setIsAccountVerified(false)
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择缓存目录失败', false)
    }
  }

  const handleSelectExportPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择导出目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportPath(result.filePaths[0])
        await configService.setExportPath(result.filePaths[0])
        showMessage('已设置导出目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleResetExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportPath(downloadsPath)
      await configService.setExportPath(downloadsPath)
      showMessage('已恢复为下载目录', true)
    } catch (e) {
      showMessage('恢复默认失败', false)
    }
  }

  // 扫描 wxid
  const handleScanWxid = async () => {
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (isScanningWxid) return

    setIsScanningWxid(true)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setIsAccountVerified(false)
      if (wxids.length === 0) {
        showMessage('未检测到账号目录（需包含 db_storage 文件夹）', false)
        setWxidOptions([])
      } else if (wxids.length === 1) {
        // 只有一个账号，直接设置
        setWxid(wxids[0])
        showMessage(`已检测到候选账号目录：${wxids[0]}（待验证）`, true)
        setWxidOptions([])
        setShowWxidDropdown(false)
      } else {
        let selectedWxid = ''

        if (decryptKey.length === 64) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
            setWxid(selectedWxid)
          }
        }

        if (!selectedWxid) {
          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
            setWxid(selectedWxid)
          }
        }

        setWxidOptions(wxids)
        setShowWxidDropdown(true)
        showMessage(
          selectedWxid
            ? `检测到 ${wxids.length} 个候选账号目录，已按最新活动优先选择：${selectedWxid}`
            : `检测到 ${wxids.length} 个候选账号目录，请选择后验证`,
          true
        )
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      setIsScanningWxid(false)
    }
  }

  // 选择 wxid
  const handleSelectWxid = async (selectedWxid: string) => {
    setWxid(selectedWxid)
    setIsAccountVerified(false)
    setShowWxidDropdown(false)
    showMessage(`已选择候选账号目录：${selectedWxid}（待验证）`, true)
  }

  const handleVerifyAccountDirectory = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey || decryptKey.length !== 64) { showMessage('请先配置64位解密密钥', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        setIsAccountVerified(true)
        showMessage(`账号目录验证成功：${wxid}`, true)
      } else {
        setIsAccountVerified(false)
        showMessage(result.error || '账号目录验证失败，请更换目录重试', false)
      }
    } catch (e) {
      setIsAccountVerified(false)
      showMessage(`账号目录验证失败: ${e}`, false)
    } finally {
      setIsVerifyingAccount(false)
    }
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }
    if (!isAccountVerified) { showMessage('请先验证账号目录', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const handleSaveConfig = async () => {
    const storeConfig = useSettingsStore.getState().config
    useSettingsStore.getState().setSaving(true)
    setIsLoadingState(true)
    setLoading(true, '正在保存配置...')

    try {
      // 保存数据库相关配置
      let savedAccount: AccountProfile | null = null
      const accountPayload = {
        wxid: storeConfig.wxid.trim(),
        dbPath: storeConfig.dbPath.trim(),
        decryptKey: storeConfig.decryptKey.trim(),
        cachePath: storeConfig.cachePath.trim(),
        imageXorKey: storeConfig.imageXorKey.trim(),
        imageAesKey: storeConfig.imageAesKey.trim(),
        wechatNumber: storeConfig.wechatNumber.trim(),
        phone: storeConfig.phone.trim(),
        displayName: storeConfig.displayName.trim() || storeConfig.wxid.trim() || '未命名账号'
      }

      if (storeConfig.editingAccountId) {
        savedAccount = await configService.updateAccount(storeConfig.editingAccountId, accountPayload)
      } else if (accountPayload.wxid || accountPayload.dbPath || accountPayload.decryptKey || accountPayload.cachePath) {
        savedAccount = await configService.saveAccount(accountPayload)
      }

      if (savedAccount) {
        setEditingAccountId(savedAccount.id)
        useSettingsStore.getState().setField('editingAccountId', savedAccount.id)
      }

      // 保存图片密钥（包括空值）
      // 保存导出路径
      if (storeConfig.exportPath) await configService.setExportPath(storeConfig.exportPath)

      // 保存完整性检查设置
      await configService.setSkipIntegrityCheck(storeConfig.skipIntegrityCheck)
      // 保存自动更新设置
      await configService.setAutoUpdateDatabase(storeConfig.autoUpdateDatabase)
      // 保存自动同步高级参数
      await configService.setAutoUpdateCheckInterval(storeConfig.autoUpdateCheckInterval)
      await configService.setAutoUpdateMinInterval(storeConfig.autoUpdateMinInterval)
      await configService.setAutoUpdateDebounceTime(storeConfig.autoUpdateDebounceTime)

      // 保存引用样式
      await configService.setQuoteStyle(storeConfig.quoteStyle)

      // 保存导出默认设置
      await configService.setExportDefaultDateRange(storeConfig.exportDefaultDateRange)

      // 保存 AI 配置
      await configService.setAiProvider(storeConfig.aiProvider)
      await configService.setAiApiKey(storeConfig.aiApiKey)
      await configService.setAiModel(storeConfig.aiModel)

      await configService.setSttLanguages(storeConfig.sttLanguages)
      await configService.setSttModelType(storeConfig.sttModelType)
      await configService.setSttMode(storeConfig.sttMode)
      await configService.setSttOnlineProvider(storeConfig.sttOnlineProvider)
      await configService.setSttOnlineApiKey(storeConfig.sttOnlineApiKey)
      await configService.setSttOnlineBaseURL(storeConfig.sttOnlineBaseURL)
      await configService.setSttOnlineModel(storeConfig.sttOnlineModel)
      await configService.setSttOnlineLanguage(storeConfig.sttOnlineLanguage)
      await configService.setSttOnlineTimeoutMs(storeConfig.sttOnlineTimeoutMs)
      await configService.setSttOnlineMaxConcurrency(storeConfig.sttOnlineMaxConcurrency)

     // 保存关闭行为配置
     await configService.setCloseToTray(storeConfig.closeToTray)
     await configService.setHardwareAccelerationEnabled(storeConfig.hardwareAccelerationEnabled)

      // 保存日记功能开关
      await configService.setDiaryEnabled(storeConfig.diaryEnabled)

     // 如果数据库配置完整，尝试设置已连接状态（不进行耗时测试，仅标记）
      if (storeConfig.decryptKey && storeConfig.dbPath && storeConfig.wxid && storeConfig.decryptKey.length === 64 && isAccountVerified) {
        setDbConnected(true, storeConfig.dbPath)
      }

      await refreshAccountsState(savedAccount?.id || storeConfig.editingAccountId)

      showMessage('配置保存成功', true)
      
      // 保存成功后更新初始配置，重置变化状态
      commitSettings()
    } catch (e) {
      showMessage(`保存配置失败: ${e}`, false)
      useSettingsStore.getState().setSaving(false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  // 检查导航传递的更新信息
  useEffect(() => {
    if (location.state?.updateInfo) {
      setUpdateInfo(location.state.updateInfo)
      const phase = location.state.updateInfo.diagnostics?.phase
      setIsDownloading(phase === 'downloading' || phase === 'installing')
      if (typeof location.state.updateInfo.diagnostics?.progressPercent === 'number') {
        setDownloadProgress(location.state.updateInfo.diagnostics.progressPercent)
      }
    } else {
      syncUpdateState()
    }
  }, [location.state])

  return (
    <div className="settings-page">
      {/* 清除确认对话框 */}
      {showClearDialog && (
        <ConfirmDialog
          title={showClearDialog.title}
          message={showClearDialog.message}
          actions={(
            <>
              <button className="btn btn-danger" onClick={confirmClear}>
                确定
              </button>
              <button className="btn btn-secondary dialog-cancel" onClick={() => setShowClearDialog(null)}>
                取消
              </button>
            </>
          )}
        />
      )}

      {/* 账号操作确认对话框 */}
      {securityConfirm.show && (
        <ConfirmDialog
          title={securityConfirm.title}
          titleIcon={<CircleExclamation className="text-warning" width={20} height={20} color="#f59e0b" />}
          message={securityConfirm.message}
          actions={(
            <>
              <button className="btn btn-secondary" onClick={() => setSecurityConfirm(prev => ({ ...prev, show: false }))}>
                取消
              </button>
              <button className="btn btn-primary" onClick={securityConfirm.onConfirm}>
                确定
              </button>
            </>
          )}
        />
      )}

      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(key: HeroKey) => setActiveTab(String(key))}
        className="settings-tabs"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="设置分类">
            {tabs.map(tab => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                <tab.icon width={16} height={16} />
                {tab.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
            {pluginTabs.map(tab => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                <PlugConnection width={16} height={16} />
                {tab.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <ScrollShadow className="settings-body" hideScrollBar size={64}>
        {activeTab === 'appearance' && <AppearanceTab />}
        {activeTab === 'database' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <DatabaseTab showMessage={showMessage} />
          </Suspense>
        )}
        {activeTab === 'security' && <SecurityTab isMac={isMac} showMessage={showMessage} />}
        {activeTab === 'stt' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <SttTab active={activeTab === 'stt'} showMessage={showMessage} />
          </Suspense>
        )}
        {activeTab === 'ai' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <AISummarySettings showMessage={showMessage} />
          </Suspense>
        )}
        {activeTab === 'memory' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <MemoryTab showMessage={showMessage} />
          </Suspense>
        )}
        {activeTab === 'data' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <DataManagementTab
              showMessage={showMessage}
              reloadConfig={loadConfig}
              onClearCurrentAccountConfig={handleClearCurrentAccountConfig}
            />
          </Suspense>
        )}
        {activeTab === 'plugins' && (
          <Suspense fallback={<SettingsTabSkeleton />}>
            <PluginsTab showMessage={showMessage} />
          </Suspense>
        )}
        {activePluginTab && (
          <div className="h-[70vh] min-h-[400px]">
            <PluginHost pluginId={activePluginTab.pluginId} viewId={activePluginTab.view} />
          </div>
        )}
        {activeTab === 'activation' && <ActivationTab />}
        {activeTab === 'about' && (
          <AboutTab
            appVersion={appVersion}
            updateInfo={updateInfo}
            isDownloading={isDownloading}
            downloadProgress={downloadProgress}
            downloadProgressDetail={downloadProgressDetail}
            isCheckingUpdate={isCheckingUpdate}
            onUpdateNow={handleUpdateNow}
            onCheckUpdate={handleCheckUpdate}
          />
        )}
      </ScrollShadow>

      <FloatingSaveButton
        hasChanges={storeHasUnsavedChanges}
        onClick={handleSaveConfig}
        disabled={isLoading || storeIsSaving}
      />

    </div>
  )
}

export default SettingsLayout
