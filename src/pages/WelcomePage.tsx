import { useState, useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Chip,
  ComboBox,
  Description,
  Input,
  InputGroup,
  Label,
  ListBox,
  ProgressBar,
  ScrollShadow,
  Spinner,
  TextField,
  Tooltip,
  Typography
} from '@heroui/react'
import { ArrowLeft, ArrowRight, ArrowsRotateLeft, BookOpen, CircleCheck, Eye, EyeSlash, Fingerprint, FolderOpen, Lock, ShieldCheck, Sparkles } from '@gravity-ui/icons'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import { useAuthStore } from '../stores/authStore'
import './WelcomePage.css'

const GUIDE_URL = 'https://ilovebinglu.notion.site/ciphertalk'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: '定位微信数据目录' },
  { id: 'cache', title: '缓存目录', desc: '设置本地缓存存储位置' },
  { id: 'key', title: '解密密钥', desc: '获取密钥与自动识别账号' },
  { id: 'image', title: '图片密钥', desc: '获取 XOR 与 AES 密钥' },
  { id: 'security', title: '安全防护', desc: '配置应用锁保护隐私' },
  { id: 'decrypt', title: '连接数据库', desc: '直连 WCDB 并完成配置' }
]

interface WelcomePageProps {
  standalone?: boolean
}

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isDbConnected, setDbConnected, setMyWxid: setCurrentWxid } = useAppStore()
  const { enableAuth, disableAuth, isAuthEnabled } = useAuthStore()

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  // 内存提取到的账号字段：昵称 / 微信号 / 手机号（用于保存到账号档案）
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountPhone, setAccountPhone] = useState('')
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [error, setError] = useState('')

  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [isEnablingAuth, setIsEnablingAuth] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [showWechatPathPrompt, setShowWechatPathPrompt] = useState(false)
  const [customWechatPath, setCustomWechatPath] = useState('')
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [decryptStatus, setDecryptStatus] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [hasCache, setHasCache] = useState(false)
  const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({
    platform: 'win32',
    arch: 'x64'
  })
  const autoDetectDbPathAttemptedRef = useRef(false)

  const isMac = platformInfo.platform === 'darwin'
  const biometricLabel = isMac ? 'Touch ID' : 'Windows Hello'
  const isAddAccountMode = new URLSearchParams(location.search).get('mode') === 'add-account'

  useEffect(() => {
    const removeStatus = window.electronAPI.wxKey?.onStatus?.((payload) => {
      setDbKeyStatus(payload.status)
    })
    const removeImageProgress = window.electronAPI.imageKey?.onProgress?.((msg) => {
      setImageKeyStatus(msg)
    })

    void window.electronAPI.app.getPlatformInfo().then(setPlatformInfo).catch(() => {
      // ignore
    })

    // 请求通知权限
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    // 从缓存加载配置
    const loadCachedConfig = () => {
      if (isAddAccountMode) return
      try {
        const cached = localStorage.getItem('welcomeConfig')
        if (cached) {
          const config = JSON.parse(cached)
          if (config.dbPath) {
            setDbPath(config.dbPath)
            setHasCache(true)
          }
          if (config.cachePath) {
            setCachePath(config.cachePath)
          }
          if (config.wxid) {
            setWxid(config.wxid)
          }
          if (config.decryptKey) {
            setDecryptKey(config.decryptKey)
          }
          if (config.imageXorKey) {
            setImageXorKey(config.imageXorKey)
          }
          if (config.imageAesKey) {
            setImageAesKey(config.imageAesKey)
          }
        }
      } catch (e) {
        console.error('加载缓存配置失败:', e)
      }
    }
    loadCachedConfig()

    // 自动检测最佳缓存路径（如果缓存中没有）
    const initCachePath = async () => {
      if (!cachePath) {
        try {
          const result = await window.electronAPI.dbPath.getBestCachePath()
          if (result.success && result.path) {
            setCachePath(result.path)
          }
        } catch (e) {
          console.error('获取缓存路径失败:', e)
        }
      }
    }
    initCachePath()

    return () => {
      removeStatus?.()
      removeImageProgress?.()
    }
  }, [isAddAccountMode])

  useEffect(() => {
    setWxidOptions([])
    setIsAccountVerified(false)
    // 注意：不要清空 wxid，因为它可能是从缓存加载的
    // setWxid('')
  }, [dbPath])

  const verifyAccountDirectory = async (candidateWxid: string, key: string, silent = false) => {
    if (!dbPath || !candidateWxid || key.length !== 64) {
      setIsAccountVerified(false)
      return false
    }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, key, candidateWxid)
      if (result.success) {
        setIsAccountVerified(true)
        if (!silent) setDbKeyStatus(`账号目录验证成功：${candidateWxid}`)
        return true
      }

      setIsAccountVerified(false)
      if (!silent) setError(result.error || '账号目录验证失败，请重新选择')
      return false
    } catch (e) {
      setIsAccountVerified(false)
      if (!silent) setError(`账号目录验证失败: ${e}`)
      return false
    } finally {
      setIsVerifyingAccount(false)
    }
  }

  // 保存配置到缓存
  useEffect(() => {
    if (isAddAccountMode) return
    const config = {
      dbPath,
      cachePath,
      wxid,
      decryptKey,
      imageXorKey,
      imageAesKey
    }
    try {
      localStorage.setItem('welcomeConfig', JSON.stringify(config))
    } catch (e) {
      console.error('保存配置到缓存失败:', e)
    }
  }, [dbPath, cachePath, wxid, decryptKey, imageXorKey, imageAesKey, isAddAccountMode])

  const currentStep = steps[stepIndex]
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const progressValue = ((stepIndex + 1) / steps.length) * 100

  useEffect(() => {
    if (currentStep.id !== 'db') return
    if (dbPath) return
    if (autoDetectDbPathAttemptedRef.current) return

    autoDetectDbPathAttemptedRef.current = true
    void handleAutoDetectPath(true)
  }, [currentStep.id, dbPath])

  const handleOpenGuide = () => {
    void window.electronAPI.shell.openExternal(GUIDE_URL)
  }

  const handleResetCachePath = async () => {
    try {
      const result = await window.electronAPI.dbPath.getBestCachePath()
      if (result.success && result.path) {
        setCachePath(result.path)
      }
    } catch (e) {
      setError('获取默认缓存路径失败')
    }
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择目录失败')
    }
  }

  const handleAutoDetectPath = async (silent = false) => {
    if (isDetectingPath) return

    setIsDetectingPath(true)
    if (!silent) setError('')

    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        setError('')
        return
      }

      if (!silent) {
        setError(result.error || '未能自动检测到微信数据库目录')
      }
    } catch (e) {
      if (!silent) {
        setError(`自动检测失败: ${e}`)
      }
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleOpenDetectedPath = async () => {
    if (!dbPath) {
      setError('当前没有可打开的数据库目录')
      return
    }

    try {
      const result = await window.electronAPI.shell.openPath(dbPath)
      if (result) {
        setError(result)
      }
    } catch (e) {
      setError(`打开目录失败: ${e}`)
    }
  }



  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择缓存目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择缓存目录失败')
    }
  }

  const handleScanWxid = async (silent = false) => {
    if (!dbPath) {
      if (!silent) setError('请先选择数据库目录')
      return []
    }
    if (isScanningWxid) return []
    setIsScanningWxid(true)
    if (!silent) setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      setIsAccountVerified(false)
      if (wxids.length > 0) {
        let selectedWxid = ''

        if (decryptKey.length === 64) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
          }
        }

        if (!selectedWxid) {
          let accountInfo: { wxid: string; dbPath: string } | null = null
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
          }
        }

        if (!selectedWxid) {
          const wxidAccount = wxids.find(id => id.startsWith('wxid_'))
          selectedWxid = wxidAccount || wxids[0]
        }

        if (selectedWxid) {
          setWxid(selectedWxid)
          if (!silent) setError('')
        } else {
          if (!silent) setError('未能自动确定正确账号目录，请手动选择')
        }
      } else {
        if (!silent) setError('未检测到账号目录，请检查路径')
      }
      return wxids
    } catch (e) {
      if (!silent) setError(`扫描失败: ${e}`)
      return []
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async (wechatPath?: string) => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setError('')
    setDbKeyStatus('正在准备获取密钥...')
    try {
      const result = await window.electronAPI.wxKey.startGetKey(wechatPath, dbPath || undefined)
      if (result.success && result.key) {
        setDecryptKey(result.key)
        // 留存内存提取到的账号字段，保存账号时写入档案
        if (result.account) {
          setAccountName(result.account.name || '')
          setAccountNumber(result.account.number || '')
          setAccountPhone(result.account.phone || '')
        }
        setDbKeyStatus('密钥获取成功，正在验证账号目录...')
        setError('')
        setShowWechatPathPrompt(false)

        if (dbPath) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
          if (resolved.success && resolved.wxid) {
            setWxid(resolved.wxid)
            setIsAccountVerified(true)
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${resolved.wxid}`)
            return
          }
        }

        if (result.validatedWxid) {
          setWxid(result.validatedWxid)
          const acc = result.account
          const extra = acc && (acc.name || acc.number)
            ? `（${[acc.name && `昵称: ${acc.name}`, acc.number && `微信号: ${acc.number}`].filter(Boolean).join('，')}）`
            : ''
          setDbKeyStatus(`密钥获取成功，已验证账号目录: ${result.validatedWxid}${extra}`)
          return
        }

        // DLL 直接返回了 wxid：用它定位并验证账号目录，避免落到“扫描文件夹让用户选”
        if (result.account?.wxid) {
          setWxid(result.account.wxid)
          const ok = await verifyAccountDirectory(result.account.wxid, result.key, true)
          if (ok) {
            const a = result.account
            const extra = (a.name || a.number)
              ? `（${[a.name && `昵称: ${a.name}`, a.number && `微信号: ${a.number}`].filter(Boolean).join('，')}）`
              : ''
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${result.account.wxid}${extra}`)
            return
          }
        }

        // 先尝试当前登录账号检测（强信号）
        let accountInfo: { wxid: string; dbPath: string } | null = null
        if (dbPath) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          const ok = await verifyAccountDirectory(accountInfo.wxid, result.key, true)
          if (ok) {
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${accountInfo.wxid}`)
            return
          }
        }

        const wxids = await handleScanWxid(true)
        if (wxids.length > 1) {
          // 多账号时仅作为候选，等待用户选择后再验证
          setDbKeyStatus(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证`)
        } else if (wxids.length === 1) {
          const ok = await verifyAccountDirectory(wxids[0], result.key, true)
          setDbKeyStatus(ok ? '密钥获取成功，已自动识别并验证账号目录' : '密钥获取成功，请手动确认账号目录')
        } else {
          setDbKeyStatus('密钥获取成功，请手动选择并验证账号目录')
        }
      } else {
        if (result.needManualPath) {
          setShowWechatPathPrompt(true)
          setDbKeyStatus('需要手动选择微信安装位置')
        } else {
          setError(result.error || '自动获取密钥失败')
          setDbKeyStatus('')
        }
      }
    } catch (e) {
      setError(`自动获取密钥失败: ${e}`)
      setDbKeyStatus('')
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handleSelectWechatPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信程序 (Weixin.exe)',
        properties: ['openFile'],
        filters: [
          { name: '微信程序', extensions: ['exe'] }
        ]
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0]
        if (path.toLowerCase().endsWith('weixin.exe')) {
          setCustomWechatPath(path)
          setError('')
        } else {
          setError('请选择 Weixin.exe 文件')
        }
      }
    } catch (e) {
      setError('选择文件失败')
    }
  }

  const handleConfirmWechatPath = () => {
    if (!customWechatPath) {
      setError('请先选择微信程序')
      return
    }
    handleAutoGetDbKey(customWechatPath)
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.imageKey.getImageKeys(accountPath)
      if (result.success) {
        if (typeof result.xorKey === 'number') {
          setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        setImageKeyStatus('已获取图片密钥')

        // 发送系统通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('CipherTalk - 图片密钥获取成功', {
            body: '已成功获取图片密钥，可以继续下一步操作',
            icon: './logo.png'
          })
        }
      } else {
        setError(result.error || '自动获取图片密钥失败')
      }
    } catch (e) {
      setError(`自动获取图片密钥失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const canGoNext = () => {
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath)
    if (currentStep.id === 'cache') return Boolean(cachePath)
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(wxid) && isAccountVerified
    if (currentStep.id === 'image') return true
    if (currentStep.id === 'security') return true
    if (currentStep.id === 'decrypt') return false // 最后一步，不能下一步
    return false
  }

  const handleNext = () => {
    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      if (currentStep.id === 'cache' && !cachePath) setError('请填写缓存目录')
      if (currentStep.id === 'key') {
        if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
        else if (!wxid) setError('请先选择账号目录')
        else if (!isAccountVerified) setError('账号目录尚未验证，请先验证后继续')
      }
      return
    }
    setError('')
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleConfirm = async () => {
    if (!dbPath) { setError('请先选择数据库目录'); return }
    if (!wxid) { setError('请先选择账号目录'); return }
    if (!isAccountVerified) { setError('账号目录尚未验证，请先验证'); return }
    if (!decryptKey || decryptKey.length !== 64) { setError('请填写 64 位解密密钥'); return }

    setIsDecrypting(true)
    setError('')
    setDecryptStatus('正在保存配置...')

    try {
      const savedAccount = await configService.saveAccount({
        dbPath,
        decryptKey,
        wxid,
        cachePath,
        imageXorKey,
        imageAesKey,
        wechatNumber: accountNumber,
        phone: accountPhone,
        displayName: accountName || wxid || '未命名账号'
      })

      if (!savedAccount) {
        throw new Error('保存账号配置失败')
      }

      await configService.setActiveAccount(savedAccount.id)
      setCurrentWxid(wxid)

      setDecryptStatus('正在测试数据库连接...')

      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        setError(result.error || 'WCDB 连接失败')
        setDecryptStatus('')
        setIsDecrypting(false)
        return
      }

      setDecryptStatus('连接成功，配置保存完成...')

      setCountdown(3)
      for (let i = 3; i > 0; i--) {
        setCountdown(i)
        setDecryptStatus(`配置保存成功，${i} 秒后进入应用...`)

        if (i === 3) {
          try {
            localStorage.removeItem('welcomeConfig')
          } catch (e) {
            console.error('清除缓存配置失败:', e)
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      setDbConnected(true, dbPath)
      setCurrentWxid(wxid)

      if (standalone) {
        setIsClosing(true)
        setTimeout(() => {
          window.electronAPI.window.completeWelcome()
        }, 450)
      } else {
        navigate('/home')
      }
    } catch (e) {
      setError(`连接失败: ${e}`)
      setDecryptStatus('')
      setCountdown(0)
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleSelectWxidCandidate = (candidateWxid: string) => {
    setWxid(candidateWxid)
    setIsAccountVerified(false)
    if (decryptKey.length === 64) {
      void verifyAccountDirectory(candidateWxid, decryptKey)
    }
  }

  const handleEnterHome = () => {
    if (standalone) {
      setIsClosing(true)
      setTimeout(() => {
        window.electronAPI.window.completeWelcome()
      }, 450)
    } else {
      navigate('/home')
    }
  }

  const renderInfoList = (items: ReactNode[]) => (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2 text-sm leading-6 text-foreground">
          <CircleCheck width={15} height={15} className="mt-1 shrink-0 text-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )

  const renderStatusAlert = (message: string, status: 'default' | 'accent' | 'success' | 'warning' | 'danger' = 'default') => (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  )

  const renderTextField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      placeholder?: string
      description?: ReactNode
      type?: string
      suffix?: ReactNode
    } = {}
  ) => (
    <TextField fullWidth value={value} onChange={onChange}>
      <Label>{label}</Label>
      <InputGroup fullWidth variant="secondary">
        <InputGroup.Input type={options.type || 'text'} placeholder={options.placeholder} />
        {options.suffix && <InputGroup.Suffix className="pr-0">{options.suffix}</InputGroup.Suffix>}
      </InputGroup>
      {options.description ? <Description>{options.description}</Description> : null}
    </TextField>
  )

  const renderStepInfo = () => {
    if (currentStep.id === 'intro') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>准备开始</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            这个向导会完成数据库目录、缓存目录、密钥和本地连接配置。
          </Typography.Paragraph>
          {renderInfoList(['数据仅在本地处理', '不上传聊天记录或密钥', '完成后直接进入主应用'])}
        </div>
      )
    }

    if (currentStep.id === 'db') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>数据库目录</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            系统会优先自动识别当前设备上的微信数据存储目录。
          </Typography.Paragraph>
          {renderInfoList([
            '进入本步骤后会先尝试自动检测',
            '检测到结果后可直接打开文件夹确认',
            isMac ? '未命中时手动选择版本目录或账号目录' : '未命中时按微信存储位置手动选择'
          ])}
          {!isMac && renderStatusAlert('目录路径不可包含中文，如有中文请先在微信中迁移到英文目录。', 'warning')}
        </div>
      )
    }

    if (currentStep.id === 'cache') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>缓存目录</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            缓存目录用于存储头像、表情与图片等本地媒体缓存。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '默认使用文稿目录下的 CipherTalkData' : '自动选择更适合存储的磁盘',
            '需要预留足够空间',
            '后续仍可在设置中修改'
          ])}
        </div>
      )
    }

    if (currentStep.id === 'key') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>解密密钥</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            此步骤会在本机完成密钥识别与账号目录校验。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '建议先启动微信并按提示完成授权' : '点击自动获取后按提示登录微信',
            '识别完成后会尝试匹配账号目录',
            '密钥仅保存在本地配置中'
          ])}
          {renderStatusAlert(isMac ? '若系统环境不满足要求，界面会直接给出提示。' : '密钥不会上传到服务器。', 'default')}
        </div>
      )
    }

    if (currentStep.id === 'image') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>图片密钥</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            图片密钥用于解密微信图片，可自动获取，也可以稍后手动填写。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '优先通过 kvcomm 码和模板文件推导' : '通过 Rust native 扫描微信进程内存',
            isMac ? 'kvcomm 失败时再回退到进程内存扫描' : '请先在电脑微信中打开几张图片',
            '此步骤可跳过'
          ])}
        </div>
      )
    }

    if (currentStep.id === 'security') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>安全防护</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            应用锁是可选项，用于在启动应用时增加一道系统验证。
          </Typography.Paragraph>
          {renderInfoList([
            `使用 ${biometricLabel} 进行认证`,
            isMac ? '设备不支持时可跳过后改用密码' : '支持面部识别、指纹或 PIN 码',
            '适合共享设备或公共电脑'
          ])}
          {renderStatusAlert('推荐开启，但不会影响继续完成初始化。', 'success')}
        </div>
      )
    }

    return (
      <div className="flex min-w-0 flex-col gap-3.5">
        <Typography.Heading level={4}>连接数据库</Typography.Heading>
        <Typography.Paragraph size="sm" color="muted">
          最后一步会保存账号配置，并测试本地 WCDB 直连。
        </Typography.Paragraph>
        {renderInfoList(['验证数据库目录、账号目录和密钥', '连接成功后保存当前账号配置', '完成后自动进入主应用'])}
        {renderStatusAlert('请确认前面的必填项都已正确配置。', 'warning')}
      </div>
    )
  }

  const renderDbStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {hasCache && renderStatusAlert('已从缓存加载配置数据。', 'success')}
      {renderTextField('数据库根目录', dbPath, setDbPath, {
        placeholder: isMac
          ? '~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
          : 'C:\\Users\\xxx\\Documents\\xwechat_files',
        description: isMac ? '请选择微信版本目录或账号根目录。' : '请选择微信-设置-存储位置对应的目录。'
      })}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button className="min-w-33 justify-center" type="button" variant="primary" onPress={() => void handleAutoDetectPath()} isPending={isDetectingPath}>
          <span className="grid size-4 shrink-0 place-items-center">
            {isDetectingPath ? <Spinner size="sm" color="current" /> : <Sparkles width={16} height={16} />}
          </span>
          <span className="min-w-[5em] text-left">{isDetectingPath ? '自动检测中' : '自动检测'}</span>
        </Button>
        <Button type="button" variant="secondary" onPress={() => void handleSelectPath()}>
          <FolderOpen width={16} height={16} /> 浏览选择目录
        </Button>
        {dbPath && (
          <Button type="button" variant="tertiary" onPress={() => void handleOpenDetectedPath()}>
            <FolderOpen width={16} height={16} /> 打开此文件夹
          </Button>
        )}
      </div>
      {!isMac && renderStatusAlert('目录路径不可包含中文。如有中文，请在微信设置中更改存储位置并迁移至英文目录。', 'warning')}
    </div>
  )

  const renderCacheStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {renderTextField('缓存目录', cachePath, setCachePath, {
        placeholder: isMac ? '~/Documents/CipherTalkData' : 'D:\\CipherTalkDB',
        description: isMac ? '用于头像、表情与图片缓存，默认已选文稿目录。' : '用于头像、表情与图片缓存，已自动选择最佳磁盘。'
      })}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="button" variant="primary" onPress={() => void handleSelectCachePath()}>
          <FolderOpen width={16} height={16} /> 浏览选择
        </Button>
        <Button type="button" variant="secondary" onPress={() => void handleResetCachePath()}>
          <ArrowsRotateLeft width={16} height={16} /> 恢复默认
        </Button>
      </div>
    </div>
  )

  const renderKeyStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <ComboBox
        allowsCustomValue
        className="w-full"
        defaultFilter={() => true}
        fullWidth
        inputValue={wxid}
        menuTrigger="manual"
        selectedKey={wxidOptions.includes(wxid) ? wxid : null}
        onInputChange={(value) => {
          setWxid(value.trim())
          setIsAccountVerified(false)
        }}
        onSelectionChange={(key) => {
          if (key != null) handleSelectWxidCandidate(String(key))
        }}
      >
        <Label>账号目录</Label>
        <ComboBox.InputGroup>
          <Input placeholder="获取密钥后将自动填充" />
          {wxidOptions.length > 0 && <ComboBox.Trigger />}
        </ComboBox.InputGroup>
        <Description>
          <span className="inline-flex flex-wrap items-center gap-2">
            状态：
            <Chip size="sm" variant="soft" color={isAccountVerified ? 'success' : 'warning'}>
              <Chip.Label>{isAccountVerified ? '已验证' : '未验证'}</Chip.Label>
            </Chip>
            {wxidOptions.length > 0 && (
              <span className="text-muted">检测到 {wxidOptions.length} 个候选，可展开选择。</span>
            )}
          </span>
        </Description>
        {wxidOptions.length > 0 && (
          <ComboBox.Popover className="max-h-56 overflow-auto" placement="bottom start">
            <ListBox aria-label="候选账号目录">
              {wxidOptions.map((id) => (
                <ListBox.Item key={id} id={id} textValue={id}>
                  <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                    <FolderOpen width={16} height={16} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Label className="truncate">{id}</Label>
                    <Description>
                      {wxid === id
                        ? isAccountVerified ? '已验证，可继续下一步' : '当前选择，等待验证'
                        : decryptKey.length === 64 ? '选择后自动验证' : '选择后填入密钥再验证'}
                    </Description>
                  </div>
                  {wxid === id && (
                    <Chip color={isAccountVerified ? 'success' : 'warning'} variant="soft" size="sm" className="shrink-0">
                      <Chip.Label>{isAccountVerified ? '已验证' : '当前'}</Chip.Label>
                    </Chip>
                  )}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        )}
      </ComboBox>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          type="button"
          variant="secondary"
          onPress={() => void verifyAccountDirectory(wxid, decryptKey)}
          isDisabled={isVerifyingAccount || !wxid || decryptKey.length !== 64}
          isPending={isVerifyingAccount}
        >
          {isVerifyingAccount ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
          {isVerifyingAccount ? '验证中' : '验证账号目录'}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          onPress={() => void handleScanWxid()}
          isDisabled={!dbPath || isScanningWxid}
          isPending={isScanningWxid}
        >
          {isScanningWxid ? <Spinner size="sm" color="current" /> : <FolderOpen width={16} height={16} />}
          扫描账号目录
        </Button>
      </div>

      {renderTextField('解密密钥', decryptKey, (value) => setDecryptKey(value.trim()), {
        placeholder: '64 位十六进制密钥',
        type: showDecryptKey ? 'text' : 'password',
        suffix: (
          <Tooltip delay={0}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={showDecryptKey ? '隐藏密钥' : '显示密钥'}
              onPress={() => setShowDecryptKey(!showDecryptKey)}
            >
              {showDecryptKey ? <EyeSlash width={16} height={16} /> : <Eye width={16} height={16} />}
            </Button>
            <Tooltip.Content>{showDecryptKey ? '隐藏密钥' : '显示密钥'}</Tooltip.Content>
          </Tooltip>
        )
      })}

      <Button
        type="button"
        variant="secondary"
        className="self-start"
        onPress={() => void handleAutoGetDbKey()}
        isPending={isFetchingDbKey}
      >
        {isFetchingDbKey ? <Spinner size="sm" color="current" /> : <Sparkles width={16} height={16} />}
        {isFetchingDbKey ? '获取中' : '自动获取密钥'}
      </Button>

      {!isMac && showWechatPathPrompt && (
        <Card variant="secondary" className="w-full">
          <Card.Header>
            <Card.Title>选择微信程序</Card.Title>
            <Card.Description>未能自动找到微信安装位置，请手动选择 Weixin.exe。</Card.Description>
          </Card.Header>
          <Card.Content className="flex min-w-0 flex-col gap-3.5">
            {renderTextField('微信程序路径', customWechatPath, setCustomWechatPath, {
              placeholder: 'C:\\Program Files\\Tencent\\WeChat\\Weixin.exe'
            })}
            <div className="flex flex-wrap items-center gap-2.5">
              <Button type="button" variant="secondary" onPress={() => void handleSelectWechatPath()}>
                <FolderOpen width={16} height={16} /> 浏览选择
              </Button>
              <Button type="button" variant="primary" onPress={handleConfirmWechatPath}>
                确认并继续
              </Button>
            </div>
          </Card.Content>
        </Card>
      )}

      {dbKeyStatus && renderStatusAlert(dbKeyStatus, isAccountVerified ? 'success' : 'default')}
      {renderStatusAlert(
        isMac
          ? '获取密钥会调用 mac helper，并尝试识别候选账号目录。macOS 可能需要管理员授权。'
          : '点击自动获取后，程序会自动重启微信并扫描内存获取密钥，请耐心等待；如弹出微信登录请完成登录。',
        'default'
      )}
    </div>
  )

  const renderImageStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {renderTextField('图片 XOR 密钥', imageXorKey, setImageXorKey, {
        placeholder: '例如：0xA4'
      })}
      {renderTextField('图片 AES 密钥', imageAesKey, setImageAesKey, {
        placeholder: '16 位密钥'
      })}
      <Button
        type="button"
        variant="secondary"
        className="self-start"
        onPress={() => void handleAutoGetImageKey()}
        isDisabled={isFetchingImageKey}
        isPending={isFetchingImageKey}
      >
        {isFetchingImageKey ? <Spinner size="sm" color="current" /> : <Sparkles width={16} height={16} />}
        {isFetchingImageKey ? '获取中' : '自动获取图片密钥'}
      </Button>
      {imageKeyStatus && renderStatusAlert(imageKeyStatus, 'default')}
      {isFetchingImageKey && renderStatusAlert(isMac ? '正在尝试 kvcomm / 内存扫描，请稍候。' : '正在通过 Rust native 扫描微信内存，请稍候。', 'accent')}
      <Description>{isMac ? '优先从 kvcomm 和模板文件推导，失败后回退到内存扫描。' : 'Windows 使用 Rust native 内存扫描；如获取失败，请先在电脑微信中打开查看几张图片后重试。'}</Description>
    </div>
  )

  const renderSecurityStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Card variant="secondary" className="w-full">
        <Card.Header className="flex-row items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              {isMac ? <Lock width={28} height={28} /> : <Fingerprint width={28} height={28} />}
            </div>
            <div className="min-w-0">
              <Card.Title>{biometricLabel} 认证</Card.Title>
              <Card.Description>
                {isMac ? '启用 Touch ID 以保护您的数据。' : '启用 Windows Hello 以保护您的数据。'}
              </Card.Description>
            </div>
          </div>
          {isAuthEnabled && (
            <Chip size="sm" variant="soft" color="success">
              <CircleCheck width={12} height={12} />
              <Chip.Label>已启用</Chip.Label>
            </Chip>
          )}
        </Card.Header>
        <Card.Content>
          <Description>
            {isMac ? '启用后，每次打开应用都需要进行系统 Touch ID 验证。' : '启用后，每次打开应用都需要进行生物识别或 PIN 码验证。'}
          </Description>
        </Card.Content>
        <Card.Footer className="flex-wrap gap-2">
          {!isAuthEnabled ? (
            <Button
              type="button"
              variant="primary"
              onPress={async () => {
                setIsEnablingAuth(true)
                setAuthStatus(`正在等待${biometricLabel}验证...`)
                const result = await enableAuth()
                setIsEnablingAuth(false)
                if (result.success) {
                  setAuthStatus('已成功启用认证保护')
                } else {
                  setError(result.error || '启用失败')
                  setAuthStatus('')
                }
              }}
              isPending={isEnablingAuth}
            >
              {isEnablingAuth ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
              {isEnablingAuth ? '正在配置' : '启用应用锁'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="danger"
              onPress={async () => {
                await disableAuth()
                setAuthStatus('')
              }}
            >
              关闭保护
            </Button>
          )}
        </Card.Footer>
      </Card>
      {authStatus && renderStatusAlert(authStatus, 'success')}
    </div>
  )

  const renderSummaryItem = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3.5 border-b border-dashed border-border py-2.5 last:border-b-0">
      <span className="text-[13px] text-muted">{label}</span>
      <strong className="break-all text-right font-mono text-[13px] font-semibold text-foreground">{value}</strong>
    </div>
  )

  const renderDecryptStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Card variant="secondary" className="w-full">
        <Card.Header>
          <Card.Title>配置摘要</Card.Title>
          <Card.Description>确认无误后连接数据库。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-0">
          {renderSummaryItem('数据库目录', dbPath || '未设置')}
          {renderSummaryItem('缓存目录', cachePath || '未设置')}
          {renderSummaryItem('账号目录', wxid ? `${wxid}${isAccountVerified ? '（已验证）' : '（未验证）'}` : '未设置')}
          {renderSummaryItem('解密密钥', decryptKey ? '已设置 (64位)' : '未设置')}
          {renderSummaryItem('图片密钥', imageXorKey || imageAesKey ? '已设置' : '未设置（可选）')}
        </Card.Content>
      </Card>
      <Button type="button" variant="primary" fullWidth onPress={() => void handleConfirm()} isPending={isDecrypting}>
        {isDecrypting ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
        {isDecrypting ? '连接中' : '连接数据库'}
      </Button>
      {decryptStatus && countdown === 0 && renderStatusAlert(decryptStatus, 'accent')}
      {!isDecrypting && !decryptStatus && <Description className="text-center">点击连接数据库后，系统将验证配置并直连 WCDB。</Description>}
    </div>
  )

  const renderStepForm = () => {
    if (currentStep.id === 'intro') {
      return (
        <div className="flex min-h-82.5 flex-col items-center justify-center gap-3.5 text-center">
          <div className="grid size-18 place-items-center rounded-lg bg-accent-soft text-accent">
            <Sparkles width={34} height={34} />
          </div>
          <Typography.Heading level={3}>点击下一步开始配置</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">整个过程大约需要 3-5 分钟。</Typography.Paragraph>
        </div>
      )
    }
    if (currentStep.id === 'db') return renderDbStep()
    if (currentStep.id === 'cache') return renderCacheStep()
    if (currentStep.id === 'key') return renderKeyStep()
    if (currentStep.id === 'image') return renderImageStep()
    if (currentStep.id === 'security') return renderSecurityStep()
    return renderDecryptStep()
  }

  if (isDbConnected && !isAddAccountMode) {
    return (
      <div className={rootClassName}>
        <div className="welcome-shell z-1 flex h-[min(700px,calc(100vh-40px))] w-[min(1080px,calc(100vw-48px))] flex-col gap-3">
          <Card className="m-auto w-[min(420px,100%)] items-center p-6 pt-9 text-center">
            <div className="grid size-20 place-items-center rounded-lg bg-accent-soft text-accent">
              <CircleCheck width={48} height={48} />
            </div>
            <Card.Header className="items-center text-center">
              <Card.Title>已连接数据库</Card.Title>
              <Card.Description>配置已完成，可以开始使用了。</Card.Description>
            </Card.Header>
            <Card.Footer className="justify-center">
              <Button type="button" variant="primary" size="lg" onPress={handleEnterHome}>
              进入首页
              </Button>
            </Card.Footer>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
      {/* 全屏倒计时覆盖层 */}
      {countdown > 0 && (
        <div className="countdown-overlay">
          <div className="countdown-content">
            <div className="countdown-number-large">{countdown}</div>
            <div className="countdown-text-large">秒后进入应用</div>
          </div>
        </div>
      )}

      <div className="welcome-shell z-1 flex h-[min(700px,calc(100vh-40px))] w-[min(1080px,calc(100vw-48px))] flex-col gap-3">
        <Card className="shrink-0">
          <Card.Content className="grid grid-cols-[minmax(260px,0.78fr)_minmax(360px,1fr)] items-center gap-6 pb-2 max-[940px]:grid-cols-1">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <img src="./logo.png" alt="CipherTalk" className="size-11 shrink-0 rounded-lg shadow-[0_10px_24px_color-mix(in_oklch,var(--foreground)_12%,transparent)]" />
                <div className="min-w-0">
                  <Typography.Heading level={3} className="truncate">CipherTalk 初始化</Typography.Heading>
                  <Typography.Paragraph size="sm" color="muted" className="truncate">{currentStep.desc}</Typography.Paragraph>
                </div>
              </div>
              <Button type="button" variant="secondary" size="sm" onPress={handleOpenGuide} className="shrink-0">
                <BookOpen width={16} height={16} />
                使用教程
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Chip color="accent" variant="soft" size="sm">
                  <Chip.Label>{stepIndex + 1} / {steps.length}</Chip.Label>
                </Chip>
                <Typography.Paragraph size="sm" weight="medium">{currentStep.title}</Typography.Paragraph>
              </div>
              <ProgressBar aria-label="初始化进度" value={progressValue} valueLabel={`${Math.round(progressValue)}%`}>
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
            </div>
          </Card.Content>
          <div className="grid grid-cols-7 gap-2 px-4 pb-4">
            {steps.map((step, index) => {
              const active = index === stepIndex
              const done = index < stepIndex
              return (
                <Tooltip key={step.id} delay={0}>
                  <div
                    className={`grid h-7.5 min-w-0 place-items-center rounded-lg border text-xs font-bold transition-colors ${
                      done
                        ? 'border-success bg-success text-success-foreground'
                        : active
                          ? 'border-accent bg-accent text-accent-foreground'
                          : 'border-border bg-surface-secondary text-muted'
                    }`}
                  >
                    {done ? <CircleCheck width={14} height={14} /> : index + 1}
                  </div>
                  <Tooltip.Content>{step.title}</Tooltip.Content>
                </Tooltip>
              )
            })}
          </div>
        </Card>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.86fr)_minmax(440px,1.14fr)] gap-3 max-[940px]:grid-cols-1">
          <Card className="flex min-h-0 flex-col max-[940px]:hidden">
            <Card.Header>
              <Card.Title>{currentStep.title}</Card.Title>
              <Card.Description>{currentStep.desc}</Card.Description>
            </Card.Header>
            <Card.Content className="min-h-0">
              <ScrollShadow hideScrollBar className="h-full min-h-0" size={64}>
                {renderStepInfo()}
              </ScrollShadow>
            </Card.Content>
            <Card.Footer>
              <Chip size="sm" variant="soft" color="success">
                <ShieldCheck width={12} height={12} />
                <Chip.Label>仅本地处理</Chip.Label>
              </Chip>
            </Card.Footer>
          </Card>

          <Card className="flex min-h-0 flex-col">
            <Card.Header className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <Card.Title>{currentStep.title}</Card.Title>
                <Card.Description>{currentStep.desc}</Card.Description>
              </div>
              <Chip size="sm" variant="soft" color={canGoNext() || currentStep.id === 'decrypt' ? 'accent' : 'warning'}>
                <Chip.Label>{currentStep.id === 'decrypt' ? '最终确认' : canGoNext() ? '可继续' : '待完成'}</Chip.Label>
              </Chip>
            </Card.Header>
            <Card.Content className="min-h-0">
              <ScrollShadow hideScrollBar className="h-full min-h-0 pr-0.5" size={56}>
                {renderStepForm()}
              </ScrollShadow>
            </Card.Content>
            {error && (
              <div className="px-4 pb-3">
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              </div>
            )}
            <Card.Footer className="flex shrink-0 justify-between gap-3">
              <Button type="button" variant="tertiary" onPress={handleBack} isDisabled={stepIndex === 0 || isDecrypting}>
                <ArrowLeft width={16} height={16} /> 上一步
              </Button>
              {stepIndex < steps.length - 1 && (
                <Button type="button" variant="primary" onPress={handleNext} isDisabled={!canGoNext()}>
                  下一步 <ArrowRight width={16} height={16} />
                </Button>
              )}
            </Card.Footer>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage
