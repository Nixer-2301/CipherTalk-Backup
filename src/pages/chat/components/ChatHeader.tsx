import { Aperture, ArrowDownToLine, ArrowsRotateLeft, Bell, BellSlash, Bulb, CircleCheck, CircleDashed, CircleInfo, Ellipsis, FaceRobot, FileText, Layers, LayoutSideContentRight, MagicWand, Microphone, Picture, Sparkles } from '@gravity-ui/icons'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button, Drawer, Dropdown, Label, Switch, Tooltip } from '@heroui/react'
import { CloneSelfModal } from './CloneSelfModal'
import { DateJumpPicker } from './DateJumpPicker'
import type { ChatSession } from '../../../types/models'
import type { EmbeddingBuildProgress, EmbeddingBuildTarget, EmbeddingVectorStoreInfo } from '../../../types/electron'
import { isGroupChat } from '../utils/messageGuards'
import {
  DEFAULT_REPLY_SUGGEST_SETTINGS,
  REPLY_SUGGEST_CONFIG_KEY,
  REPLY_SUGGEST_COUNTS,
  REPLY_SUGGEST_STYLES,
  type ReplySuggestSettings,
  type ReplySuggestStyle,
  getReplySuggestSettings,
  updateReplySuggestSettings,
} from '../replySuggest'
import { SessionAvatar } from './SessionSidebar'
import PluginChatToolbar from '../../../features/plugins/PluginChatToolbar'

// 磁贴窗口支持 Windows/macOS；Linux 暂不显示该开关。
const SUPPORTS_REPLY_TILE = /win|mac/.test(navigator.platform.toLowerCase())

type Progress = {
  current: number
  total: number
}

type SessionDetail = {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

function formatVectorProgress(progress: EmbeddingBuildProgress | null): string {
  if (!progress) return '准备语义索引…'
  if (progress.total > 0) return `${progress.message} ${progress.current}/${progress.total}`
  return progress.message
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatUpdatedAt(ms: number | null): string {
  if (!ms) return '无'
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSessionTimestamp(timestamp: number): string {
  if (!timestamp) return '无'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getSessionTypeLabel(session: ChatSession): string {
  if (session.isFoldGroup) return '折叠的聊天'
  if (session.isOfficialFolder) return '公众号聚合'
  if (session.isOfficialAccount || session.username.startsWith('gh_')) return '公众号'
  if (isGroupChat(session.username)) return '群聊'
  if (session.isWeCom) return '企业微信'
  return '私聊'
}

function DetailRow({ label, value, monospace = false }: { label: string; value: ReactNode; monospace?: boolean }) {
  return (
    <div className="chat-detail-row">
      <span className="chat-detail-row__label">{label}</span>
      <span className={`chat-detail-row__value${monospace ? ' is-monospace' : ''}`}>{value}</span>
    </div>
  )
}

interface ChatHeaderProps {
  currentSession: ChatSession
  currentSessionId: string | null
  isRefreshingMessages: boolean
  isLoadingMessages: boolean
  isUpdating: boolean
  onRefreshMessages: () => void | Promise<void>
  selectedDate: string
  onSelectedDateChange: (value: string) => void
  onJumpToDate: (dateValue?: string) => void | Promise<void>
  isJumpingToDate: boolean
  isBatchTranscribing: boolean
  batchTranscribeProgress: Progress
  onBatchTranscribe: () => void | Promise<void>
  isExportingVoiceSample: boolean
  onExportVoiceCloneSample: () => void | Promise<void>
  isBatchDecrypting: boolean
  batchDecryptProgress: Progress
  onBatchDecrypt: () => void | Promise<void>
}

export function ChatHeader({
  currentSession,
  currentSessionId,
  isRefreshingMessages,
  isLoadingMessages,
  isUpdating,
  onRefreshMessages,
  selectedDate,
  onSelectedDateChange,
  onJumpToDate,
  isJumpingToDate,
  isBatchTranscribing,
  batchTranscribeProgress,
  onBatchTranscribe,
  isExportingVoiceSample,
  onExportVoiceCloneSample,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt
}: ChatHeaderProps) {
  // 向量化（语义索引）状态：null=未知/未启用嵌入，count=已建片段数
  const [vecBuilding, setVecBuilding] = useState(false)
  const [vecStatus, setVecStatus] = useState<{ enabled: boolean; mediaEnabled: boolean; count: number; mediaCount: number } | null>(null)
  const [vecError, setVecError] = useState<string | null>(null)
  const [vecProgress, setVecProgress] = useState<EmbeddingBuildProgress | null>(null)
  const [vecStore, setVecStore] = useState<EmbeddingVectorStoreInfo | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [contactNickName, setContactNickName] = useState('')
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false)
  const headerRef = useRef<HTMLDivElement>(null)
  const [detailDrawerHost, setDetailDrawerHost] = useState<HTMLElement | null>(null)

  const getDetailDrawerHost = useCallback(() => {
    const messageShell = headerRef.current?.closest('.message-shell') as HTMLElement | null
    const messageArea = headerRef.current?.closest('.message-area') as HTMLElement | null
    return (messageShell ?? messageArea)?.querySelector('.message-content-wrapper') as HTMLElement | null
  }, [])

  useEffect(() => {
    setDetailDrawerHost(getDetailDrawerHost())
  }, [getDetailDrawerHost])

  useEffect(() => {
    let cancelled = false
    setContactNickName('')
    setSessionDetail(null)
    setSessionDetailLoading(true)

    void window.electronAPI.chat.getSessionDetail(currentSession.username)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.detail) {
          setSessionDetail(result.detail)
          setContactNickName(result.detail.nickName?.trim() || currentSession.username)
        } else {
          setContactNickName(currentSession.username)
        }
      })
      .catch(() => {
        if (!cancelled) setContactNickName(currentSession.username)
      })
      .finally(() => {
        if (!cancelled) setSessionDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [currentSession.username])

  // 消息提醒开关：回显当前会话是否开启，并随 config 变更同步
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.notify.getEnabledSessions().then((list) => {
      if (!cancelled) setNotifyEnabled(list.includes(currentSession.username))
    })
    const off = window.electronAPI.config.onChanged(({ key, value }) => {
      if (key === 'notifySessions' && Array.isArray(value)) {
        setNotifyEnabled((value as string[]).includes(currentSession.username))
      }
    })
    return () => { cancelled = true; off() }
  }, [currentSession.username])

  const handleToggleNotify = useCallback(() => {
    setNotifyEnabled((prev) => {
      const next = !prev
      void window.electronAPI.notify.setSessionEnabled(currentSession.username, next)
      return next
    })
  }, [currentSession.username])

  // 回复建议设置：会话级，改动写回 config；ReplySuggestBar 靠 config.onChanged 同步
  const [replySettings, setReplySettings] = useState<ReplySuggestSettings>(DEFAULT_REPLY_SUGGEST_SETTINGS)
  useEffect(() => {
    let cancelled = false
    void getReplySuggestSettings(currentSession.username).then((s) => {
      if (!cancelled) setReplySettings(s)
    })
    const off = window.electronAPI.config.onChanged(({ key }) => {
      if (key !== REPLY_SUGGEST_CONFIG_KEY) return
      void getReplySuggestSettings(currentSession.username).then((s) => {
        if (!cancelled) setReplySettings(s)
      })
    })
    return () => { cancelled = true; off() }
  }, [currentSession.username])

  const patchReplySettings = useCallback((patch: Partial<ReplySuggestSettings>) => {
    // 打开自动建议时联动打开「参与磁贴」（可随后单独关闭）
    const effective = patch.enabled === true ? { ...patch, tile: true } : patch
    setReplySettings((prev) => ({ ...prev, ...effective }))
    void updateReplySuggestSettings(currentSession.username, effective).then(() => {
      // 配置写入后再重算参与列表，避免主进程读到旧配置。
      window.electronAPI.window.replyTileRefresh()
    })
  }, [currentSession.username])

  // 自画像状态：是否已克隆"我"对此联系人的说话画像（self: 前缀键），用于菜单显示
  const [myPersonaExists, setMyPersonaExists] = useState(false)
  const [cloneSelfOpen, setCloneSelfOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.persona.get(`self:${currentSession.username}`).then((res) => {
      if (!cancelled) setMyPersonaExists(!!(res.success && res.persona))
    })
    return () => { cancelled = true }
  }, [currentSession.username])

  const syncDetailDrawerBounds = useCallback(() => {
    const host = detailDrawerHost ?? getDetailDrawerHost()
    if (!host) return

    const rect = host.getBoundingClientRect()
    const rootStyle = document.documentElement.style
    rootStyle.setProperty('--chat-detail-drawer-left', `${rect.left}px`)
    rootStyle.setProperty('--chat-detail-drawer-top', `${rect.top}px`)
    rootStyle.setProperty('--chat-detail-drawer-width', `${rect.width}px`)
    rootStyle.setProperty('--chat-detail-drawer-height', `${rect.height}px`)
  }, [detailDrawerHost])

  useEffect(() => {
    if (!isDetailOpen) return

    const host = detailDrawerHost ?? getDetailDrawerHost()
    if (!host) return

    syncDetailDrawerBounds()
    window.addEventListener('resize', syncDetailDrawerBounds)
    const observer = new ResizeObserver(syncDetailDrawerBounds)
    observer.observe(host)

    return () => {
      window.removeEventListener('resize', syncDetailDrawerBounds)
      observer.disconnect()
    }
  }, [detailDrawerHost, getDetailDrawerHost, isDetailOpen, syncDetailDrawerBounds])

  useEffect(() => {
    let cancelled = false
    setVecError(null)
    setVecProgress(null)
    setVecStore(null)
    if (!currentSessionId) {
      setVecStatus(null)
      return
    }
    void window.electronAPI.embedding.sessionStatus(currentSessionId).then((res) => {
      if (!cancelled && res.success) {
        setVecStatus({ enabled: !!res.enabled, mediaEnabled: !!res.mediaEnabled, count: res.count ?? 0, mediaCount: res.mediaCount ?? 0 })
        setVecStore(res.store ?? null)
      }
    })
    return () => { cancelled = true }
  }, [currentSessionId])

  useEffect(() => {
    return window.electronAPI.embedding.onBuildProgress((progress) => {
      if (!currentSessionId || progress.sessionId !== currentSessionId) return
      setVecProgress(progress)
      if (progress.stage === 'done') {
        void window.electronAPI.embedding.sessionStatus(currentSessionId).then((res) => {
          if (res.success) {
            setVecStatus({ enabled: !!res.enabled, mediaEnabled: !!res.mediaEnabled, count: res.count ?? 0, mediaCount: res.mediaCount ?? 0 })
            setVecStore(res.store ?? null)
          }
        })
      }
    })
  }, [currentSessionId])

  const handleVectorize = async (target: EmbeddingBuildTarget = 'all') => {
    if (!currentSessionId || vecBuilding) return
    setVecBuilding(true)
    setVecError(null)
    setVecProgress({
      sessionId: currentSessionId,
      stage: 'loading',
      current: 0,
      total: 0,
      indexed: vecStatus?.count ?? 0,
      message: target === 'image' ? '准备图片向量索引' : target === 'text' ? '准备文本语义索引' : '准备语义索引'
    })
    try {
      const res = await window.electronAPI.embedding.buildSession(currentSessionId, { target })
      if (res.success) {
        const status = await window.electronAPI.embedding.sessionStatus(currentSessionId)
        if (status.success) {
          setVecStatus({ enabled: !!status.enabled, mediaEnabled: !!status.mediaEnabled, count: status.count ?? 0, mediaCount: status.mediaCount ?? 0 })
          setVecStore(status.store ?? null)
        }
      } else setVecError(res.error || '向量化失败')
    } catch (e) {
      setVecError(e instanceof Error ? e.message : String(e))
    } finally {
      setVecBuilding(false)
    }
  }

  const vecDisabled = !currentSessionId || vecBuilding || (vecStatus !== null && !vecStatus.enabled)
  const vecTooltip = vecBuilding
    ? formatVectorProgress(vecProgress)
    : vecError
      ? `向量化失败：${vecError}`
      : vecStatus && !vecStatus.enabled
        ? '未启用嵌入模型（设置 → 嵌入）'
        : vecStatus && (vecStatus.count > 0 || vecStatus.mediaCount > 0)
          ? `文本 ${vecStatus.count} 段 · 图片 ${vecStatus.mediaCount} 张 · 点击选择更新`
          : '为此会话建立语义索引'
  const vectorEvidenceRows = vecStore
    ? [
        `片段：${vecStore.count} 段`,
        `媒体：${vecStore.mediaCount || 0} 张`,
        `维度：${vecStore.dimensions.length > 0 ? vecStore.dimensions.join(', ') : '无'}`,
        vecStore.mediaDimensions?.length ? `媒体维度：${vecStore.mediaDimensions.join(', ')}` : '',
        `文件：${vecStore.exists ? formatBytes(vecStore.sizeBytes) : '未创建'}`,
        `更新：${formatUpdatedAt(vecStore.updatedAtMs)}`,
        vecStore.dbPath,
      ]
    : []
  const sessionDisplayName = contactNickName || currentSession.username

  // AI摘要：{提示词+@目标} 经 localStorage 递给主窗口 AI 助手页（AgentPage 侧消费：新建对话+@+自动发送），再唤起主窗口
  const handleAiSummary = (rangeText: string) => {
    const target = isGroupChat(currentSession.username)
      ? `群聊「${sessionDisplayName}」`
      : `我和「${sessionDisplayName}」`
    const prompt = `请总结${target}${rangeText}的聊天记录。

要求：
1. 按主题归纳主要讨论内容和关键结论。
2. 标出重要事项、待办、承诺和情绪变化。
3. 引用关键原话或聊天片段作为依据，不要凭空推断。
4. 如果该时间段没有聊天记录，请直接说明。`
    localStorage.setItem('agent:pendingAutoRun', JSON.stringify({
      text: prompt,
      mention: {
        username: currentSession.username,
        displayName: sessionDisplayName,
        avatarUrl: currentSession.avatarUrl,
      },
    }))
    void window.electronAPI.window.focusMainWindow('/agent')
  }
  // 仅私聊可开消息提醒（排除群聊/公众号）
  const isPrivateSession = !isGroupChat(currentSession.username)
    && !currentSession.username.startsWith('gh_')
    && !currentSession.isOfficialAccount
    && !currentSession.isOfficialFolder
  const lastActivity = currentSession.lastTimestamp || currentSession.sortTimestamp
  const summary = currentSession.summary?.split('\n')[0]?.trim() || '暂无消息'
  const messageTables = sessionDetail?.messageTables ?? []
  const detailDrawer = (
    <Drawer.Backdrop
      className="chat-detail-backdrop"
      isOpen={isDetailOpen}
      onOpenChange={setIsDetailOpen}
      variant="transparent"
    >
      <Drawer.Content className="chat-detail-content" placement="right">
        <Drawer.Dialog className="chat-detail-drawer" aria-label="会话详情">
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>会话详情</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            <div className="chat-detail-profile">
              <SessionAvatar session={currentSession} size={64} />
              <div className="chat-detail-profile__text">
                <div className="chat-detail-profile__name">{sessionDisplayName}</div>
                <div className="chat-detail-profile__meta">{getSessionTypeLabel(currentSession)}</div>
              </div>
            </div>

            <section className="chat-detail-section">
              <h4>基础信息</h4>
              <DetailRow label="昵称" value={sessionDisplayName} />
              <DetailRow label="会话 ID" value={sessionDetail?.wxid || currentSession.username} monospace />
              <DetailRow label="类型" value={getSessionTypeLabel(currentSession)} />
              {currentSession.isWeCom && (
                <DetailRow label="企业" value={currentSession.weComCorp || '企业微信'} />
              )}
              <DetailRow label="置顶" value={currentSession.isPinned ? '是' : '否'} />
              <DetailRow label="未读" value={currentSession.unreadCount > 0 ? currentSession.unreadCount : '无'} />
              <DetailRow label="最近活跃" value={formatSessionTimestamp(lastActivity)} />
            </section>

            <section className="chat-detail-section">
              <h4>消息统计</h4>
              <DetailRow label="总数" value={sessionDetailLoading ? '加载中...' : (sessionDetail?.messageCount ?? 0)} />
              <DetailRow label="最早消息" value={formatSessionTimestamp(sessionDetail?.firstMessageTime || 0)} />
              <DetailRow label="最新消息" value={formatSessionTimestamp(sessionDetail?.latestMessageTime || 0)} />
            </section>

            <section className="chat-detail-section">
              <h4>最近消息</h4>
              <div className="chat-detail-summary">{summary}</div>
            </section>

            <section className="chat-detail-section">
              <h4>消息所在数据库</h4>
              {sessionDetailLoading ? (
                <div className="chat-detail-empty">正在加载...</div>
              ) : messageTables.length > 0 ? (
                <div className="chat-detail-table-list">
                  {messageTables.map((item) => (
                    <div className="chat-detail-table-item" key={`${item.dbName}:${item.tableName}`}>
                      <div className="chat-detail-table-item__main">
                        <span className="chat-detail-table-item__db">{item.dbName}</span>
                        <span className="chat-detail-table-item__table">{item.tableName}</span>
                      </div>
                      <span className="chat-detail-table-item__count">{item.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="chat-detail-empty">未找到消息表</div>
              )}
            </section>

            <section className="chat-detail-section">
              <h4>语义索引</h4>
              <DetailRow
                label="状态"
                value={vecBuilding ? formatVectorProgress(vecProgress) : vecTooltip}
              />
              {vectorEvidenceRows.map((row, index) => (
                <DetailRow
                  key={`${index}:${row}`}
                  label={index === 0 ? '片段' : index === 1 ? '维度' : index === 2 ? '文件' : index === 3 ? '更新' : '路径'}
                  value={row.replace(/^(片段|维度|文件|更新)：/, '')}
                  monospace={index === 4}
                />
              ))}
            </section>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )

  return (
    <div ref={headerRef} className="message-header">
      <SessionAvatar session={currentSession} size={40} />
      <div className="header-info">
        <h3>
          {currentSession.displayName || currentSession.username}
          {currentSession.isWeCom && (
            currentSession.weComCorp
              ? <span className="wecom-corp" title="企业微信">@{currentSession.weComCorp}</span>
              : <span className="wecom-badge" title="企业微信">企</span>
          )}
        </h3>
        {isGroupChat(currentSession.username) && (
          <div className="header-subtitle">群聊</div>
        )}
        {vecBuilding && (
          <div className="header-subtitle">{formatVectorProgress(vecProgress)}</div>
        )}
      </div>
      <div className="header-actions">
        <PluginChatToolbar
          sessionId={currentSessionId}
          sessionName={currentSession.displayName || currentSession.username}
        />
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="刷新消息"
              onPress={onRefreshMessages}
              isDisabled={isRefreshingMessages || isLoadingMessages}
            >
              <ArrowsRotateLeft width={18} height={18} className={isRefreshingMessages || isUpdating ? 'animate-spin' : ''} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">刷新消息</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Dropdown>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="向量化（语义索引）"
                isDisabled={vecDisabled}
              >
                {vecBuilding
                  ? <CircleDashed width={18} height={18} className="animate-spin" />
                  : <Sparkles width={18} height={18} className={(vecStatus && (vecStatus.count > 0 || vecStatus.mediaCount > 0)) ? 'text-primary' : ''} />}
              </Button>
              <Dropdown.Popover className="min-w-64" placement="bottom end">
                <Dropdown.Menu
                  disabledKeys={vecStatus && !vecStatus.mediaEnabled ? ['image'] : undefined}
                  onAction={(key) => void handleVectorize(String(key) as EmbeddingBuildTarget)}
                >
                  <Dropdown.Item id="text" textValue="向量化文本">
                    <FileText className="size-4 shrink-0 text-muted" />
                    <Label>向量化文本</Label>
                    <span className="ml-auto text-muted-foreground text-xs">{vecStore?.count ?? vecStatus?.count ?? 0} 段</span>
                  </Dropdown.Item>
                  <Dropdown.Item id="image" textValue="向量化图片">
                    <Picture className="size-4 shrink-0 text-muted" />
                    <Label>向量化图片</Label>
                    <span className="ml-auto text-muted-foreground text-xs">{vecStore?.mediaCount ?? vecStatus?.mediaCount ?? 0} 张</span>
                  </Dropdown.Item>
                  <Dropdown.Item id="all" textValue="向量化文本和图片">
                    <Layers className="size-4 shrink-0 text-muted" />
                    <Label>向量化全部</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">{vecTooltip}</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Dropdown>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="AI 摘要"
                isDisabled={!currentSessionId}
              >
                <MagicWand width={18} height={18} />
              </Button>
              <Dropdown.Popover className="min-w-44" placement="bottom end">
                <Dropdown.Menu onAction={(key) => handleAiSummary(String(key))}>
                  <Dropdown.Item id="今天" textValue="摘要今天的聊天">
                    <Label>摘要今天的聊天</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="最近一周" textValue="摘要最近一周">
                    <Label>摘要最近一周</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="最近一个月" textValue="摘要最近一月">
                    <Label>摘要最近一月</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">AI 摘要（在 AI 助手中生成）</Tooltip.Content>
        </Tooltip>

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={notifyEnabled ? '关闭新消息提醒' : '开启新消息提醒'}
                onPress={handleToggleNotify}
              >
                {notifyEnabled ? <Bell width={18} height={18} className="text-primary" /> : <BellSlash width={18} height={18} />}
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">{notifyEnabled ? '新消息提醒已开启 · 点击关闭' : '开启新消息提醒（桌宠气泡）'}</Tooltip.Content>
          </Tooltip>
        )}

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Dropdown>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label="回复建议设置"
                >
                  <Bulb width={18} height={18} className={replySettings.enabled ? 'text-primary' : ''} />
                </Button>
                <Dropdown.Popover className="min-w-56" placement="bottom end">
              <Dropdown.Menu
                onAction={(key) => {
                  // 自动建议/深度模式由各自的 Switch 独立切换，不走整行 onAction
                  if (key === 'cloneSelf') setCloneSelfOpen(true)
                }}
              >
                <Dropdown.Item id="cloneSelf" textValue="克隆我自己">
                  <FaceRobot className="size-4 shrink-0 text-muted" />
                  <Label>{myPersonaExists ? '重建我的自画像' : '克隆我自己'}</Label>
                  <span className={`ml-auto text-xs ${myPersonaExists ? 'text-success' : 'text-muted-foreground'}`}>
                    {myPersonaExists ? (
                      <span className="inline-flex items-center gap-0.5">
                        <CircleCheck width={12} height={12} />
                        已克隆
                      </span>
                    ) : '未克隆'}
                  </span>
                </Dropdown.Item>
                <Dropdown.Item id="toggle" textValue="自动建议">
                  <Bulb className="size-4 shrink-0 text-muted" />
                  <Label>自动建议</Label>
                  <span
                    className="ml-auto inline-flex pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      aria-label="自动建议"
                      isSelected={replySettings.enabled}
                      onChange={(v) => patchReplySettings({ enabled: v })}
                    >
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch>
                  </span>
                </Dropdown.Item>
                <Dropdown.Item id="deep" textValue="深度模式">
                  <Layers className="size-4 shrink-0 text-muted" />
                  <Label>深度模式</Label>
                  <span
                    className="ml-auto inline-flex pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      aria-label="深度模式"
                      isSelected={replySettings.deep}
                      onChange={(v) => patchReplySettings({ deep: v })}
                    >
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch>
                  </span>
                </Dropdown.Item>
                {SUPPORTS_REPLY_TILE && (
                  <Dropdown.Item id="tile" textValue="磁贴窗口">
                    <LayoutSideContentRight className="size-4 shrink-0 text-muted" />
                    <Label>磁贴窗口</Label>
                    <span
                      className="ml-auto inline-flex pointer-events-auto"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        aria-label="磁贴窗口"
                        isSelected={replySettings.tile}
                        onChange={(v) => patchReplySettings({ tile: v })}
                      >
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch>
                    </span>
                  </Dropdown.Item>
                )}
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="style" textValue="风格">
                    <Label className="min-w-0 flex-1 text-left">风格</Label>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {REPLY_SUGGEST_STYLES.find((s) => s.id === replySettings.style)?.label}
                    </span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover className="min-w-36" placement="right top">
                    <Dropdown.Menu
                      selectedKeys={new Set([replySettings.style])}
                      selectionMode="single"
                      onAction={(key) => patchReplySettings({ style: String(key) as ReplySuggestStyle })}
                    >
                      {REPLY_SUGGEST_STYLES.map((style) => (
                        <Dropdown.Item id={style.id} key={style.id} textValue={style.label}>
                          <Dropdown.ItemIndicator />
                          <Label>{style.label}</Label>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="count" textValue="建议数量">
                    <Label className="min-w-0 flex-1 text-left">建议数量</Label>
                    <span className="shrink-0 text-muted-foreground text-xs">{replySettings.count} 条</span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover className="min-w-28" placement="right top">
                    <Dropdown.Menu
                      selectedKeys={new Set([String(replySettings.count)])}
                      selectionMode="single"
                      onAction={(key) => patchReplySettings({ count: Number(key) })}
                    >
                      {REPLY_SUGGEST_COUNTS.map((count) => (
                        <Dropdown.Item id={String(count)} key={count} textValue={`${count} 条`}>
                          <Dropdown.ItemIndicator />
                          <Label>{count} 条</Label>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">回复建议设置</Tooltip.Content>
          </Tooltip>
        )}

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="克隆好友"
                onPress={() => window.electronAPI.window.openPersonaChatWindow(currentSession.username)}
              >
                <FaceRobot width={18} height={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">克隆好友（和 TA 的数字分身聊天）</Tooltip.Content>
          </Tooltip>
        )}

        {!isGroupChat(currentSession.username) && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="查看朋友圈"
                onPress={() => window.electronAPI.window.openMomentsWindow(currentSession.username)}
              >
                <Aperture width={18} height={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">查看朋友圈</Tooltip.Content>
          </Tooltip>
        )}

        <DateJumpPicker
          value={selectedDate}
          onChange={onSelectedDateChange}
          onJump={onJumpToDate}
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
        />

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Dropdown>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="批量工具"
              >
                {(isBatchTranscribing || isBatchDecrypting || isExportingVoiceSample)
                  ? <CircleDashed width={18} height={18} className="animate-spin" />
                  : <Ellipsis width={18} height={18} />}
              </Button>
              <Dropdown.Popover className="min-w-56" placement="bottom end">
                <Dropdown.Menu
                  disabledKeys={[
                    ...(isBatchTranscribing || !currentSessionId ? ['transcribe'] : []),
                    ...(isBatchDecrypting || !currentSessionId ? ['decrypt'] : []),
                    ...(isExportingVoiceSample || !currentSessionId ? ['voiceSample'] : []),
                  ]}
                  onAction={(key) => {
                    if (key === 'transcribe') void onBatchTranscribe()
                    else if (key === 'decrypt') void onBatchDecrypt()
                    else if (key === 'voiceSample') void onExportVoiceCloneSample()
                  }}
                >
                  <Dropdown.Item id="transcribe" textValue="批量语音转文字">
                    <Microphone className="size-4 shrink-0 text-muted" />
                    <Label>批量语音转文字</Label>
                    {isBatchTranscribing && (
                      <span className="ml-auto text-muted-foreground text-xs">{batchTranscribeProgress.current}/{batchTranscribeProgress.total}</span>
                    )}
                  </Dropdown.Item>
                  <Dropdown.Item id="decrypt" textValue="批量解密图片">
                    <Picture className="size-4 shrink-0 text-muted" />
                    <Label>批量解密图片</Label>
                    {isBatchDecrypting && (
                      <span className="ml-auto text-muted-foreground text-xs">{batchDecryptProgress.current}/{batchDecryptProgress.total}</span>
                    )}
                  </Dropdown.Item>
                  {isPrivateSession && (
                    <Dropdown.Item id="voiceSample" textValue="导出复刻语音样本">
                      <ArrowDownToLine className="size-4 shrink-0 text-muted" />
                      <Label>导出复刻语音样本</Label>
                      {isExportingVoiceSample && (
                        <span className="ml-auto text-muted-foreground text-xs">导出中</span>
                      )}
                    </Dropdown.Item>
                  )}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">批量工具</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="会话详情"
              onPress={() => setIsDetailOpen(true)}
            >
              <CircleInfo width={18} height={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">会话详情</Tooltip.Content>
        </Tooltip>
      </div>

      {detailDrawerHost ? detailDrawer : null}

      {isPrivateSession && (
        <CloneSelfModal
          isOpen={cloneSelfOpen}
          onOpenChange={(open) => {
            setCloneSelfOpen(open)
            // 关闭后刷新自画像存在状态（克隆完成/删除后会变）
            if (!open) {
              void window.electronAPI.persona.get(`self:${currentSession.username}`).then((res) => {
                setMyPersonaExists(!!(res.success && res.persona))
              })
            }
          }}
          session={currentSession}
        />
      )}
    </div>
  )
}
