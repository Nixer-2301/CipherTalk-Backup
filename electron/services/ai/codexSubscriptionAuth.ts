import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { getCipherTalkCodexHome } from '../runtimePaths.ts'

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access'
export const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_SUBSCRIPTION_DUMMY_API_KEY = 'ciphertalk-oauth-dummy-key'

const TOKEN_REFRESH_MARGIN_MS = 60_000
const refreshPromises = new Map<string, Promise<CodexSubscriptionCredentials>>()

export type OpenAITokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export type CodexSubscriptionCredentials = {
  version: 1
  accessToken: string
  refreshToken: string
  expiresAt: number
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
}

export type OpenAIJwtClaims = {
  email?: string
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  'https://api.openai.com/profile.email'?: string
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth.chatgpt_account_id'?: string
  'https://api.openai.com/auth.chatgpt_plan_type'?: string
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
  }
}

export type CodexSubscriptionFetchOptions = {
  authFilePath: string
  baseFetch?: typeof globalThis.fetch
  forceRefresh?: boolean
  now?: () => number
  refreshTokens?: (refreshToken: string) => Promise<OpenAITokenResponse>
  userAgent?: string
}

/** 密语存放 ChatGPT 登录的根目录；禁止被 CIPHERTALK_CODEX_HOME 指向本机 Codex 的 ~/.codex。 */
function getCodexHomeSafe(): string {
  const home = path.resolve(getCipherTalkCodexHome())
  const cliHome = path.resolve(path.dirname(getCodexCliAuthPath()))
  if (home.toLowerCase() === cliHome.toLowerCase()) {
    throw new Error('密语的 ChatGPT 登录目录不能设置为电脑上的 ~/.codex')
  }
  return home
}

function getCodexAccountsDir(): string {
  return path.join(getCodexHomeSafe(), 'accounts')
}

function getCodexActivePointerPath(): string {
  return path.join(getCodexHomeSafe(), 'active.json')
}

function getLegacyCodexAuthPath(): string {
  return path.join(getCodexHomeSafe(), 'auth.json')
}

function sanitizeAccountId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

function accountFilePath(id: string): string {
  return path.join(getCodexAccountsDir(), `${sanitizeAccountId(id)}.json`)
}

/** 读取「当前账号」指针（同步，供路径解析用）；无则返回 null。 */
export function getActiveCodexAccountId(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(getCodexActivePointerPath(), 'utf8')) as { activeId?: unknown }
    const id = typeof parsed.activeId === 'string' ? sanitizeAccountId(parsed.activeId.trim()) : ''
    return id || null
  } catch {
    return null
  }
}

/**
 * 「当前账号」凭据文件路径。Agent / 状态 / 额度全都读它，刷新令牌也写它——
 * 指向哪个账号由 active.json 决定，切换账号即改指针，下游无需感知。
 * 迁移前（旧单账号）回退到 <home>/auth.json，保持老用户零感知。
 */
export function getCodexSubscriptionAuthPath(): string {
  const activeId = getActiveCodexAccountId()
  return activeId ? accountFilePath(activeId) : getLegacyCodexAuthPath()
}

export type StoredCodexAccount = {
  id: string
  credentials: CodexSubscriptionCredentials
  addedAt: number
}

/** 去重键：同一 OpenAI 账号（accountId 优先，退到 email）只保留一份，重复登录即覆盖。 */
function accountDedupeKey(credentials: CodexSubscriptionCredentials): string | null {
  const accountId = credentials.accountId?.trim()
  if (accountId) return `account:${accountId}`
  const email = credentials.email?.trim().toLowerCase()
  return email ? `email:${email}` : null
}

let accountsMigrated = false

/** 把旧的单账号 <home>/auth.json 迁移成 accounts/<id>.json + active 指针；只跑一次。 */
export async function ensureCodexAccountsMigrated(): Promise<void> {
  if (accountsMigrated) return
  if (getActiveCodexAccountId()) {
    accountsMigrated = true
    return
  }
  const legacy = await readCodexSubscriptionCredentials(getLegacyCodexAuthPath())
  if (legacy) {
    const id = randomBytes(8).toString('hex')
    await writeCodexSubscriptionCredentials(legacy, accountFilePath(id))
    await writeActiveCodexPointer(id)
    await rm(getLegacyCodexAuthPath(), { force: true })
  }
  accountsMigrated = true
}

async function writeActiveCodexPointer(id: string): Promise<void> {
  const home = getCodexHomeSafe()
  await mkdir(home, { recursive: true })
  const temporaryPath = path.join(home, `.active-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify({ activeId: sanitizeAccountId(id) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, getCodexActivePointerPath())
}

/** 列出所有账号（按加入时间升序），凭据原样带回，映射成对外结构由上层做。 */
export async function listCodexAccounts(): Promise<StoredCodexAccount[]> {
  await ensureCodexAccountsMigrated()
  let names: string[]
  try {
    names = await readdir(getCodexAccountsDir())
  } catch {
    return []
  }
  const accounts: StoredCodexAccount[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const filePath = path.join(getCodexAccountsDir(), name)
    const credentials = await readCodexSubscriptionCredentials(filePath)
    if (!credentials) continue
    let addedAt = 0
    try { addedAt = (await stat(filePath)).mtimeMs } catch { /* 取不到时间就置 0 */ }
    accounts.push({ id: name.slice(0, -5), credentials, addedAt })
  }
  return accounts.sort((a, b) => a.addedAt - b.addedAt)
}

/** 新增/更新一个账号并设为当前；同一账号重复登录则覆盖旧记录。返回账号 id。 */
export async function upsertCodexAccount(credentials: CodexSubscriptionCredentials): Promise<string> {
  await ensureCodexAccountsMigrated()
  const key = accountDedupeKey(credentials)
  let id: string | undefined
  if (key) {
    const existing = await listCodexAccounts()
    id = existing.find((account) => accountDedupeKey(account.credentials) === key)?.id
  }
  if (!id) id = randomBytes(8).toString('hex')
  await writeCodexSubscriptionCredentials(credentials, accountFilePath(id))
  await writeActiveCodexPointer(id)
  return id
}

export async function setActiveCodexAccount(id: string): Promise<void> {
  const credentials = await readCodexSubscriptionCredentials(accountFilePath(id))
  if (!credentials) throw new Error('该账号不存在或登录已失效，请重新登录')
  await writeActiveCodexPointer(id)
}

/** 删除一个账号；若删的是当前账号，自动切到剩下的第一个，没有则清空指针。 */
export async function removeCodexAccount(id: string): Promise<void> {
  await rm(accountFilePath(id), { force: true })
  if (getActiveCodexAccountId() === sanitizeAccountId(id)) {
    const rest = await listCodexAccounts()
    if (rest.length > 0) await writeActiveCodexPointer(rest[0].id)
    else await rm(getCodexActivePointerPath(), { force: true })
  }
}

/** 本机 Codex CLI 的凭据文件路径（尊重 CODEX_HOME 覆盖），密语只读不写。 */
export function getCodexCliAuthPath(): string {
  const codexHome = String(process.env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex')
  return path.resolve(codexHome, 'auth.json')
}

export function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

export function createPkceCodes(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function parseJwtClaims(token?: string): OpenAIJwtClaims | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as OpenAIJwtClaims : undefined
  } catch {
    return undefined
  }
}

/** 从 JWT access_token 的 exp 声明解出毫秒级过期时间；解不出返回 undefined。 */
export function parseJwtExpiry(token?: string): number | undefined {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export function extractOpenAIAccountInfo(tokens: Pick<OpenAITokenResponse, 'id_token' | 'access_token'>): {
  accountId?: string
  email?: string
  planType?: string
} {
  const claims = [parseJwtClaims(tokens.id_token), parseJwtClaims(tokens.access_token)].filter(Boolean) as OpenAIJwtClaims[]
  let accountId: string | undefined
  let email: string | undefined
  let planType: string | undefined
  for (const claim of claims) {
    accountId ||= claim.chatgpt_account_id
      || claim['https://api.openai.com/auth.chatgpt_account_id']
      || claim['https://api.openai.com/auth']?.chatgpt_account_id
      || claim.organizations?.[0]?.id
    email ||= claim.email || claim['https://api.openai.com/profile.email'] || claim['https://api.openai.com/profile']?.email
    planType ||= claim['https://api.openai.com/auth.chatgpt_plan_type'] || claim['https://api.openai.com/auth']?.chatgpt_plan_type
  }
  return { accountId, email, planType }
}

export function credentialsFromTokens(
  tokens: OpenAITokenResponse,
  previous?: CodexSubscriptionCredentials | null,
  now = Date.now(),
): CodexSubscriptionCredentials {
  const account = extractOpenAIAccountInfo(tokens)
  return {
    version: 1,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || previous?.refreshToken || '',
    expiresAt: now + Math.max(1, tokens.expires_in ?? 3600) * 1000,
    ...(tokens.id_token || previous?.idToken ? { idToken: tokens.id_token || previous?.idToken } : {}),
    ...(account.accountId || previous?.accountId ? { accountId: account.accountId || previous?.accountId } : {}),
    ...(account.email || previous?.email ? { email: account.email || previous?.email } : {}),
    ...(account.planType || previous?.planType ? { planType: account.planType || previous?.planType } : {}),
  }
}

export async function readCodexSubscriptionCredentials(authFilePath = getCodexSubscriptionAuthPath()): Promise<CodexSubscriptionCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(authFilePath, 'utf8')) as Partial<CodexSubscriptionCredentials>
    if (parsed.version !== 1 || !parsed.accessToken || !parsed.refreshToken || !Number.isFinite(parsed.expiresAt)) return null
    return parsed as CodexSubscriptionCredentials
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

type CodexCliAuthFile = {
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
}

/**
 * 从本机 Codex CLI 的 ~/.codex/auth.json 解析出一份凭据（只读、不改 CLI 文件）。
 * 保留 access_token 的真实过期时间，避免立刻触发刷新（刷新会轮换 refresh_token，
 * 可能把本机 Codex 的登录挤掉）。落盘交给上层的 upsertCodexAccount。
 */
export async function readCodexCliCredentials(
  cliAuthPath = getCodexCliAuthPath(),
): Promise<CodexSubscriptionCredentials> {
  let raw: string
  try {
    raw = await readFile(cliAuthPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`未找到本机 Codex 登录文件（${cliAuthPath}），请先用 Codex CLI 登录 ChatGPT 账号`)
    }
    throw error
  }

  let parsed: CodexCliAuthFile
  try {
    parsed = JSON.parse(raw) as CodexCliAuthFile
  } catch {
    throw new Error('本机 Codex 登录文件格式无法解析')
  }

  const tokens = parsed.tokens
  if (!tokens?.access_token || !tokens.refresh_token) {
    throw new Error('本机 Codex 登录未包含可用的 OAuth 令牌（可能是 API Key 模式），请改用「登录 ChatGPT」')
  }

  const account = extractOpenAIAccountInfo({ id_token: tokens.id_token, access_token: tokens.access_token })
  return {
    version: 1,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    // 解不出 exp 时用 0（立即过期）→ 首次请求走 refresh_token 换新令牌
    expiresAt: parseJwtExpiry(tokens.access_token) ?? 0,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    ...(account.accountId || tokens.account_id ? { accountId: account.accountId || tokens.account_id } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
  }
}

export async function writeCodexSubscriptionCredentials(
  credentials: CodexSubscriptionCredentials,
  authFilePath = getCodexSubscriptionAuthPath(),
): Promise<void> {
  const directory = path.dirname(authFilePath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.auth-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, authFilePath)
}

async function requestTokens(body: URLSearchParams, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  const tokenFetch = baseFetch ?? globalThis.fetch
  const response = await tokenFetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim()
    throw new Error(`OpenAI OAuth token 请求失败 (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  return response.json() as Promise<OpenAITokenResponse>
}

export function exchangeOpenAIAuthorizationCode(code: string, verifier: string, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  }), baseFetch)
}

export function refreshOpenAIAccessToken(refreshToken: string, baseFetch?: typeof globalThis.fetch): Promise<OpenAITokenResponse> {
  return requestTokens(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  }), baseFetch)
}

export async function getValidCodexSubscriptionCredentials(options: CodexSubscriptionFetchOptions): Promise<CodexSubscriptionCredentials> {
  const current = await readCodexSubscriptionCredentials(options.authFilePath)
  if (!current) throw new Error('请先登录 ChatGPT 账号')
  const now = (options.now ?? Date.now)()
  if (!options.forceRefresh && current.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) return current

  let pending = refreshPromises.get(options.authFilePath)
  if (!pending) {
    const refresh = options.refreshTokens ?? ((refreshToken: string) => refreshOpenAIAccessToken(refreshToken, options.baseFetch))
    pending = refresh(current.refreshToken)
      .then(async (tokens) => {
        const credentials = credentialsFromTokens(tokens, current, now)
        if (!credentials.refreshToken) throw new Error('OpenAI OAuth 刷新响应缺少 refresh_token')
        await writeCodexSubscriptionCredentials(credentials, options.authFilePath)
        return credentials
      })
      .finally(() => refreshPromises.delete(options.authFilePath))
    refreshPromises.set(options.authFilePath, pending)
  }
  return pending
}

function responseRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

async function sanitizeResponsesBody(input: RequestInfo | URL, init?: RequestInit): Promise<BodyInit | null | undefined> {
  const directBody = init?.body
  let text: string | null = typeof directBody === 'string' ? directBody : null
  if (text === null && typeof Request !== 'undefined') {
    try {
      text = await new Request(input, init).clone().text()
    } catch {
      return directBody
    }
  }
  if (!text) return directBody
  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(payload, 'max_output_tokens')) return directBody ?? text
    delete payload.max_output_tokens
    return JSON.stringify(payload)
  } catch {
    return directBody
  }
}

export function createCodexSubscriptionFetch(options: CodexSubscriptionFetchOptions): typeof globalThis.fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sourceUrl = responseRequestUrl(input)
    if (!sourceUrl.pathname.includes('/v1/responses')) return baseFetch(input, init)

    const credentials = await getValidCodexSubscriptionCredentials(options)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.delete('authorization')
    headers.set('Authorization', `Bearer ${credentials.accessToken}`)
    headers.set('originator', 'ciphertalk')
    headers.set('User-Agent', options.userAgent || `CipherTalk/${process.platform}-${process.arch}`)
    if (credentials.accountId) headers.set('ChatGPT-Account-Id', credentials.accountId)
    else headers.delete('ChatGPT-Account-Id')

    const body = await sanitizeResponsesBody(input, init)
    if (body !== init?.body) headers.delete('content-length')
    return baseFetch(CHATGPT_CODEX_RESPONSES_URL, {
      ...init,
      method: init?.method || (input instanceof Request ? input.method : 'POST'),
      headers,
      body,
    })
  }) as typeof globalThis.fetch
}
