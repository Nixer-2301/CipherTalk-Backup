import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getUserDataPath } from './runtimePaths'
import type { AccountProfile, AccountProfileInput, AccountProfilePatch } from '../../src/types/account'

const ACCOUNT_FIELD_KEYS = new Set([
  'dbPath',
  'decryptKey',
  'myWxid',
  'cachePath',
  'imageXorKey',
  'imageAesKey'
])

const ACCOUNT_CONFIG_CLEAR_KEYS = [
  'decryptKey',
  'dbPath',
  'myWxid',
  'cachePath',
  'imageXorKey',
  'imageAesKey'
] as const

const IMAGE_GEN_DEFAULT_TIMEOUT_MS = 3_600_000
const IMAGE_GEN_LEGACY_DEFAULT_TIMEOUT_MS = 600_000

interface ConfigSchema {
  // 数据库相关
  dbPath: string
  decryptKey: string
  myWxid: string
  accounts: AccountProfile[]
  activeAccountId: string

  // 图片解密相关
  imageXorKey: string
  imageAesKey: string

  // 表情包缓存解密相关（逆向 Wexin.dll 确认）
  emoticonUin: string        // 微信 UIN（数字）
  emoticonKeyString: string  // vfunc@32 返回的字符串

  // 缓存相关
  cachePath: string
  lastOpenedDb: string
  lastSession: string

  // 导出相关
  exportPath: string

  // 界面相关
  theme: string
  themeMode: string
  language: string
  releaseAnnouncementVersion: string
  releaseAnnouncementId: string
  releaseAnnouncementContentId: string
  releaseAnnouncementBody: string
  releaseAnnouncementNotes: string
  releaseAnnouncementSeenVersion: string
  releaseAnnouncementSeenId: string
  releaseAnnouncementSeenContentId: string
  narrationAudioEnabled: boolean | null
  homeBackgroundSource: 'preset' | 'custom'
  homeBackgroundPreset: 'beijing' | 'beijing2'
  homeBackgroundCustomType: 'image' | 'video' | ''
  homeBackgroundCustomPath: string
  homeBackgroundCustomUrl: string
  homeBackgroundBlur: number

  // 协议相关
  agreementVersion: number

  // 激活相关
  activationData: string

  // STT 相关
  sttLanguages: string[]
  sttModelType: 'int8' | 'float32'
  sttMode: 'cpu' | 'gpu' | 'online'  // STT 模式：CPU / GPU / 在线
  whisperModelType: 'tiny' | 'base' | 'small' | 'medium'  // Whisper 模型类型
  sttOnlineProvider: 'openai-compatible' | 'aliyun-qwen-asr' | 'qianwen-cloud' | 'volcano-doubao' | 'custom'
  sttOnlineApiKey: string
  sttOnlineBaseURL: string
  sttOnlineModel: string
  sttOnlineLanguage: string
  sttOnlineTimeoutMs: number
  sttOnlineMaxConcurrency: number

  // 日志相关
  logLevel: string

  // 数据管理相关
  skipIntegrityCheck: boolean
  autoUpdateDatabase: boolean  // 是否自动更新数据库
  // 自动同步高级参数
  autoUpdateCheckInterval: number     // 检查间隔（秒）
  autoUpdateMinInterval: number       // 最小更新间隔（毫秒）
  autoUpdateDebounceTime: number      // 防抖时间（毫秒）

  // 窗口关闭行为
  closeToTray: boolean

 // 日记相关
 diarySummaryHour: number
 diaryCustomPrompt: string
  diaryEnabled: boolean

 // 性能相关
  hardwareAccelerationEnabled: boolean

  // AI 相关
  aiCurrentProvider: string  // 当前选中的提供商
  aiActiveConfigPresetId: string
  aiProviderConfigs: {  // 每个提供商的独立配置
    [providerId: string]: {
      apiKey: string
      model: string
      baseURL?: string
      protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription'
    }
  }
  aiProviderModelCache: {
    [cacheKey: string]: {
      models: string[]
      updatedAt: number
    }
  }
  agentCodeWorkspaceRoot: string
  agentCodeWorkspaceApprovalPolicy: 'on-request' | 'risk-based' | 'full-access'
  // Agent 工具审批策略（发送微信媒体/文件、导出、任务、MCP 等，见 toolApproval.ts）；语义与上面的代码工作区策略一致
  agentToolApprovalPolicy: 'on-request' | 'risk-based' | 'full-access'
  // 嵌入模型（语义/向量检索，独立于聊天模型）
  embeddingConfig: {
    enabled: boolean
    provider: string  // 选中的服务商 id（catalog），仅 UI 用于展示/自动填地址
    protocol: 'openai-compatible' | 'openai'
    apiKey: string
    baseURL: string
    model: string
    dimension: number  // 0 = 未探测；测试连接成功后回填模型实际维度
    imageEnabled?: boolean
    imageInputMode?: 'auto' | 'image_base64' | 'content_part' | 'data_url'
  }
  // 重排模型（RAG/Skills/MCP 候选重排，独立于聊天模型与嵌入模型）
  rerankConfig: {
    enabled: boolean
    provider: string
    protocol: 'openai-compatible'
    apiKey: string
    baseURL: string
    model: string
    timeoutMs: number
  }
  // 文字转语音 —— 朗读 AI 回复/微信消息/角色语音回复，独立于聊天模型
  // providers 持久化各服务商独立配置，切换服务商不会互相覆盖。
  ttsConfig: {
    enabled: boolean
    activeProvider: 'xiaomi' | 'volcengine' | 'aliyun-qwen'
    protocol: 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'
    apiKey: string
    realtimeAppId?: string
    realtimeAccessKey?: string
    baseURL: string
    model: string
    voice: string
    instructions: string
    speed: number
    providers: {
      xiaomi: {
        protocol: 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'
        apiKey: string
        realtimeAppId?: string
        realtimeAccessKey?: string
        baseURL: string
        model: string
        voice: string
        instructions: string
        speed: number
      }
      volcengine: {
        protocol: 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'
        apiKey: string
        realtimeAppId?: string
        realtimeAccessKey?: string
        baseURL: string
        model: string
        voice: string
        instructions: string
        speed: number
      }
      'aliyun-qwen': {
        protocol: 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'
        apiKey: string
        realtimeAppId?: string
        realtimeAccessKey?: string
        baseURL: string
        model: string
        voice: string
        instructions: string
        speed: number
      }
    }
  }
  // AI 作图 —— AI 助手 generate_image 工具用，独立于聊天模型
  imageGenConfig: {
    enabled: boolean
    protocol: 'openai-compatible' | 'openai' | 'google' | 'custom'
    apiKey: string
    baseURL: string
    model: string
    size: string
    timeoutMs: number
  }
  // 主进程探测到的系统代理 URL（写入后供 AI 子进程/嵌入跨进程读取；子进程无 session API 探测不了）
  aiResolvedProxyUrl: string
  // Anthropic prompt cache 断点 TTL：1h 档写入计价 2×（5m 档 1.25×），稀疏流量才划算
  anthropicCacheTtl: '5m' | '1h'
  // AI 宠物（petdex 宠物包格式，用户宠物包存放在 cachePath/pets/<slug>/）
  petCurrent: string         // 当前宠物 slug，空 = 不展示
  petDesktopEnabled: boolean  // 桌面悬浮桌宠开关
  petDefaultInitialized: boolean // 是否已执行过内置默认宠物初始化
  petPersonaSessionId: string // 桌宠快捷对话绑定的数字分身 sessionId，空 = AI 助手
  petTtsEnabled: boolean // 桌宠气泡/快捷对话是否朗读
  petDailySummaryEnabled: boolean // 桌宠每日摘要播报开关
  petDailySummaryDate: string // 最近一次每日摘要日期 YYYY-MM-DD
  petReminders: Array<{
    id: string
    text: string
    kind: 'once' | 'daily' | 'yearly'
    date?: string
    time: string
    lastFired?: string
  }>
  // 消息提醒：开启了"新消息提醒"的私聊会话用户名列表（默认全关，空数组）
  notifySessions: string[]
  replyTileEnabled: boolean
  replySuggestSessions: Record<string, { enabled?: boolean; tile?: boolean; style?: string; count?: number; deep?: boolean }>
  mcpEnabled: boolean
  mcpExposeMediaPaths: boolean
  mcpProxyPort: number
  mcpProxyToken: string
  // Agent 工具审批 HMAC 签名密钥：跨 AI utility 进程重启/App 重启保持稳定，
  // 否则每次重启换新密钥会让待处理的审批签名验证失败（见 engine.ts TOOL_APPROVAL_SECRET）
  agentToolApprovalSecret: string
  // 待处理工具审批的签名缓存落盘副本，App 完整重启后用它重建 aiHandlers.ts 里的内存 Map，
  // 否则重启后签名缓存清空、待确认卡片点了也会因"找不到缓存签名"而失败
  agentToolApprovalSignatures: Array<{ approvalId: string; toolCallId: string; signature: string; at: number }>
  localCodingAgentConfig: {
    enabled: boolean
    activeAgent: string
    agents: Record<string, {
      kind: 'codex' | 'claude-cli' | 'opencode' | 'custom'
      name: string
      executablePath: string
      argsTemplate?: string[]
      env?: Record<string, string>
      timeoutMs: number
      model?: string
    }>
  }
}

const defaults: ConfigSchema = {
  agentToolApprovalSecret: '',
  agentToolApprovalSignatures: [],
  localCodingAgentConfig: {
    enabled: false,
    activeAgent: 'codex',
    agents: {
      codex: {
        kind: 'codex',
        name: 'Codex CLI',
        executablePath: '',
        timeoutMs: 1_800_000,
      },
      claude: {
        kind: 'claude-cli',
        name: 'Claude Code',
        executablePath: '',
        timeoutMs: 1_800_000,
      },
      opencode: {
        kind: 'opencode',
        name: 'OpenCode',
        executablePath: '',
        timeoutMs: 1_800_000,
      },
    },
  },
  dbPath: '',
  decryptKey: '',
  myWxid: '',
  accounts: [],
  activeAccountId: '',
  imageXorKey: '',
  imageAesKey: '',
  emoticonUin: '',
  emoticonKeyString: '',
  cachePath: '',
  lastOpenedDb: '',
  lastSession: '',
  exportPath: '',
  theme: 'cloud-dancer',
  themeMode: 'system',
  language: 'zh-CN',
  releaseAnnouncementVersion: '',
  releaseAnnouncementId: '',
  releaseAnnouncementContentId: '',
  releaseAnnouncementBody: '',
  releaseAnnouncementNotes: '',
  releaseAnnouncementSeenVersion: '',
  releaseAnnouncementSeenId: '',
  releaseAnnouncementSeenContentId: '',
  narrationAudioEnabled: null,
  homeBackgroundSource: 'preset',
  homeBackgroundPreset: 'beijing',
  homeBackgroundCustomType: '',
  homeBackgroundCustomPath: '',
  homeBackgroundCustomUrl: '',
  homeBackgroundBlur: 0,
  sttLanguages: ['zh'],
  sttModelType: 'int8',
  sttMode: 'cpu',  // 默认使用 CPU 模式
  whisperModelType: 'small',  // 默认使用 small 模型
  sttOnlineProvider: 'openai-compatible',
  sttOnlineApiKey: '',
  sttOnlineBaseURL: 'https://api.openai.com/v1',
  sttOnlineModel: 'gpt-4o-mini-transcribe',
  sttOnlineLanguage: 'auto',
  sttOnlineTimeoutMs: 60000,
  sttOnlineMaxConcurrency: 2,
  agreementVersion: 0,
  activationData: '',
  logLevel: 'WARN', // 默认只记录警告和错误
  skipIntegrityCheck: false, // 默认进行完整性检查
  autoUpdateDatabase: true,  // 默认开启自动更新
  autoUpdateCheckInterval: 60,     // 默认 60 秒检查一次
  autoUpdateMinInterval: 1000,     // 默认最小更新间隔 1 秒
  autoUpdateDebounceTime: 500,     // 默认防抖时间 0.5 秒
  closeToTray: true,  // 默认最小化到托盘
 diarySummaryHour: 2,
 diaryCustomPrompt: '',
  diaryEnabled: true,
 hardwareAccelerationEnabled: true,
  // AI 默认配置
  aiCurrentProvider: 'deepseek',
  aiActiveConfigPresetId: '',
  aiProviderConfigs: {},  // 空对象，用户配置后填充
  aiProviderModelCache: {},
  agentCodeWorkspaceRoot: '',
  agentCodeWorkspaceApprovalPolicy: 'on-request',
  agentToolApprovalPolicy: 'on-request',
  embeddingConfig: {
    enabled: false,
    provider: '',
    protocol: 'openai-compatible',
    apiKey: '',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'BAAI/bge-m3',
    dimension: 0,
    imageEnabled: false,
    imageInputMode: 'auto',
  },
  rerankConfig: {
    enabled: false,
    provider: '',
    protocol: 'openai-compatible',
    apiKey: '',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'BAAI/bge-reranker-v2-m3',
    timeoutMs: 15000,
  },
  ttsConfig: {
    enabled: false,
    activeProvider: 'xiaomi',
    protocol: 'xiaomi-mimo-tts',
    apiKey: '',
    baseURL: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    instructions: '',
    speed: 1,
    providers: {
      xiaomi: {
        protocol: 'xiaomi-mimo-tts',
        apiKey: '',
        baseURL: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-tts',
        voice: 'mimo_default',
        instructions: '',
        speed: 1,
      },
      volcengine: {
        protocol: 'volcengine-bidirectional',
        apiKey: '',
        realtimeAppId: '',
        realtimeAccessKey: '',
        baseURL: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
        model: 'seed-tts-2.0',
        voice: 'zh_female_shuangkuaisisi_uranus_bigtts',
        instructions: '',
        speed: 1,
      },
      'aliyun-qwen': {
        protocol: 'aliyun-qwen-realtime',
        apiKey: '',
        baseURL: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        model: 'qwen3-tts-instruct-flash-realtime',
        voice: 'Cherry',
        instructions: '',
        speed: 1,
      },
    },
  },
  imageGenConfig: {
    enabled: false,
    protocol: 'openai-compatible',
    apiKey: '',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Kwai-Kolors/Kolors',
    size: '', // 空 = AI 按构图自选；填了则作 AI 未传 size 时的回退
    timeoutMs: IMAGE_GEN_DEFAULT_TIMEOUT_MS,
  },
  aiResolvedProxyUrl: '',
  anthropicCacheTtl: '5m',
  petCurrent: '',
  petDesktopEnabled: true,
  petDefaultInitialized: false,
  petPersonaSessionId: '',
  petTtsEnabled: false,
  petDailySummaryEnabled: true,
  petDailySummaryDate: '',
  petReminders: [],
  notifySessions: [],
  replyTileEnabled: false,
  replySuggestSessions: {},
  mcpEnabled: false,
  mcpExposeMediaPaths: true,
  mcpProxyPort: 5032,
  mcpProxyToken: ''
}

export class ConfigService {
  private db: Database.Database | null = null
  private dbPath: string

  constructor() {
    const userDataPath = getUserDataPath()
    this.dbPath = path.join(userDataPath, 'ciphertalk-config.db')
    this.initDatabase()
  }

  private initDatabase(): void {
    try {
      // 确保目录存在
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      this.db = new Database(this.dbPath)

      // 创建配置表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)

      // 创建 TLD 缓存表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tld_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tlds TEXT,
          updated_at INTEGER
        )
      `)



      // 初始化默认值
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
      `)

      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }

      // Tavily 联网搜索已移除，只保留模型厂商原生搜索；同时清理旧版本保存的 API Key。
      const removedWebSearchConfig = this.db.prepare("DELETE FROM config WHERE key = 'webSearchConfig'").run()
      if (removedWebSearchConfig.changes > 0) {
        console.log('[Config] 已清理旧的 Tavily 联网搜索配置')
      }

      this.migrateLegacySingleAccount()

      // 迁移：作图旧默认超时 10 分钟过短，后台图已生成时 Agent 工具可能先报超时。
      try {
        const row = this.db.prepare("SELECT value FROM config WHERE key = 'imageGenConfig'").get() as { value: string } | undefined
        if (row) {
          const cfg = JSON.parse(row.value || '{}') as { timeoutMs?: unknown }
          if (Number(cfg?.timeoutMs) === IMAGE_GEN_LEGACY_DEFAULT_TIMEOUT_MS) {
            this.db.prepare("UPDATE config SET value = ? WHERE key = 'imageGenConfig'").run(JSON.stringify({
              ...cfg,
              timeoutMs: IMAGE_GEN_DEFAULT_TIMEOUT_MS,
            }))
            console.log('[Config] AI 作图默认超时已迁移到 1 小时')
          }
        }
      } catch (e) {
        console.error('迁移 AI 作图超时配置失败:', e)
      }

      // 迁移：修复旧版本产生的空 STT 语言配置，默认为中文
      try {
        const sttRow = this.db.prepare("SELECT value FROM config WHERE key = 'sttLanguages'").get() as { value: string } | undefined
        if (sttRow) {
          const langs = JSON.parse(sttRow.value)
          if (Array.isArray(langs) && langs.length === 0) {
            this.db.prepare("UPDATE config SET value = ? WHERE key = 'sttLanguages'").run(JSON.stringify(['zh']))
          }
        }
      } catch (e) {
        console.error('迁移 STT 配置失败:', e)
      }

      // 迁移：将旧的 AI 配置迁移到新结构（支持多提供商）
      try {
        const oldProviderRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiProvider'").get() as { value: string } | undefined
        const oldApiKeyRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiApiKey'").get() as { value: string } | undefined
        const oldModelRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiModel'").get() as { value: string } | undefined

        if (oldProviderRow && oldApiKeyRow) {
          const oldProvider = JSON.parse(oldProviderRow.value)
          const oldApiKey = JSON.parse(oldApiKeyRow.value)
          const oldModel = oldModelRow ? JSON.parse(oldModelRow.value) : ''

          // 如果有旧配置且 API Key 不为空，迁移到新结构
          if (oldApiKey) {
            const newConfigs: any = {}
            newConfigs[oldProvider] = {
              apiKey: oldApiKey,
              model: oldModel
            }

            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiCurrentProvider', JSON.stringify(oldProvider))
            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiProviderConfigs', JSON.stringify(newConfigs))

            // 删除旧配置
            this.db.prepare("DELETE FROM config WHERE key IN ('aiProvider', 'aiApiKey', 'aiModel')").run()

            console.log('[Config] AI 配置已迁移到新结构')
          }
        }
      } catch (e) {
        console.error('迁移 AI 配置失败:', e)
      }

      // 迁移：兼容旧字段 baseUrl -> baseURL
      try {
        const aiConfigsRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiProviderConfigs'").get() as { value: string } | undefined
        if (aiConfigsRow) {
          const aiConfigs = JSON.parse(aiConfigsRow.value || '{}') as Record<string, any>
          let changed = false

          for (const providerId of Object.keys(aiConfigs)) {
            const cfg = aiConfigs[providerId]
            if (cfg && !cfg.baseURL && cfg.baseUrl) {
              cfg.baseURL = cfg.baseUrl
              delete cfg.baseUrl
              changed = true
            }
          }

          if (changed) {
            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiProviderConfigs', JSON.stringify(aiConfigs))
            console.log('[Config] AI 提供商配置字段已迁移: baseUrl -> baseURL')
          }
        }
      } catch (e) {
        console.error('迁移 AI baseURL 字段失败:', e)
      }

      // 迁移：旧版本默认 AI 厂商为智谱；未保存任何 AI 配置时切到新的默认 DeepSeek
      try {
        const currentProviderRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiCurrentProvider'").get() as { value: string } | undefined
        const aiConfigsRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiProviderConfigs'").get() as { value: string } | undefined
        const currentProvider = currentProviderRow ? JSON.parse(currentProviderRow.value || '""') : ''
        const aiConfigs = aiConfigsRow ? JSON.parse(aiConfigsRow.value || '{}') : {}
        const hasSavedAIConfig = Object.values(aiConfigs || {}).some((config: any) => (
          Boolean(config?.apiKey || config?.model || config?.baseURL || config?.baseUrl)
        ))

        if (currentProvider === 'zhipu' && !hasSavedAIConfig) {
          this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiCurrentProvider', JSON.stringify('deepseek'))
          console.log('[Config] 默认 AI 提供商已切换为 DeepSeek')
        }
      } catch (e) {
        console.error('迁移默认 AI 提供商失败:', e)
      }
    } catch (e) {
      console.error('初始化配置数据库失败:', e)
    }
  }

  private getStoredValue<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    if (!this.db) {
      return defaults[key]
    }

    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    if (row) {
      return JSON.parse(row.value)
    }

    return defaults[key]
  }

  private setStoredValue<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `).run(key, JSON.stringify(value))
  }

  private createAccountId(): string {
    return `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private normalizeAccountInput(profile: Partial<AccountProfileInput>, fallback?: AccountProfile): Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'> {
    const wxid = String(profile.wxid ?? fallback?.wxid ?? '').trim()
    const dbPath = String(profile.dbPath ?? fallback?.dbPath ?? '').trim()
    const decryptKey = String(profile.decryptKey ?? fallback?.decryptKey ?? '').trim()
    const cachePath = String(profile.cachePath ?? fallback?.cachePath ?? '').trim()
    const imageXorKey = String(profile.imageXorKey ?? fallback?.imageXorKey ?? '').trim()
    const imageAesKey = String(profile.imageAesKey ?? fallback?.imageAesKey ?? '').trim()
    // 旧账号 blob 无此字段时默认空串（即迁移）。
    const wechatNumber = String(profile.wechatNumber ?? fallback?.wechatNumber ?? '').trim()
    const phone = String(profile.phone ?? fallback?.phone ?? '').trim()
    const rawDisplayName = profile.displayName ?? fallback?.displayName ?? wxid ?? ''
    const displayName = String(rawDisplayName).trim() || wxid || '未命名账号'

    return {
      wxid,
      dbPath,
      decryptKey,
      cachePath,
      imageXorKey,
      imageAesKey,
      wechatNumber,
      phone,
      displayName
    }
  }

  private normalizeAccountProfile(raw: any): AccountProfile {
    const now = Date.now()
    const base = this.normalizeAccountInput(raw || {})
    return {
      id: String(raw?.id || this.createAccountId()),
      ...base,
      createdAt: Number(raw?.createdAt) || now,
      updatedAt: Number(raw?.updatedAt) || now,
      lastUsedAt: Number(raw?.lastUsedAt) || now
    }
  }

  private getAccountsRaw(): AccountProfile[] {
    const accounts = this.getStoredValue('accounts')
    if (!Array.isArray(accounts)) return []
    return accounts.map((item) => this.normalizeAccountProfile(item))
  }

  private setAccountsRaw(accounts: AccountProfile[]): void {
    this.setStoredValue('accounts', accounts)
  }

  private getActiveAccountIdRaw(): string {
    return String(this.getStoredValue('activeAccountId') || '')
  }

  private setActiveAccountIdRaw(accountId: string): void {
    this.setStoredValue('activeAccountId', accountId)
  }

  private getAccountFieldValue(account: AccountProfile | null, key: keyof ConfigSchema): any {
    if (!account) return defaults[key]

    switch (key) {
      case 'dbPath':
        return account.dbPath
      case 'decryptKey':
        return account.decryptKey
      case 'myWxid':
        return account.wxid
      case 'cachePath':
        return account.cachePath
      case 'imageXorKey':
        return account.imageXorKey
      case 'imageAesKey':
        return account.imageAesKey
      default:
        return defaults[key]
    }
  }

  private setAccountField(account: AccountProfile, key: keyof ConfigSchema, value: any): AccountProfile {
    const next = { ...account, updatedAt: Date.now() }
    const normalized = String(value ?? '').trim()

    switch (key) {
      case 'dbPath':
        next.dbPath = normalized
        break
      case 'decryptKey':
        next.decryptKey = normalized
        break
      case 'myWxid':
        next.wxid = normalized
        if (!next.displayName || next.displayName === account.wxid || next.displayName === '未命名账号') {
          next.displayName = normalized || '未命名账号'
        }
        break
      case 'cachePath':
        next.cachePath = normalized
        break
      case 'imageXorKey':
        next.imageXorKey = normalized
        break
      case 'imageAesKey':
        next.imageAesKey = normalized
        break
    }

    return next
  }

  private ensureActiveAccount(): AccountProfile {
    const active = this.getActiveAccount()
    if (active) return active

    const empty = this.normalizeAccountProfile({
      id: this.createAccountId(),
      displayName: '未命名账号'
    })
    const accounts = [...this.getAccountsRaw(), empty]
    this.setAccountsRaw(accounts)
    this.setActiveAccountIdRaw(empty.id)
    return empty
  }

  private migrateLegacySingleAccount(): void {
    const accounts = this.getAccountsRaw()
    if (accounts.length > 0) return

    const dbPath = String(this.getStoredValue('dbPath') || '').trim()
    const decryptKey = String(this.getStoredValue('decryptKey') || '').trim()
    const wxid = String(this.getStoredValue('myWxid') || '').trim()
    const cachePath = String(this.getStoredValue('cachePath') || '').trim()
    const imageXorKey = String(this.getStoredValue('imageXorKey') || '').trim()
    const imageAesKey = String(this.getStoredValue('imageAesKey') || '').trim()

    if (!dbPath && !decryptKey && !wxid && !cachePath && !imageXorKey && !imageAesKey) {
      return
    }

    const now = Date.now()
    const migrated = this.normalizeAccountProfile({
      id: this.createAccountId(),
      wxid,
      dbPath,
      decryptKey,
      cachePath,
      imageXorKey,
      imageAesKey,
      displayName: wxid || '未命名账号',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })

    this.setAccountsRaw([migrated])
    this.setActiveAccountIdRaw(migrated.id)
  }

  listAccounts(): AccountProfile[] {
    return this.getAccountsRaw()
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.displayName.localeCompare(b.displayName))
  }

  getActiveAccount(): AccountProfile | null {
    const accounts = this.getAccountsRaw()
    if (accounts.length === 0) return null

    const activeId = this.getActiveAccountIdRaw()
    const active = accounts.find((item) => item.id === activeId)
    return active || accounts[0]
  }

  setActiveAccount(accountId: string): AccountProfile | null {
    const accounts = this.getAccountsRaw()
    const target = accounts.find((item) => item.id === accountId)
    if (!target) return null

    const now = Date.now()
    const nextAccounts = accounts.map((item) => (
      item.id === accountId ? { ...item, lastUsedAt: now, updatedAt: now } : item
    ))
    this.setAccountsRaw(nextAccounts)
    this.setActiveAccountIdRaw(accountId)
    return nextAccounts.find((item) => item.id === accountId) || null
  }

  saveAccount(profile: AccountProfileInput): AccountProfile {
    const accounts = this.getAccountsRaw()
    const now = Date.now()
    const normalized = this.normalizeAccountInput(profile)
    const duplicate = accounts.find((item) => item.wxid === normalized.wxid && item.dbPath === normalized.dbPath)

    if (duplicate) {
      const updated: AccountProfile = {
        ...duplicate,
        ...normalized,
        updatedAt: now,
        lastUsedAt: duplicate.lastUsedAt || now
      }
      const nextAccounts = accounts.map((item) => item.id === duplicate.id ? updated : item)
      this.setAccountsRaw(nextAccounts)
      return updated
    }

    const created: AccountProfile = {
      id: this.createAccountId(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }
    this.setAccountsRaw([...accounts, created])
    if (!this.getActiveAccountIdRaw()) {
      this.setActiveAccountIdRaw(created.id)
    }
    return created
  }

  updateAccount(accountId: string, patch: AccountProfilePatch): AccountProfile | null {
    const accounts = this.getAccountsRaw()
    const current = accounts.find((item) => item.id === accountId)
    if (!current) return null

    const normalized = this.normalizeAccountInput(patch, current)
    const next: AccountProfile = {
      ...current,
      ...normalized,
      updatedAt: Date.now()
    }
    const nextAccounts = accounts.map((item) => item.id === accountId ? next : item)
    this.setAccountsRaw(nextAccounts)
    return next
  }

  deleteAccount(accountId: string): { deleted: AccountProfile | null; nextActiveAccountId: string } {
    const accounts = this.getAccountsRaw()
    const deleted = accounts.find((item) => item.id === accountId) || null
    if (!deleted) {
      return { deleted: null, nextActiveAccountId: this.getActiveAccountIdRaw() }
    }

    const remaining = accounts.filter((item) => item.id !== accountId)
    this.setAccountsRaw(remaining)

    let nextActiveAccountId = this.getActiveAccountIdRaw()
    if (nextActiveAccountId === accountId) {
      nextActiveAccountId = remaining[0]?.id || ''
      this.setActiveAccountIdRaw(nextActiveAccountId)
    }

    if (remaining.length === 0) {
      this.setActiveAccountIdRaw('')
    }

    return { deleted, nextActiveAccountId }
  }

  clearCurrentAccount(): AccountProfile | null {
    const active = this.getActiveAccount()
    if (!active) return null
    const next = this.updateAccount(active.id, {
      wxid: '',
      dbPath: '',
      decryptKey: '',
      cachePath: '',
      imageXorKey: '',
      imageAesKey: '',
      displayName: '未命名账号'
    })
    return next
  }

  clearAllAccountsAndAccountConfig(): void {
    this.setAccountsRaw([])
    this.setActiveAccountIdRaw('')
    for (const key of ACCOUNT_CONFIG_CLEAR_KEYS) {
      this.setStoredValue(key, '' as any)
    }
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    try {
      if (ACCOUNT_FIELD_KEYS.has(key as string)) {
        const active = this.getActiveAccount()
        return this.getAccountFieldValue(active, key)
      }

      return this.getStoredValue(key)
    } catch (e) {
      console.error(`获取配置 ${key} 失败:`, e)
      return defaults[key]
    }
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    try {
      if (ACCOUNT_FIELD_KEYS.has(key as string)) {
        const active = this.ensureActiveAccount()
        const updated = this.setAccountField(active, key, value)
        const accounts = this.getAccountsRaw().map((item) => item.id === active.id ? updated : item)
        this.setAccountsRaw(accounts)
        if (!this.getActiveAccountIdRaw()) {
          this.setActiveAccountIdRaw(updated.id)
        }
        return
      }

      this.setStoredValue(key, value)
    } catch (e) {
      console.error(`设置配置 ${key} 失败:`, e)
    }
  }

  getAll(): ConfigSchema {
    try {
      if (!this.db) {
        return { ...defaults }
      }
      const rows = this.db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]
      const result = { ...defaults }
      for (const row of rows) {
        if (row.key in defaults) {
          (result as any)[row.key] = JSON.parse(row.value)
        }
      }
      const active = this.getActiveAccount()
      if (active) {
        result.dbPath = active.dbPath
        result.decryptKey = active.decryptKey
        result.myWxid = active.wxid
        result.cachePath = active.cachePath
        result.imageXorKey = active.imageXorKey
        result.imageAesKey = active.imageAesKey
      }
      return result
    } catch (e) {
      console.error('获取所有配置失败:', e)
      return { ...defaults }
    }
  }

  clear(): void {
    try {
      if (!this.db) return
      this.db.exec('DELETE FROM config')
      // 重新插入默认值
      const insertStmt = this.db.prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
      `)
      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }
    } catch (e) {
      console.error('清除配置失败:', e)
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // TLD 缓存相关方法
  getTldCache(): { tlds: string[]; updatedAt: number } | null {
    try {
      if (!this.db) return null
      const row = this.db.prepare('SELECT tlds, updated_at FROM tld_cache WHERE id = 1').get() as { tlds: string; updated_at: number } | undefined
      if (row) {
        return {
          tlds: JSON.parse(row.tlds),
          updatedAt: row.updated_at
        }
      }
      return null
    } catch (e) {
      console.error('获取 TLD 缓存失败:', e)
      return null
    }
  }

  setTldCache(tlds: string[]): void {
    try {
      if (!this.db) return
      const now = Date.now()
      this.db.prepare(`
        INSERT OR REPLACE INTO tld_cache (id, tlds, updated_at) VALUES (1, ?, ?)
      `).run(JSON.stringify(tlds), now)
    } catch (e) {
      console.error('设置 TLD 缓存失败:', e)
    }
  }

  // AI 配置便捷方法
  getAICurrentProvider(): string {
    return this.get('aiCurrentProvider')
  }

  setAICurrentProvider(provider: string): void {
    this.set('aiCurrentProvider', provider)
  }

  getAIProviderConfig(providerId: string): { apiKey: string; model: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' } | null {
    const configs = this.get('aiProviderConfigs') as any
    const providerConfig = configs?.[providerId]
    if (!providerConfig) return null

    // 兼容历史字段 baseUrl
    if (!providerConfig.baseURL && providerConfig.baseUrl) {
      providerConfig.baseURL = providerConfig.baseUrl
    }

    return providerConfig
  }

  setAIProviderConfig(providerId: string, config: { apiKey: string; model: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' }): void {
    const configs = this.get('aiProviderConfigs')
    configs[providerId] = config
    this.set('aiProviderConfigs', configs)
  }

  getAllAIProviderConfigs(): { [providerId: string]: { apiKey: string; model: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' } } {
    return this.get('aiProviderConfigs')
  }

  getCacheBasePath(): string {
    const configured = this.get('cachePath')
    if (configured && configured.trim().length > 0) {
      return configured
    }
    return path.join(getUserDataPath(), 'CipherTalk')
  }
}
