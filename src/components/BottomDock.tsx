import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import { House, Comment, Database, Gear, ArrowDownToLine, Aperture, FaceRobot, LogoMcp, PersonGear, BookOpen, Ghost } from '@gravity-ui/icons'
import type { IconComponent } from '@/types/icon'
import MacOSDock, { type DockApp } from '@/components/ui/mac-os-dock'
import { useThemeStore } from '@/stores/themeStore'
import { useDeviceConnectStatus } from '@/hooks/useDeviceConnectStatus'
import { DeviceConnectStatusDot } from '@/components/DeviceConnectStatusDot'
import DeviceConnectDialog from '@/components/DeviceConnectDialog'

const HIDE_DELAY = 2500
const EDGE_TRIGGER_PX = 8
const WECHAT_LOGO_SRC = './微信logo.png'

// 无背景图标：白色线条 + 细黑描边（四向 drop-shadow 叠出黑边），在玻璃上仍有对比
function AppIcon({ Icon }: { Icon: IconComponent }) {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <Icon
        className="w-[76%] h-[76%] text-white"
        strokeWidth={2}
        style={{
          filter:
            'drop-shadow(0 1px 0 rgba(0,0,0,0.75)) drop-shadow(0 -1px 0 rgba(0,0,0,0.55)) drop-shadow(1px 0 0 rgba(0,0,0,0.55)) drop-shadow(-1px 0 0 rgba(0,0,0,0.55))'
        }}
      />
    </div>
  )
}

const makeIcon = (Icon: IconComponent): ReactNode => <AppIcon Icon={Icon} />

function BottomDock() {
  const navigate = useNavigate()
  const location = useLocation()
  const autoHideSetting = useThemeStore(s => s.dockAutoHide)
  const deviceStatus = useDeviceConnectStatus()
  // 首页强制显示 Dock：避免用户进入软件后找不到导航
  const autoHide = autoHideSetting && location.pathname !== '/home'
  const [visible, setVisible] = useState(true)
  const [deviceConnectOpen, setDeviceConnectOpen] = useState(false)
  const [diaryEnabled, setDiaryEnabled] = useState(true)
  const hideTimerRef = useRef<number | undefined>(undefined)

  // 与侧边栏一致：日记项受 diaryEnabled 配置控制，关闭时不显示
  useEffect(() => {
    let mounted = true
    window.electronAPI.config.get('diaryEnabled')
      .then((value) => { if (mounted) setDiaryEnabled(value !== false) })
      .catch(() => undefined)
    const off = window.electronAPI.config.onChanged(({ key, value }) => {
      if (key === 'diaryEnabled') setDiaryEnabled(value !== false)
    })
    return () => { mounted = false; off() }
  }, [])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== undefined) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = undefined
    }
  }, [])

  const scheduleHide = useCallback(() => {
    if (!autoHide) return
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => setVisible(false), HIDE_DELAY)
  }, [autoHide, clearHideTimer])

  // 自动收起开关变化时重置状态
  useEffect(() => {
    clearHideTimer()
    if (autoHide) {
      setVisible(true)
      scheduleHide()
    } else {
      setVisible(true)
    }
    return clearHideTimer
  }, [autoHide, clearHideTimer, scheduleHide])

  // 鼠标接近屏幕底部时浮出
  useEffect(() => {
    if (!autoHide) return
    const handler = (e: MouseEvent) => {
      if (e.clientY >= window.innerHeight - EDGE_TRIGGER_PX) {
        clearHideTimer()
        setVisible(true)
        scheduleHide()
      }
    }
    window.addEventListener('mousemove', handler)
    return () => window.removeEventListener('mousemove', handler)
  }, [autoHide, clearHideTimer, scheduleHide])

  const handleMouseEnter = () => {
    clearHideTimer()
    setVisible(true)
  }

  const handleMouseLeave = () => {
    scheduleHide()
  }

  const openChatWindow = async () => {
    try { await window.electronAPI.window.openChatWindow() }
    catch (e) { console.error('打开聊天窗口失败:', e) }
  }

  const openMomentsWindow = async () => {
    try { await window.electronAPI.window.openMomentsWindow() }
    catch (e) { console.error('打开朋友圈窗口失败:', e) }
  }

  // 顺序与侧边栏导航一致（Sidebar.tsx navItems + 底部 ClawLink/设置）
  const allApps: DockApp[] = [
    { id: 'home', name: '首页', icon: makeIcon(House) },
    { id: 'agent', name: 'CT-Agent', icon: makeIcon(FaceRobot) },
    { id: 'personas', name: 'AI 克隆', icon: makeIcon(PersonGear) },
    { id: 'diary', name: '日记', icon: makeIcon(BookOpen) },
    { id: 'pets', name: 'AI 宠物', icon: makeIcon(Ghost) },
    { id: 'chat', name: '聊天查看', icon: makeIcon(Comment) },
    { id: 'moments', name: '朋友圈', icon: makeIcon(Aperture) },
    { id: 'export', name: '导出数据', icon: makeIcon(ArrowDownToLine) },
    { id: 'data-management', name: '数据管理', icon: makeIcon(Database) },
    { id: 'mcp', name: 'MCP & Skills', icon: makeIcon(LogoMcp) },
    { id: 'settings', name: '设置', icon: makeIcon(Gear) },
    { id: 'device-connect', name: 'ClawLink', icon: (
      <div className="relative w-full h-full p-1">
        <img src={WECHAT_LOGO_SRC} alt="微信" className="h-full w-full object-contain" />
        <DeviceConnectStatusDot status={deviceStatus} className="absolute right-[4%] top-[4%] size-[26%] ring-2 ring-white" />
      </div>
    ) },
  ]
  const apps = diaryEnabled ? allApps : allApps.filter(app => app.id !== 'diary')

  const handleAppClick = (appId: string) => {
    switch (appId) {
      case 'home': navigate('/home'); break
      case 'agent': navigate('/agent'); break
      case 'personas': navigate('/personas'); break
      case 'diary': navigate('/diary'); break
      case 'pets': navigate('/pets'); break
      case 'chat': void openChatWindow(); break
      case 'moments': void openMomentsWindow(); break
      case 'device-connect': setDeviceConnectOpen(true); break
      case 'export': navigate('/export'); break
      case 'data-management': navigate('/data-management'); break
      case 'mcp': navigate('/mcp'); break
      case 'settings': navigate('/settings'); break
    }
  }

  return (
    <>
      <motion.div
        className="fixed inset-x-0 bottom-0 z-40 pointer-events-none flex justify-center"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
        animate={{
          y: visible ? 0 : 140,
          opacity: visible ? 1 : 0
        }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <div
          className={visible ? 'pointer-events-auto' : 'pointer-events-none'}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <MacOSDock apps={apps} onAppClick={handleAppClick} />
        </div>
      </motion.div>
      <DeviceConnectDialog isOpen={deviceConnectOpen} onClose={() => setDeviceConnectOpen(false)} />
    </>
  )
}

export default BottomDock
