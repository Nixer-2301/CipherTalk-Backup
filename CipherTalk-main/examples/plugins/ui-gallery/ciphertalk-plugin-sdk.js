/**
 * CipherTalk 插件 SDK（单文件 ESM，无依赖）。
 *
 * 用法：
 *   import { connect } from './ciphertalk-plugin-sdk.js'
 *   const api = await connect()
 *   const { sessions } = await api.data.sessions.list()
 *
 * 通信协议（与宿主 PluginHost 对应）：
 * - 宿主在 iframe load 后 postMessage { type:'ciphertalk:connect', pluginId, viewId, context, theme } + MessagePort
 * - RPC：port 上发 { type:'invoke', id, method, args }，收 { type:'result', id, ok, data, error }
 * - 主题：连接时注入一次，宿主切换主题后推送 { type:'theme', theme }
 */

/** 本 SDK 实现的插件 API 主版本；须与 manifest.apiVersion 一致 */
export const API_VERSION = 1
/** SDK 语义化版本，便于开发者日志/上报 */
export const SDK_VERSION = '1.1.0'

/**
 * offset 翻页 → 异步迭代器：按需逐页取数，消费多少拉多少（懒加载）。
 * opts.limit 作为每页大小，其余参数透传给宿主。
 */
function iterateByOffset(fetchPage, pickItems, opts = {}) {
  const { limit = 200, offset: start = 0, ...rest } = opts
  return (async function* () {
    let offset = start
    for (;;) {
      const res = await fetchPage({ ...rest, limit, offset })
      const items = pickItems(res) ?? []
      yield* items
      if (!res?.hasMore || items.length === 0) return
      offset += items.length
    }
  })()
}

/** 游标翻页 → 异步迭代器（消息查询用），带过滤时也会翻到 nextCursor 耗尽为止 */
function iterateByCursor(fetchPage, pickItems, opts = {}) {
  return (async function* () {
    let cursor = opts.cursor
    for (;;) {
      const res = await fetchPage({ ...opts, cursor })
      yield* pickItems(res) ?? []
      cursor = res?.nextCursor
      if (!cursor) return
    }
  })()
}

/** 把宿主主题 tokens 应用到插件页 :root，观感与宿主一致 */
function applyTheme(theme) {
  if (!theme || !theme.vars) return
  const root = document.documentElement
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value)
  }
  root.classList.toggle('dark', !!theme.isDark)
  root.style.colorScheme = theme.isDark ? 'dark' : 'light'
}

/** 注入宿主统一 UI 组件样式（.ct-btn / .ct-input / .ct-select / .ct-switch / .ct-card 等） */
function applyUiKit(css) {
  if (!css || document.getElementById('ciphertalk-ui-kit')) return
  const style = document.createElement('style')
  style.id = 'ciphertalk-ui-kit'
  style.textContent = css
  // 插到 head 最前面，插件自己的样式可以覆盖
  document.head.prepend(style)
}

/**
 * 接管 <select class="ct-select">：屏蔽系统弹出层，
 * 改由宿主用应用内 Select/ListBox 组件（与设置页同款）弹出，结果写回并派发 change。
 */
function enhanceSelects(invoke) {
  let opening = false
  const openFor = async (sel) => {
    if (opening) return
    opening = true
    try {
      const rect = sel.getBoundingClientRect()
      const options = Array.from(sel.options).map((o) => ({
        value: o.value,
        label: o.label || o.textContent || o.value,
      }))
      const result = await invoke('ui.pickOption', {
        anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        options,
        selected: sel.value || null,
      })
      const value = result && result.value
      if (value != null && value !== sel.value) {
        sel.value = value
        sel.dispatchEvent(new Event('input', { bubbles: true }))
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } catch {
      // 宿主拒绝（如已有弹层打开）时静默忽略
    } finally {
      opening = false
    }
  }

  document.addEventListener('mousedown', (e) => {
    const sel = e.target instanceof Element ? e.target.closest('select.ct-select') : null
    if (!sel || sel.disabled) return
    e.preventDefault()
    sel.focus()
    void openFor(sel)
  }, true)

  document.addEventListener('keydown', (e) => {
    const sel = e.target
    if (!(sel instanceof HTMLSelectElement) || !sel.classList.contains('ct-select') || sel.disabled) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      void openFor(sel)
    }
  }, true)
}

let connectPromise = null

export function connect() {
  if (connectPromise) return connectPromise
  connectPromise = new Promise((resolve) => {
    window.addEventListener('message', function onConnect(event) {
      const data = event.data
      if (data?.type !== 'ciphertalk:connect' || !event.ports?.[0]) return
      window.removeEventListener('message', onConnect)

      const port = event.ports[0]
      applyTheme(data.theme)
      applyUiKit(data.uiKit)

      // 下面 invoke 定义后再接管 ct-select（宿主渲染弹出层）
      let invokeRef = null
      enhanceSelects((method, args) => invokeRef ? invokeRef(method, args) : Promise.reject(new Error('未连接')))

      let nextId = 1
      const pending = new Map()
      const themeListeners = new Set()
      const eventListeners = new Map() // event -> Set<fn>

      port.onmessage = (e) => {
        const msg = e.data
        if (msg?.type === 'result' && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.ok) res(msg.data)
          else rej(new Error(msg.error || '调用失败'))
        } else if (msg?.type === 'theme') {
          applyTheme(msg.theme)
          for (const listener of themeListeners) listener(msg.theme)
        } else if (msg?.type === 'event') {
          const listeners = eventListeners.get(msg.event)
          if (listeners) for (const listener of listeners) listener(msg.payload)
        }
      }

      /** 通用 RPC；具体方法见下方 data/ui/storage 等命名空间 */
      function invoke(method, args) {
        return new Promise((res, rej) => {
          const id = nextId++
          pending.set(id, { resolve: res, reject: rej })
          port.postMessage({ type: 'invoke', id, method, args: args ?? {} })
        })
      }
      invokeRef = invoke

      resolve({
        apiVersion: API_VERSION,
        sdkVersion: SDK_VERSION,
        pluginId: data.pluginId,
        viewId: data.viewId,
        /** 视图上下文：聊天工具栏按钮打开时包含 sessionId 等 */
        context: data.context ?? {},
        invoke,
        /** 宿主支持的方法名列表，用于能力探测与优雅降级 */
        capabilities: () => invoke('host.capabilities'),
        onThemeChanged: (listener) => {
          themeListeners.add(listener)
          return () => themeListeners.delete(listener)
        },
        data: {
          sessions: {
            list: (opts) => invoke('data.sessions.list', opts),
            /** 懒加载遍历全部会话：for await (const s of api.data.sessions.iterate()) */
            iterate: (opts) => iterateByOffset((a) => invoke('data.sessions.list', a), (r) => r?.sessions, opts),
          },
          contacts: {
            list: (opts) => invoke('data.contacts.list', opts),
            /** 懒加载遍历全部联系人，自动翻页 */
            iterate: (opts) => iterateByOffset((a) => invoke('data.contacts.list', a), (r) => r?.contacts, opts),
            get: (username) => invoke('data.contacts.get', { username }),
            getAvatar: (username) => invoke('data.contacts.getAvatar', { username }),
            getGroupMembers: (chatroomId) => invoke('data.contacts.getGroupMembers', { chatroomId }),
          },
          messages: {
            query: (opts) => invoke('data.messages.query', opts),
            /** 懒加载遍历消息（最新→旧），自动跟进 nextCursor；参数同 query */
            iterate: (opts) => iterateByCursor((a) => invoke('data.messages.query', a), (r) => r?.rows, opts),
            get: (sessionId, localId) => invoke('data.messages.get', { sessionId, localId }),
            getDatesWithMessages: (sessionId, year, month) =>
              invoke('data.messages.getDatesWithMessages', { sessionId, year, month }),
          },
        },
        ui: {
          toast: (text, opts) => invoke('ui.toast', { text, type: opts?.type }),
          navigate: (viewId) => invoke('ui.navigate', { viewId }),
          /** 宿主渲染的下拉选择（应用内同款组件）；anchorEl 为触发元素 */
          pickOption: async (anchorEl, opts) => {
            const rect = anchorEl.getBoundingClientRect()
            const result = await invoke('ui.pickOption', {
              anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              options: opts.options,
              selected: opts.selected ?? null,
            })
            return result ? result.value ?? null : null
          },
        },
        storage: {
          get: (key) => invoke('storage.get', { key }),
          set: (key, value) => invoke('storage.set', { key, value }),
          delete: (key) => invoke('storage.delete', { key }),
        },
        clipboard: {
          write: (text) => invoke('clipboard.write', { text }),
        },
        media: {
          getImage: (opts) => invoke('media.getImage', opts),
          getVoice: (opts) => invoke('media.getVoice', opts),
          getEmoji: (opts) => invoke('media.getEmoji', opts),
          getVideoInfo: (videoMd5) => invoke('media.getVideoInfo', { videoMd5 }),
        },
        stt: {
          transcribe: (opts) => invoke('stt.transcribe', opts),
          getCachedTranscript: (sessionId, createTime) =>
            invoke('stt.getCachedTranscript', { sessionId, createTime }),
        },
        search: {
          query: (opts) => invoke('search.query', opts),
        },
        stats: {
          messageCounts: (opts) => invoke('stats.messageCounts', opts),
        },
        export: {
          exportSession: (opts) => invoke('export.exportSession', opts),
        },
        notify: {
          send: (title, body) => invoke('notify.send', { title, body }),
        },
        sns: {
          getTimeline: (opts) => invoke('sns.getTimeline', opts),
          /** 懒加载遍历朋友圈时间线，自动翻页；参数同 getTimeline */
          iterate: (opts) => iterateByOffset((a) => invoke('sns.getTimeline', a), (r) => r?.posts, opts),
        },
        ai: {
          complete: (opts) => invoke('ai.complete', opts),
          embed: (texts) => invoke('ai.embed', { texts }),
        },
        window: {
          open: (viewId, opts) => invoke('window.open', { viewId, ...opts }),
        },
        events: {
          on: (event, listener) => {
            if (!eventListeners.has(event)) eventListeners.set(event, new Set())
            eventListeners.get(event).add(listener)
            return () => eventListeners.get(event)?.delete(listener)
          },
        },
      })
    })
  })
  return connectPromise
}
