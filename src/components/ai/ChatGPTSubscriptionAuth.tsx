import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Chip, ProgressBar, Spinner, Tooltip } from '@heroui/react'
import { ArrowDownToLine, ArrowUpRight, ArrowsRotateLeft, ChevronDown, CircleCheck, Eye, EyeSlash, TrashBin } from '@gravity-ui/icons'
import type { CodexAccount, CodexSubscriptionRateLimit, CodexSubscriptionStatus, CodexSubscriptionUsage, CodexSubscriptionUsageWindow } from '@/types/electron'

type ChatGPTSubscriptionAuthProps = {
  compact?: boolean
  onAuthenticationChange?: (authenticated: boolean) => void
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  team: 'Team',
  business: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  edu: 'Edu',
  unknown: '未知套餐',
}

const PLAN_BADGE_CLASSES: Record<string, string> = {
  free: '[--chip-bg:#e4e4e7] [--chip-fg:#52525b] dark:[--chip-bg:#3f3f46] dark:[--chip-fg:#e4e4e7]',
  go: '[--chip-bg:#ffedd5] [--chip-fg:#9a3412] dark:[--chip-bg:#7c2d12] dark:[--chip-fg:#fed7aa]',
  plus: '[--chip-bg:#fef3c7] [--chip-fg:#92400e] dark:[--chip-bg:#78350f] dark:[--chip-fg:#fde68a]',
  pro: '[--chip-bg:#e0f2fe] [--chip-fg:#075985] dark:[--chip-bg:#0c4a6e] dark:[--chip-fg:#bae6fd]',
  prolite: '[--chip-bg:#e0f2fe] [--chip-fg:#075985] dark:[--chip-bg:#0c4a6e] dark:[--chip-fg:#bae6fd]',
  team: '[--chip-bg:#dbeafe] [--chip-fg:#1e40af] dark:[--chip-bg:#1e3a8a] dark:[--chip-fg:#bfdbfe]',
  business: '[--chip-bg:#d1fae5] [--chip-fg:#065f46] dark:[--chip-bg:#064e3b] dark:[--chip-fg:#a7f3d0]',
  self_serve_business_usage_based: '[--chip-bg:#d1fae5] [--chip-fg:#065f46] dark:[--chip-bg:#064e3b] dark:[--chip-fg:#a7f3d0]',
  enterprise: '[--chip-bg:#ede9fe] [--chip-fg:#5b21b6] dark:[--chip-bg:#4c1d95] dark:[--chip-fg:#ddd6fe]',
  enterprise_cbp_usage_based: '[--chip-bg:#ede9fe] [--chip-fg:#5b21b6] dark:[--chip-bg:#4c1d95] dark:[--chip-fg:#ddd6fe]',
  edu: '[--chip-bg:#cffafe] [--chip-fg:#155e75] dark:[--chip-bg:#164e63] dark:[--chip-fg:#a5f3fc]',
  unknown: '[--chip-bg:#e4e4e7] [--chip-fg:#52525b] dark:[--chip-bg:#3f3f46] dark:[--chip-fg:#e4e4e7]',
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return email.length <= 1 ? '*' : `${email.slice(0, 1)}***`
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return `${local.slice(0, 1)}***${domain}`
  if (local.length <= 4) return `${local.slice(0, 1)}***${local.slice(-1)}${domain}`
  return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`
}

function formatQuotaLabel(window: CodexSubscriptionUsageWindow, fallback: string): string {
  const minutes = window.windowDurationMins
  if (!minutes || minutes <= 0) return fallback
  if (minutes === 7 * 24 * 60) return '每周额度'
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天额度`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时额度`
  return `${minutes} 分钟额度`
}

function formatResetTime(resetsAt?: number): string {
  if (!resetsAt) return '恢复时间未知'
  const date = new Date(resetsAt * 1000)
  if (Number.isNaN(date.getTime())) return '恢复时间未知'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  const formatter = new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${formatter.format(date)} 恢复`
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
}

function quotaColor(remainingPercent: number): 'success' | 'warning' | 'danger' {
  if (remainingPercent <= 20) return 'danger'
  if (remainingPercent <= 50) return 'warning'
  return 'success'
}

function usageWindows(rateLimits: CodexSubscriptionRateLimit[]): Array<{
  key: string
  label: string
  window: CodexSubscriptionUsageWindow
}> {
  return rateLimits.flatMap((limit) => {
    const prefix = limit.limitName && limit.limitName !== limit.limitId ? `${limit.limitName} · ` : ''
    const entries: Array<{ key: string; label: string; window: CodexSubscriptionUsageWindow }> = []
    if (limit.primary) {
      entries.push({
        key: `${limit.limitId}:primary`,
        label: `${prefix}${formatQuotaLabel(limit.primary, '主要额度')}`,
        window: limit.primary,
      })
    }
    if (limit.secondary) {
      entries.push({
        key: `${limit.limitId}:secondary`,
        label: `${prefix}${formatQuotaLabel(limit.secondary, '次要额度')}`,
        window: limit.secondary,
      })
    }
    return entries
  })
}

export default function ChatGPTSubscriptionAuth({ compact = false, onAuthenticationChange }: ChatGPTSubscriptionAuthProps) {
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null)
  const [accounts, setAccounts] = useState<CodexAccount[]>([])
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [showEmail, setShowEmail] = useState(false)
  const [usage, setUsage] = useState<CodexSubscriptionUsage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState('')
  const usageRequestSequence = useRef(0)
  const onAuthenticationChangeRef = useRef(onAuthenticationChange)
  onAuthenticationChangeRef.current = onAuthenticationChange

  const refresh = async () => {
    const next = await window.electronAPI.codexSubscription.getStatus()
    setStatus(next)
    if (next.authenticated) {
      setPending(false)
      setError('')
    }
    onAuthenticationChangeRef.current?.(next.authenticated)
    return next
  }

  const fetchAccounts = useCallback(async () => {
    const result = await window.electronAPI.codexSubscription.listAccounts()
    if (result.success && result.accounts) setAccounts(result.accounts)
  }, [])

  const refreshUsage = useCallback(async (forceRefresh = false, showLoading = false) => {
    const requestSequence = ++usageRequestSequence.current
    if (showLoading) setUsageLoading(true)
    try {
      const result = await window.electronAPI.codexSubscription.getUsage(forceRefresh)
      if (requestSequence !== usageRequestSequence.current) return
      if (result.success && result.usage) {
        setUsage(result.usage)
        setUsageError('')
      } else {
        setUsageError(result.error || '暂时无法读取订阅额度')
      }
    } catch (usageRequestError) {
      if (requestSequence !== usageRequestSequence.current) return
      setUsageError(usageRequestError instanceof Error ? usageRequestError.message : String(usageRequestError))
    } finally {
      if (showLoading && requestSequence === usageRequestSequence.current) setUsageLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.electronAPI.codexSubscription.getStatus().then((next) => {
      if (!active) return
      setStatus(next)
      onAuthenticationChangeRef.current?.(next.authenticated)
    })
    void fetchAccounts()
    const off = window.electronAPI.codexSubscription.onStatusChanged((next) => {
      if (!active) return
      setStatus(next)
      if (next.authenticated) {
        setPending(false)
        setError('')
      }
      onAuthenticationChangeRef.current?.(next.authenticated)
      void fetchAccounts()
    })
    return () => {
      active = false
      off()
    }
  }, [fetchAccounts])

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => window.clearInterval(timer)
  }, [pending])

  useEffect(() => {
    setShowEmail(false)
  }, [status?.authenticated, status?.email])

  useEffect(() => {
    if (!status?.authenticated) {
      usageRequestSequence.current += 1
      setUsage(null)
      setUsageError('')
      setUsageLoading(false)
      return
    }
    void refreshUsage(false, true)
    const timer = window.setInterval(() => { void refreshUsage() }, 60_000)
    return () => window.clearInterval(timer)
  }, [refreshUsage, status?.authenticated, status?.email])

  const login = async () => {
    setPending(true)
    setError('')
    const result = await window.electronAPI.codexSubscription.login()
    if (!result.success) {
      setPending(false)
      setError(result.error || 'ChatGPT 登录启动失败')
    }
  }

  const importFromCli = async () => {
    setPending(true)
    setError('')
    const result = await window.electronAPI.codexSubscription.importFromCodexCli()
    if (!result.success) {
      setError(result.error || '导入本机 Codex 登录失败')
      setPending(false)
      return
    }
    await refresh()
    await fetchAccounts()
    setPending(false)
  }

  const setActiveAccount = async (id: string) => {
    setPending(true)
    setError('')
    usageRequestSequence.current += 1
    setUsage(null)
    setUsageError('')
    const result = await window.electronAPI.codexSubscription.setActiveAccount(id)
    if (!result.success) setError(result.error || '切换账号失败')
    else { await refresh(); await fetchAccounts() }
    setPending(false)
  }

  const removeAccount = async (id: string) => {
    setPending(true)
    setError('')
    usageRequestSequence.current += 1
    setUsage(null)
    setUsageError('')
    const result = await window.electronAPI.codexSubscription.removeAccount(id)
    if (!result.success) setError(result.error || '移除账号失败')
    else { await refresh(); await fetchAccounts() }
    setPending(false)
  }

  if (!status) {
    return <div className="flex min-h-16 items-center gap-2 text-muted-foreground text-sm"><Spinner size="sm" />正在读取 ChatGPT 登录状态...</div>
  }

  const planType = String(status.planType || 'unknown').toLowerCase()
  const planLabel = PLAN_LABELS[planType] || status.planType || PLAN_LABELS.unknown
  const planBadgeClass = PLAN_BADGE_CLASSES[planType] || PLAN_BADGE_CLASSES.unknown
  const quotaWindows = usageWindows(usage?.rateLimits || [])
  const showAddButtons = expanded || accounts.length === 0

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4 rounded-md border border-border p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">ChatGPT 账号</span>
            {status.authenticated && (
              <Chip size="sm" variant="soft" className={planBadgeClass}>
                <CircleCheck className="size-3.5" />
                <Chip.Label>{planLabel}</Chip.Label>
              </Chip>
            )}
            {accounts.length > 1 && (
              <span className="text-muted-foreground text-xs">共 {accounts.length} 个账号</span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground text-sm">
            <span className="truncate">
              {status.authenticated ? (status.email ? (showEmail ? status.email : maskEmail(status.email)) : '已登录') : '未登录'}
            </span>
            {status.authenticated && status.email && (
              <Tooltip delay={0}>
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  isIconOnly
                  className="size-6 min-h-6 min-w-6 shrink-0"
                  onPress={() => setShowEmail((visible) => !visible)}
                  aria-label={showEmail ? '隐藏邮箱' : '显示邮箱'}
                >
                  {showEmail ? <EyeSlash width={15} height={15} /> : <Eye width={15} height={15} />}
                </Button>
                <Tooltip.Content>{showEmail ? '隐藏邮箱' : '显示邮箱'}</Tooltip.Content>
              </Tooltip>
            )}
          </div>
        </div>
        {accounts.length > 0 && (
          <Button
            type="button"
            variant="tertiary"
            size="sm"
            onPress={() => setExpanded((visible) => !visible)}
            aria-label={expanded ? '收起账号列表' : '展开账号列表'}
          >
            {expanded ? '收起' : '管理账号'}
            <ChevronDown width={16} height={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </Button>
        )}
      </div>

      {accounts.length > 0 && expanded && (
        <div className="space-y-2 border-t border-border pt-3">
          {accounts.map((account) => {
            const accPlan = String(account.planType || 'unknown').toLowerCase()
            const accPlanLabel = PLAN_LABELS[accPlan] || account.planType || PLAN_LABELS.unknown
            const accPlanBadge = PLAN_BADGE_CLASSES[accPlan] || PLAN_BADGE_CLASSES.unknown
            return (
              <div key={account.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Chip size="sm" variant="soft" className={accPlanBadge}>
                    <Chip.Label>{accPlanLabel}</Chip.Label>
                  </Chip>
                  <span className="truncate text-sm text-foreground">{account.email ? maskEmail(account.email) : '已登录'}</span>
                  {account.active && (
                    <Chip size="sm" color="success" variant="soft">
                      <CircleCheck className="size-3.5" />
                      <Chip.Label>当前</Chip.Label>
                    </Chip>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!account.active && (
                    <Button type="button" variant="outline" size="sm" onPress={() => void setActiveAccount(account.id)} isDisabled={pending}>
                      设为当前
                    </Button>
                  )}
                  <Tooltip delay={0}>
                    <Button
                      type="button"
                      variant="tertiary"
                      size="sm"
                      isIconOnly
                      className="size-7 min-h-7 min-w-7"
                      onPress={() => void removeAccount(account.id)}
                      isDisabled={pending}
                      aria-label="移除账号"
                    >
                      <TrashBin width={15} height={15} />
                    </Button>
                    <Tooltip.Content>移除账号</Tooltip.Content>
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showAddButtons && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onPress={() => void importFromCli()} isDisabled={pending || !status.available}>
              {pending ? <Spinner size="sm" /> : <ArrowDownToLine width={16} height={16} />}
              导入本机 Codex 登录
            </Button>
            <Button type="button" variant="primary" size="sm" onPress={() => void login()} isDisabled={pending || !status.available}>
              {pending ? <Spinner size="sm" /> : <ArrowUpRight width={16} height={16} />}
              {pending ? '等待授权...' : accounts.length > 0 ? '添加其他账号' : '登录 ChatGPT'}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            「导入本机 Codex 登录」会读取电脑上 Codex CLI 的登录并在密语里另存一份，不会修改 CLI 文件。
            但两者共用同一个 ChatGPT 授权，密语刷新令牌后本机 Codex 可能需要重新登录。
          </p>
        </div>
      )}
      {status.authenticated && (
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">订阅额度</span>
            <Tooltip delay={0}>
              <Button
                type="button"
                variant="tertiary"
                size="sm"
                isIconOnly
                className="size-7 min-h-7 min-w-7"
                onPress={() => void refreshUsage(true, true)}
                isDisabled={usageLoading}
                aria-label="刷新订阅额度"
              >
                {usageLoading ? <Spinner size="sm" /> : <ArrowsRotateLeft width={15} height={15} />}
              </Button>
              <Tooltip.Content>刷新订阅额度</Tooltip.Content>
            </Tooltip>
          </div>
          {quotaWindows.length > 0 ? (
            <div className="space-y-3">
              {quotaWindows.map(({ key, label, window }) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                    <span className="font-medium text-foreground">{label}</span>
                    <span className="text-muted-foreground">
                      剩余 {formatPercent(window.remainingPercent)}% · {formatResetTime(window.resetsAt)}
                    </span>
                  </div>
                  <ProgressBar
                    aria-label={`${label}剩余额度`}
                    size="sm"
                    color={quotaColor(window.remainingPercent)}
                    value={window.remainingPercent}
                  >
                    <ProgressBar.Track>
                      <ProgressBar.Fill />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              ))}
              {usage?.credits?.unlimited && (
                <div className="text-muted-foreground text-xs">额外点数：无限</div>
              )}
              {!usage?.credits?.unlimited && usage?.credits?.balance && (
                <div className="text-muted-foreground text-xs">额外点数余额：{usage.credits.balance}</div>
              )}
              {typeof usage?.resetCreditsAvailable === 'number' && usage.resetCreditsAvailable > 0 && (
                <div className="text-muted-foreground text-xs">可用额度重置次数：{usage.resetCreditsAvailable}</div>
              )}
            </div>
          ) : usageLoading && !usage ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs"><Spinner size="sm" />正在读取订阅额度...</div>
          ) : (
            <div className="text-muted-foreground text-xs">暂未返回额度信息</div>
          )}
          {usageError && <div className="mt-2 text-danger text-xs">{usageError}</div>}
        </div>
      )}
      {(error || status.error) && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>ChatGPT 连接失败</Alert.Title>
            <Alert.Description>{error || status.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  )
}
