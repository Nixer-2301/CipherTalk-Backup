import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import {
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
  OPENAI_OAUTH_REDIRECT_URI,
  OPENAI_OAUTH_SCOPE,
  createPkceCodes,
  credentialsFromTokens,
  ensureCodexAccountsMigrated,
  exchangeOpenAIAuthorizationCode,
  getActiveCodexAccountId,
  getCodexSubscriptionAuthPath,
  getValidCodexSubscriptionCredentials,
  listCodexAccounts,
  readCodexCliCredentials,
  readCodexSubscriptionCredentials,
  removeCodexAccount,
  setActiveCodexAccount,
  upsertCodexAccount,
} from './codexSubscriptionAuth'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export type CodexSubscriptionStatus = {
  available: boolean
  authenticated: boolean
  email?: string
  planType?: string
  requiresOpenaiAuth?: boolean
  error?: string
}

export type CodexAccount = {
  id: string
  email?: string
  planType?: string
  active: boolean
  addedAt: number
}

export type CodexSubscriptionModel = {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort?: string
}

export type CodexSubscriptionUsageWindow = {
  usedPercent: number
  remainingPercent: number
  windowDurationMins?: number
  resetsAt?: number
}

export type CodexSubscriptionRateLimit = {
  limitId: string
  limitName?: string
  primary?: CodexSubscriptionUsageWindow
  secondary?: CodexSubscriptionUsageWindow
}

export type CodexSubscriptionUsage = {
  rateLimits: CodexSubscriptionRateLimit[]
  planType?: string
  credits?: {
    hasCredits?: boolean
    unlimited?: boolean
    balance?: string
  }
  resetCreditsAvailable?: number
  fetchedAt: number
}

const LOGIN_TIMEOUT_MS = 5 * 60_000
const OAUTH_PORT = 1455
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_CACHE_MS = 30_000

export const CODEX_SUBSCRIPTION_MODELS: CodexSubscriptionModel[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', description: '最新通用 Codex 模型', isDefault: true, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', description: '通用推理与工具调用模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', description: '更快的轻量模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: '低延迟 Codex 模型', isDefault: false, hidden: false, defaultReasoningEffort: 'medium' },
]

type PendingLogin = {
  loginId: string
  verifier: string
  state: string
  timeout: NodeJS.Timeout
}

function callbackHtml(success: boolean, message: string): string {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character)
  const title = success ? 'ChatGPT 登录完成' : 'ChatGPT 登录失败'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f8;color:#202123}.box{max-width:520px;padding:32px}.title{font-size:22px;font-weight:650;margin-bottom:12px}.desc{line-height:1.6;color:#565869}</style></head><body><main class="box"><div class="title">${escapeHtml(title)}</div><div class="desc">${escapeHtml(message)}</div></main><script>setTimeout(()=>window.close(),1200)</script></body></html>`
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function recordKeys(value: unknown): string[] {
  return Object.keys(asRecord(value) || {}).sort()
}

function usagePayloadShape(value: unknown): Record<string, unknown> {
  const payload = asRecord(value)
  if (!payload) return { payloadType: Array.isArray(value) ? 'array' : typeof value }
  const rateLimit = asRecord(payload.rate_limit ?? payload.rateLimits)
  const additional = payload.additional_rate_limits !== undefined ? payload.additional_rate_limits : payload.additionalRateLimits
  const additionalRecord = asRecord(additional)
  return {
    rootKeys: Object.keys(payload).sort(),
    rateLimitKeys: recordKeys(rateLimit),
    primaryKeys: recordKeys(rateLimit?.primary ?? rateLimit?.primary_window),
    secondaryKeys: recordKeys(rateLimit?.secondary ?? rateLimit?.secondary_window),
    additionalType: additional === null ? 'null' : (Array.isArray(additional) ? 'array' : (additionalRecord ? 'object' : typeof additional)),
    additionalCount: Array.isArray(additional) ? additional.length : Object.keys(additionalRecord || {}).length,
    additionalKeys: Array.isArray(additional)
      ? additional.slice(0, 5).map((item) => recordKeys(item))
      : Object.keys(additionalRecord || {}).sort(),
    creditsKeys: recordKeys(payload.credits),
    resetCreditsKeys: recordKeys(payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits),
  }
}

function parseUsageWindow(value: unknown): CodexSubscriptionUsageWindow | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const rawUsedPercent = finiteNumber(record.used_percent ?? record.usedPercent)
  if (rawUsedPercent === undefined) return undefined
  const usedPercent = Math.min(100, Math.max(0, rawUsedPercent))
  const directWindowMins = finiteNumber(record.window_minutes ?? record.windowDurationMins)
  const windowSeconds = finiteNumber(record.limit_window_seconds ?? record.limitWindowSeconds)
  const windowDurationMins = directWindowMins ?? (windowSeconds !== undefined && windowSeconds > 0
    ? Math.ceil(windowSeconds / 60)
    : undefined)
  const resetsAt = finiteNumber(record.reset_at ?? record.resetsAt)
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

function parseRateLimit(value: unknown, fallbackId: string, fallbackName?: string): CodexSubscriptionRateLimit | undefined {
  const outer = asRecord(value)
  if (!outer) return undefined
  const details = asRecord(outer.rate_limit ?? outer.rateLimit) ?? outer
  const primary = parseUsageWindow(details.primary ?? details.primary_window)
  const secondary = parseUsageWindow(details.secondary ?? details.secondary_window)
  if (!primary && !secondary) return undefined
  return {
    limitId: nonEmptyString(outer.limit_id ?? outer.limitId ?? outer.metered_feature ?? outer.meteredFeature ?? outer.metered_limit_name ?? outer.meteredLimitName) || fallbackId,
    ...(nonEmptyString(outer.limit_name ?? outer.limitName) || fallbackName
      ? { limitName: nonEmptyString(outer.limit_name ?? outer.limitName) || fallbackName }
      : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  }
}

function parseAdditionalRateLimits(value: unknown): CodexSubscriptionRateLimit[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const parsed = parseRateLimit(item, `codex_${index + 1}`)
      return parsed ? [parsed] : []
    })
  }
  const record = asRecord(value)
  if (!record) return []
  return Object.entries(record).flatMap(([limitId, item]) => {
    const parsed = parseRateLimit(item, limitId, limitId)
    return parsed ? [parsed] : []
  })
}

function parseCredits(value: unknown): CodexSubscriptionUsage['credits'] {
  const record = asRecord(value)
  if (!record) return undefined
  const hasCredits = typeof (record.has_credits ?? record.hasCredits) === 'boolean'
    ? Boolean(record.has_credits ?? record.hasCredits)
    : undefined
  const unlimited = typeof record.unlimited === 'boolean' ? record.unlimited : undefined
  const balance = nonEmptyString(record.balance)
  if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined
  return {
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
    ...(balance !== undefined ? { balance } : {}),
  }
}

function parseUsagePayload(value: unknown): CodexSubscriptionUsage {
  const payload = asRecord(value)
  if (!payload) throw new Error('ChatGPT 返回了无法识别的额度数据')
  const main = parseRateLimit(payload.rate_limit ?? payload.rateLimits, 'codex')
  const additional = parseAdditionalRateLimits(payload.additional_rate_limits ?? payload.additionalRateLimits)
  const rateLimits = main ? [main, ...additional.filter((item) => item.limitId !== main.limitId)] : additional
  const resetCredits = asRecord(payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits)
  const resetCreditsAvailable = finiteNumber(resetCredits?.available_count ?? resetCredits?.availableCount)
  const credits = parseCredits(payload.credits)
  return {
    rateLimits,
    ...(nonEmptyString(payload.plan_type ?? payload.planType) ? { planType: nonEmptyString(payload.plan_type ?? payload.planType) } : {}),
    ...(credits ? { credits } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    fetchedAt: Date.now(),
  }
}

class CodexSubscriptionService {
  private server: Server | null = null
  private pendingLogin: PendingLogin | null = null
  private statusListeners = new Set<(status: CodexSubscriptionStatus) => void>()
  private usageCache: CodexSubscriptionUsage | null = null

  onStatusChanged(listener: (status: CodexSubscriptionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async getStatus(refreshToken = false): Promise<CodexSubscriptionStatus> {
    try {
      await ensureCodexAccountsMigrated()
      let credentials = await readCodexSubscriptionCredentials()
      if (credentials && refreshToken) {
        credentials = await getValidCodexSubscriptionCredentials({
          authFilePath: getCodexSubscriptionAuthPath(),
          baseFetch: createProxyFetch(getResolvedProxyUrl()),
        })
      }
      return {
        available: true,
        authenticated: Boolean(credentials?.accessToken && credentials?.refreshToken),
        email: credentials?.email,
        planType: credentials?.planType,
        requiresOpenaiAuth: !credentials,
      }
    } catch (error) {
      return {
        available: true,
        authenticated: false,
        requiresOpenaiAuth: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.ensureServer()
    this.cancelPendingLogin()

    const loginId = randomBytes(16).toString('hex')
    const state = randomBytes(32).toString('base64url')
    const pkce = createPkceCodes()
    const timeout = setTimeout(() => {
      if (this.pendingLogin?.loginId !== loginId) return
      this.pendingLogin = null
      this.closeServer()
      void this.emitCurrentStatus('ChatGPT 登录超时，请重新尝试')
    }, LOGIN_TIMEOUT_MS)
    this.pendingLogin = { loginId, verifier: pkce.verifier, state, timeout }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OPENAI_OAUTH_CLIENT_ID,
      redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
      scope: OPENAI_OAUTH_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'ciphertalk',
      state,
    })
    return {
      loginId,
      authUrl: `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`,
    }
  }

  /** 退出「当前账号」：删除它并自动切到剩下的账号。 */
  async logout(): Promise<void> {
    this.cancelPendingLogin()
    this.closeServer()
    const activeId = getActiveCodexAccountId()
    if (activeId) await removeCodexAccount(activeId)
    this.usageCache = null
    this.emitStatus(await this.getStatus())
  }

  /** 从本机 Codex CLI 的登录导入一份凭据并另存为一个账号，只读不改 CLI 文件。 */
  async importFromCodexCli(): Promise<void> {
    this.cancelPendingLogin()
    await upsertCodexAccount(await readCodexCliCredentials())
    this.usageCache = null
    this.emitStatus(await this.getStatus())
  }

  async listAccounts(): Promise<CodexAccount[]> {
    const accounts = await listCodexAccounts()
    const activeId = getActiveCodexAccountId()
    return accounts.map((account) => ({
      id: account.id,
      email: account.credentials.email,
      planType: account.credentials.planType,
      active: account.id === activeId,
      addedAt: account.addedAt,
    }))
  }

  async setActiveAccount(id: string): Promise<void> {
    await setActiveCodexAccount(id)
    this.usageCache = null
    this.emitStatus(await this.getStatus())
  }

  async removeAccount(id: string): Promise<void> {
    await removeCodexAccount(id)
    this.usageCache = null
    this.emitStatus(await this.getStatus())
  }

  async getUsage(forceRefresh = false): Promise<CodexSubscriptionUsage> {
    if (!forceRefresh && this.usageCache && Date.now() - this.usageCache.fetchedAt < USAGE_CACHE_MS) {
      console.info('[codex-subscription:usage] 使用缓存', {
        ageMs: Date.now() - this.usageCache.fetchedAt,
        rateLimitCount: this.usageCache.rateLimits.length,
      })
      return this.usageCache
    }
    const startedAt = Date.now()
    const proxyFetch = createProxyFetch(getResolvedProxyUrl())
    console.info('[codex-subscription:usage] 开始请求', {
      forceRefresh,
      proxyEnabled: Boolean(proxyFetch),
    })
    let credentials = await getValidCodexSubscriptionCredentials({
      authFilePath: getCodexSubscriptionAuthPath(),
      baseFetch: proxyFetch,
    })
    console.info('[codex-subscription:usage] 凭据就绪', {
      hasAccountId: Boolean(credentials.accountId),
      expiresInMs: credentials.expiresAt - Date.now(),
    })
    const usageFetch = proxyFetch ?? globalThis.fetch
    const requestUsage = (accessToken: string, accountId?: string) => {
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        originator: 'ciphertalk',
        'User-Agent': `CipherTalk/${process.platform}-${process.arch}`,
      })
      if (accountId) headers.set('ChatGPT-Account-Id', accountId)
      return usageFetch(USAGE_URL, { method: 'GET', headers })
    }
    let response = await requestUsage(credentials.accessToken, credentials.accountId)
    console.info('[codex-subscription:usage] 收到响应', {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      elapsedMs: Date.now() - startedAt,
    })
    if (response.status === 401) {
      console.warn('[codex-subscription:usage] 首次请求返回 401，刷新令牌后重试')
      credentials = await getValidCodexSubscriptionCredentials({
        authFilePath: getCodexSubscriptionAuthPath(),
        baseFetch: proxyFetch,
        forceRefresh: true,
      })
      response = await requestUsage(credentials.accessToken, credentials.accountId)
      console.info('[codex-subscription:usage] 刷新令牌后的响应', {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        elapsedMs: Date.now() - startedAt,
      })
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim()
      console.error('[codex-subscription:usage] 请求失败', {
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        errorCode: (() => {
          try {
            const parsed = JSON.parse(detail) as { code?: unknown }
            return typeof parsed.code === 'string' ? parsed.code : undefined
          } catch {
            return undefined
          }
        })(),
      })
      if (response.status === 401) throw new Error('ChatGPT 登录已失效，请退出后重新登录')
      throw new Error(`获取 ChatGPT 订阅额度失败 (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }
    const payload: unknown = await response.json()
    console.info('[codex-subscription:usage] 响应结构', usagePayloadShape(payload))
    const usage = parseUsagePayload(payload)
    console.info('[codex-subscription:usage] 解析完成', {
      elapsedMs: Date.now() - startedAt,
      rateLimitCount: usage.rateLimits.length,
      windows: usage.rateLimits.map((limit) => ({
        limitId: limit.limitId,
        hasPrimary: Boolean(limit.primary),
        hasSecondary: Boolean(limit.secondary),
        primaryWindowMins: limit.primary?.windowDurationMins,
        secondaryWindowMins: limit.secondary?.windowDurationMins,
      })),
      hasCredits: Boolean(usage.credits),
      resetCreditsAvailable: usage.resetCreditsAvailable,
    })
    if (usage.rateLimits.length === 0) {
      console.warn('[codex-subscription:usage] 接口请求成功，但没有解析出额度窗口；请根据上方“响应结构”检查字段名')
    }
    this.usageCache = usage
    return usage
  }

  async listModels(): Promise<CodexSubscriptionModel[]> {
    const status = await this.getStatus(true)
    if (!status.authenticated) throw new Error(status.error || '请先登录 ChatGPT 账号')
    return CODEX_SUBSCRIPTION_MODELS.map((model) => ({ ...model }))
  }

  shutdown(): void {
    this.cancelPendingLogin()
    this.closeServer()
    this.statusListeners.clear()
  }

  private async ensureServer(): Promise<void> {
    if (this.server?.listening) return
    if (this.server) {
      this.server.close()
      this.server = null
    }
    const server = createServer((request, response) => {
      void this.handleCallback(request.url || '/', response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(new Error(`无法启动 ChatGPT 登录回调服务（端口 ${OAUTH_PORT}）：${error.message}`))
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(OAUTH_PORT, '127.0.0.1')
    })
    this.server = server
  }

  private async handleCallback(requestUrl: string, response: import('http').ServerResponse): Promise<void> {
    const url = new URL(requestUrl, `http://localhost:${OAUTH_PORT}`)
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const pending = this.pendingLogin
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!pending || state !== pending.state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, '登录状态无效或已经过期，请回到密语重新登录。'))
      return
    }

    this.cancelPendingLogin()
    if (oauthError || !code) {
      const message = oauthError || 'OpenAI 未返回授权码'
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, message))
      this.closeServer()
      await this.emitCurrentStatus(message)
      return
    }

    try {
      const tokens = await exchangeOpenAIAuthorizationCode(code, pending.verifier, createProxyFetch(getResolvedProxyUrl()))
      const credentials = credentialsFromTokens(tokens)
      if (!credentials.refreshToken) throw new Error('OpenAI OAuth 响应缺少 refresh_token')
      await upsertCodexAccount(credentials)
      this.usageCache = null
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(true, '授权信息已保存到密语，可以关闭这个页面。'))
      this.closeServer()
      this.emitStatus(await this.getStatus())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(callbackHtml(false, message))
      this.closeServer()
      await this.emitCurrentStatus(message)
    }
  }

  private cancelPendingLogin(): void {
    if (this.pendingLogin) clearTimeout(this.pendingLogin.timeout)
    this.pendingLogin = null
  }

  private closeServer(): void {
    this.server?.close()
    this.server = null
  }

  private async emitCurrentStatus(error?: string): Promise<void> {
    const status = await this.getStatus()
    this.emitStatus(error && !status.authenticated ? { ...status, error } : status)
  }

  private emitStatus(status: CodexSubscriptionStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(status) } catch { /* ignore listener failures */ }
    }
  }
}

export const codexSubscriptionService = new CodexSubscriptionService()
