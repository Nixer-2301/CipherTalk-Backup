/** CipherTalk 插件 SDK 类型声明（与 ciphertalk-plugin-sdk.js 对应） */

export interface SessionSummary {
  sessionId: string
  type: number
  displayName?: string
  summary: string
  lastTimestamp: number
  avatarUrl?: string
  isPinned?: boolean
  isWeCom?: boolean
  isOfficialAccount?: boolean
}

export interface ContactSummary {
  username: string
  displayName?: string
  remark?: string
  nickname?: string
  type?: string
  avatarUrl?: string
}

export interface PluginMessage {
  localId: number
  serverId: number
  /** 微信消息类型（localType） */
  type: number
  /** Unix 秒 */
  createTime: number
  sortSeq: number
  isSend: boolean
  senderUsername: string | null
  content: string
  imageMd5?: string
  videoDuration?: number
  voiceDuration?: number
  fileName?: string
  fileSize?: number
}

export interface MessageQueryOptions {
  sessionId: string
  /** Unix 秒 */
  startTime?: number
  endTime?: number
  senderId?: string
  keyword?: string
  /** 上限 2000，默认 500 */
  limit?: number
  /** 上一页返回的 nextCursor */
  cursor?: string
}

export interface MessageQueryResult {
  /** 过滤后可能少于 limit；只要有 nextCursor 就还能继续翻页 */
  rows: PluginMessage[]
  nextCursor?: string
}

export interface PluginContext {
  sessionId?: string
  sessionName?: string
}

export interface ThemePayload {
  vars: Record<string, string>
  isDark: boolean
}

export interface SnsTimelineOptions {
  limit?: number
  offset?: number
  usernames?: string[]
  keyword?: string
  startTime?: number
  endTime?: number
}

export interface SnsPost {
  id: string
  username: string
  nickname: string
  createTime: number
  content: string
  type?: number
  media: Array<{ url: string; thumbUrl: string; width?: number; height?: number }>
  likes: string[]
  comments: Array<{ nickname: string; content: string; refNickname?: string }>
}

/** 本 SDK 实现的插件 API 主版本 */
export const API_VERSION: 1
/** SDK 语义化版本 */
export const SDK_VERSION: string

export interface CipherTalkAPI {
  /** 插件 API 主版本（= API_VERSION） */
  apiVersion: number
  /** SDK 版本 */
  sdkVersion: string
  pluginId: string
  viewId: string
  context: PluginContext
  invoke(method: string, args?: Record<string, unknown>): Promise<unknown>
  capabilities(): Promise<string[]>
  onThemeChanged(listener: (theme: ThemePayload) => void): () => void
  data: {
    sessions: {
      list(opts?: { limit?: number; offset?: number }): Promise<{ sessions: SessionSummary[]; hasMore?: boolean }>
      /** 懒加载遍历全部会话，自动翻页；limit 为每页大小（默认 200） */
      iterate(opts?: { limit?: number; offset?: number }): AsyncGenerator<SessionSummary>
    }
    contacts: {
      list(opts?: { limit?: number; offset?: number }): Promise<{ contacts: ContactSummary[]; hasMore?: boolean }>
      /** 懒加载遍历全部联系人，自动翻页；limit 为每页大小（默认 200） */
      iterate(opts?: { limit?: number; offset?: number }): AsyncGenerator<ContactSummary>
      get(username: string): Promise<ContactSummary | null>
      getAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string } | null>
      getGroupMembers(chatroomId: string): Promise<Array<{ username: string; displayName: string; avatarUrl?: string }>>
    }
    messages: {
      query(opts: MessageQueryOptions): Promise<MessageQueryResult>
      /** 懒加载遍历消息（最新→旧），自动跟进 nextCursor；参数同 query，limit 为每页扫描量 */
      iterate(opts: MessageQueryOptions): AsyncGenerator<PluginMessage>
      get(sessionId: string, localId: number): Promise<PluginMessage | null>
      getDatesWithMessages(sessionId: string, year: number, month: number): Promise<string[]>
    }
  }
  ui: {
    toast(text: string, opts?: { type?: 'success' | 'error' }): Promise<void>
    navigate(viewId: string): Promise<void>
    /**
     * 宿主渲染的下拉选择——弹出层是应用内的 Select/ListBox 组件（与设置页同款）。
     * 注：<select class="ct-select"> 会被 SDK 自动接管走此通道，无需手动调用；
     * 本方法用于自定义触发器场景。返回选中值，取消返回 null。
     */
    pickOption(anchorEl: Element, opts: { options: Array<{ value: string; label: string }>; selected?: string | null }): Promise<string | null>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  clipboard: {
    write(text: string): Promise<void>
  }
  /** 需 media:read。返回的 url 为宿主签发的短时效地址（5 分钟），用完即取 */
  media: {
    getImage(opts: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; thumbnail?: boolean }): Promise<{ url: string; isThumb: boolean }>
    getVoice(opts: { sessionId: string; localId: number; createTime?: number; serverId?: number }): Promise<{ wavBase64: string }>
    getEmoji(opts: { sessionId: string; localId: number }): Promise<{ url: string }>
    getVideoInfo(videoMd5: string): Promise<{ exists: boolean; url?: string; coverUrl?: string; thumbUrl?: string }>
  }
  /** 需 stt:use。复用宿主已配置的转写引擎与缓存 */
  stt: {
    transcribe(opts: { sessionId: string; localId: number; createTime: number; serverId?: number; force?: boolean }): Promise<{ text: string; fromCache: boolean }>
    getCachedTranscript(sessionId: string, createTime: number): Promise<string | null>
  }
  /** 需 search:use */
  search: {
    query(opts: { sessionId: string; query: string; limit?: number; matchMode?: 'substring' | 'exact'; startTime?: number; endTime?: number; senderId?: string }):
      Promise<{ hits: Array<{ message: PluginMessage; excerpt: string; score: number }>; indexComplete: boolean; truncated: boolean }>
  }
  /** 需 stats:read。扫描上限 5 万条/8 秒，超限时 truncated=true */
  stats: {
    messageCounts(opts: { sessionId: string; groupBy: 'day' | 'month' | 'sender'; startTime?: number; endTime?: number }):
      Promise<{ counts: Array<{ key: string; count: number }>; scanned: number; truncated: boolean }>
  }
  /** 需 export:use。输出位置由用户在系统对话框确认；进度经 events 回报 */
  export: {
    exportSession(opts: { sessionId: string; format: 'json' | 'html' | 'txt' | 'excel' | 'sql' | 'chatlab' | 'chatlab-jsonl'; startTime?: number; endTime?: number }):
      Promise<{ taskId?: string; outputPath?: string; canceled?: boolean }>
  }
  /** 需 notify:send */
  notify: {
    send(title: string, body: string): Promise<void>
  }
  /** 需 sns:read。媒体 URL 为微信 CDN 地址，加载图片本体需 network 权限 */
  sns: {
    getTimeline(opts?: SnsTimelineOptions): Promise<{ posts: SnsPost[]; hasMore: boolean }>
    /** 懒加载遍历朋友圈时间线，自动翻页；limit 为每页大小（默认 200） */
    iterate(opts?: SnsTimelineOptions): AsyncGenerator<SnsPost>
  }
  /**
   * 需 ai:use。走用户在宿主里配置的模型与 API Key（key 对插件不可见）。
   * 预算：每插件 20 次/分钟，超出报错——请合并请求而不是逐条调用。
   */
  ai: {
    complete(opts: { prompt: string; system?: string }): Promise<{ text: string }>
    embed(texts: string[]): Promise<{ embeddings: number[][] }>
  }
  /** 需 window:create */
  window: {
    open(viewId: string, opts?: { width?: number; height?: number }): Promise<void>
  }
  /**
   * 事件订阅。newMessages 需 messages:read；
   * exportProgress / exportDone 仅发给发起导出的插件。
   */
  events: {
    on(event: 'newMessages', listener: (payload: { sessionId: string; count?: number }) => void): () => void
    on(event: 'exportProgress', listener: (payload: { taskId: string } & Record<string, unknown>) => void): () => void
    on(event: 'exportDone', listener: (payload: { taskId: string; success?: boolean; outputPath?: string; error?: string }) => void): () => void
    on(event: string, listener: (payload: unknown) => void): () => void
  }
}

/** 等待宿主握手并返回 API 实例（幂等，可多次调用） */
export function connect(): Promise<CipherTalkAPI>
