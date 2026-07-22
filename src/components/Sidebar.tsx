import { useEffect, useState, type ReactElement, type CSSProperties, type Key } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Avatar, Button, ScrollShadow, Separator, Tabs, Tooltip } from '@heroui/react'
import { House, Comment, Database, Gear, ChevronLeft, ChevronRight, ArrowDownToLine, Aperture, FaceRobot, Ghost, BookOpen, LogoMcp, PersonGear } from '@gravity-ui/icons'
import packageJson from '../../package.json'
import { useAppStore } from '../stores/appStore'
import { usePluginStore, ensurePluginStoreSubscribed, selectEnabledPlugins } from '../stores/pluginStore'
import { PluginIcon } from '../features/plugins/PluginIcon'
import { useDeviceConnectStatus } from '../hooks/useDeviceConnectStatus'
import { DeviceConnectStatusDot } from './DeviceConnectStatusDot'
import DeviceConnectDialog from './DeviceConnectDialog'
import { cn } from '../lib/utils'

const EXPANDED_WIDTH = 220
const COLLAPSED_WIDTH = 88
const NAV_ICON_SIZE = 23
const SIDEBAR_ACTION_ICON_SIZE = 23
const APP_DISPLAY_NAME = packageJson.build?.productName || packageJson.name
const WECHAT_LOGO_SRC = './微信logo.png'

type RouteItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'route'
  path: string
}

type ActionItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'action'
  onClick: () => void
}

type NavItemConfig = RouteItem | ActionItem

function Sidebar({ autoCollapse = false }: { autoCollapse?: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  const userInfo = useAppStore(state => state.userInfo)
  const deviceStatus = useDeviceConnectStatus()
 const [collapsed, setCollapsed] = useState(false)
 const [deviceConnectOpen, setDeviceConnectOpen] = useState(false)
  const [diaryEnabled, setDiaryEnabled] = useState(true)
  const plugins = usePluginStore(state => state.plugins)

  useEffect(() => { ensurePluginStoreSubscribed() }, [])
 const userDisplayName = userInfo?.nickName?.trim() || userInfo?.alias?.trim() || '未连接用户'
  const userInitial = userDisplayName.slice(0, 1).toUpperCase()

  const isActive = (path: string) => location.pathname === path

 useEffect(() => {
   if (autoCollapse) setCollapsed(true)
 }, [autoCollapse])

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

 const openChatWindow = async () => {
    try {
      await window.electronAPI.window.openChatWindow()
    } catch (e) {
      console.error('打开聊天窗口失败:', e)
    }
  }

  const openMomentsWindow = async () => {
    try {
      await window.electronAPI.window.openMomentsWindow()
    } catch (e) {
      console.error('打开朋友圈窗口失败:', e)
    }
  }

  const navItems: NavItemConfig[] = [
    { key: 'home', label: '首页', icon: <House width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/home' },
    { key: 'agent', label: 'CT-Agent', icon: <FaceRobot width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/agent' },
    { key: 'personas', label: 'AI 克隆', icon: <PersonGear width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/personas' },
    { key: 'diary', label: '日记', icon: <BookOpen width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/diary' },
    { key: 'pets', label: 'AI 宠物', icon: <Ghost width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/pets' },
    { key: 'chat', label: '聊天查看', icon: <Comment width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'action', onClick: openChatWindow },
    { key: 'moments', label: '朋友圈', icon: <Aperture width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'action', onClick: openMomentsWindow },
    { key: 'export', label: '导出数据', icon: <ArrowDownToLine width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/export' },
    { key: 'data-management', label: '数据管理', icon: <Database width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/data-management' },
    { key: 'mcp', label: 'MCP & Skills', icon: <LogoMcp width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} />, type: 'route', path: '/mcp' },
 ]

  // 插件侧边栏贡献点（声明式：只读 manifest，不执行插件代码）
  for (const plugin of selectEnabledPlugins(plugins)) {
    for (const menu of plugin.contributes.sidebarMenus ?? []) {
      navItems.push({
        key: `plugin:${plugin.id}:${menu.id}`,
        label: menu.label,
        icon: <PluginIcon name={menu.icon} size={NAV_ICON_SIZE} />,
        type: 'route',
        path: `/plugin/${plugin.id}/${menu.view}`,
      })
    }
  }

  const visibleNavItems = diaryEnabled ? navItems : navItems.filter((item) => item.key !== 'diary')
 const activeNavKey = navItems.find(item => item.type === 'route' && isActive(item.path))?.key

 const handleNavSelectionChange = (key: Key) => {
   const item = navItems.find(navItem => navItem.key === String(key))
   if (!item) return

   if (item.type === 'route') {
     navigate(item.path)
   } else {
     item.onClick()
   }
 }

  const renderNavButton = (opts: { label: string; icon: ReactElement; active?: boolean; onPress: () => void }) => {
    const button = (
      <Button
        variant={opts.active ? 'primary' : 'ghost'}
        fullWidth={!collapsed}
        isIconOnly={collapsed}
        onPress={opts.onPress}
        aria-label={opts.label}
        className={cn(
          'rounded-full',
          collapsed ? 'h-12 w-12 min-w-12 p-0' : 'h-12 justify-start gap-2 px-3'
        )}
      >
        {collapsed ? (
          opts.icon
        ) : (
          <>
            <span className="flex w-6 shrink-0 items-center justify-center">{opts.icon}</span>
            <span className="truncate text-base font-semibold">{opts.label}</span>
          </>
        )}
      </Button>
    )

    if (!collapsed) return button

    return (
      <Tooltip delay={0}>
        <Tooltip.Trigger>{button}</Tooltip.Trigger>
        <Tooltip.Content placement="right">{opts.label}</Tooltip.Content>
      </Tooltip>
    )
  }

  const renderNavTab = (item: NavItemConfig) => {
    return (
      <Tabs.Tab
        key={item.key}
        id={item.key}
        className={cn(
          'rounded-full text-foreground transition-colors',
          collapsed ? 'h-12! w-12! min-w-12! justify-center p-0' : 'h-12! w-full justify-start gap-2 px-3'
        )}
      >
        {collapsed ? (
          <>
            <Tooltip delay={0}>
              <Tooltip.Trigger aria-label={item.label}>
                <span className="flex w-6 shrink-0 items-center justify-center">{item.icon}</span>
              </Tooltip.Trigger>
              <Tooltip.Content placement="right">{item.label}</Tooltip.Content>
            </Tooltip>
            <span className="sr-only">{item.label}</span>
          </>
        ) : (
          <>
            <span className="flex w-6 shrink-0 items-center justify-center">{item.icon}</span>
            <span className="truncate text-base font-semibold">{item.label}</span>
          </>
        )}
        <Tabs.Indicator />
      </Tabs.Tab>
    )
  }

  const profileAvatar = (
    <div className="relative">
      <Avatar size="md">
        {userInfo?.avatarUrl ? <Avatar.Image src={userInfo.avatarUrl} alt={userDisplayName} /> : null}
        <Avatar.Fallback>{userInitial}</Avatar.Fallback>
      </Avatar>
      <span className="absolute right-0 bottom-0 size-3 rounded-full bg-green-500 ring-2 ring-background" />
    </div>
  )

  const deviceConnectIcon = (
    <span className="relative inline-flex">
      <img
        src={WECHAT_LOGO_SRC}
        alt=""
        className="shrink-0 object-contain"
        style={{ width: SIDEBAR_ACTION_ICON_SIZE, height: SIDEBAR_ACTION_ICON_SIZE }}
      />
      <DeviceConnectStatusDot status={deviceStatus} className="absolute -right-0.5 -top-0.5 size-2.5 ring-2 ring-background" />
    </span>
  )

  return (
    <>
      <aside
        className="flex shrink-0 flex-col overflow-x-hidden bg-surface-secondary backdrop-blur-[18px] transition-[width] duration-200 ease-out"
        style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      >
      <div
        className="shrink-0"
        aria-hidden="true"
        style={{
          height: 'var(--window-chrome-height)',
          WebkitAppRegion: 'drag',
        } as CSSProperties}
      />

      {/* 顶部用户区：头像 + 软件名 + 用户名 */}
      <div
        className={cn('flex shrink-0 items-center gap-2.5 overflow-hidden px-6 pb-2', collapsed && 'justify-center')}
        style={{
          WebkitAppRegion: 'no-drag',
        } as CSSProperties}
      >
        {collapsed ? (
          <Tooltip delay={0}>
            <Tooltip.Trigger aria-label={userDisplayName}>{profileAvatar}</Tooltip.Trigger>
            <Tooltip.Content placement="right">{userDisplayName}</Tooltip.Content>
          </Tooltip>
        ) : (
          <>
            {profileAvatar}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{userDisplayName}</div>
              <div className="truncate text-xs text-muted">{APP_DISPLAY_NAME}</div>
            </div>
          </>
        )}
      </div>

      {/* 主导航 */}
      <ScrollShadow hideScrollBar className="min-h-0 flex-1 px-3 pt-0.5" size={32}>
        <nav className={cn(collapsed && 'flex justify-center')}>
          <Tabs
            className={cn(collapsed ? 'w-fit' : 'w-full')}
            orientation="vertical"
            selectedKey={activeNavKey}
            onSelectionChange={handleNavSelectionChange}
          >
            <Tabs.ListContainer>
              <Tabs.List
                aria-label="主导航"
                className={cn(
                  'bg-transparent p-0',
                  collapsed ? 'w-fit items-center gap-1' : 'w-full gap-1'
                )}
              >
               {visibleNavItems.map(renderNavTab)}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </nav>
      </ScrollShadow>

      {/* 底部：分隔线 + 设置 + 折叠 */}
      <div className="shrink-0 px-2 pb-2">
        <Separator className="my-1.5" />

        <div className={cn('flex flex-col gap-1', collapsed && 'items-center')}>
          {renderNavButton({
            label: 'ClawLink',
            icon: deviceConnectIcon,
            onPress: () => setDeviceConnectOpen(true),
          })}
          {renderNavButton({
            label: '设置',
            icon: <Gear width={SIDEBAR_ACTION_ICON_SIZE} height={SIDEBAR_ACTION_ICON_SIZE} />,
            active: isActive('/settings'),
            onPress: () => navigate('/settings'),
          })}
          {renderNavButton({
            label: collapsed ? '展开' : '收回',
            icon: collapsed ? <ChevronRight width={SIDEBAR_ACTION_ICON_SIZE} height={SIDEBAR_ACTION_ICON_SIZE} /> : <ChevronLeft width={SIDEBAR_ACTION_ICON_SIZE} height={SIDEBAR_ACTION_ICON_SIZE} />,
            onPress: () => setCollapsed(!collapsed),
          })}
        </div>
      </div>
      </aside>
      <DeviceConnectDialog isOpen={deviceConnectOpen} onClose={() => setDeviceConnectOpen(false)} />
    </>
  )
}

export default Sidebar
