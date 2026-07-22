import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Button, TextArea } from '@heroui/react'
import { ArrowDownToLine, Copy, FileCode, FloppyDisk, Sparkles, TrashBin } from '@gravity-ui/icons'
import type { ChatSession, Message } from '../types/models'
import {
  POSTER_THEMES,
  POSTER_THEME_SCOPE,
  createCustomThemeId,
  sanitizePosterCss,
  scopePosterCss,
  type CustomPosterTheme
} from './chat/posterThemes'
import { isGroupChat, isSystemMessage } from './chat/utils/messageGuards'
import { formatDateDivider, shouldShowDateDivider } from './chat/utils/time'
import './chat/styles/_share-poster.css'

type SenderInfo = {
  name: string
  avatarUrl?: string
}

type PosterWindowContext = {
  session?: ChatSession | null
  messages: Message[]
  myAvatarUrl?: string
  sessionTitle?: string
  dateRange?: string
  sampleLines?: string[]
  themeId?: string
  focusRange?: [number, number]
  updatedAt?: number
}

function avatarLetter(name: string): string {
  const trimmed = (name || '?').trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

function formatQuoteText(message: Message): string {
  if (!message.quotedContent) return ''
  return message.quotedSender ? `${message.quotedSender}: ${message.quotedContent}` : message.quotedContent
}

function createPosterAgentRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `poster-style-${crypto.randomUUID()}`
  return `poster-style-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

function extractCssFromAgentText(text: string): string {
  const cssFence = text.match(/```css\s*([\s\S]*?)```/i)
  const anyFence = text.match(/```\s*([\s\S]*?)```/i)
  return sanitizePosterCss(cssFence?.[1] || anyFence?.[1] || text)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findRuleRange(css: string, candidates: string[]): [number, number] | null {
  const ruleRe = /[^{}]+\{[^{}]*\}/g
  for (const cand of candidates) {
    const tokenRe = new RegExp(`${escapeRegExp(cand)}(?![\\w-])`)
    ruleRe.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ruleRe.exec(css))) {
      const selector = match[0].slice(0, match[0].indexOf('{'))
      if (tokenRe.test(selector)) {
        let start = match.index
        while (start < css.length && /\s/.test(css[start])) start++
        return [start, match.index + match[0].length]
      }
    }
  }
  return null
}

function normalizeContext(value: unknown): PosterWindowContext {
  if (!value || typeof value !== 'object') return { messages: [] }
  const input = value as Record<string, unknown>
  const rawRange = input.focusRange
  const focusRange = Array.isArray(rawRange)
    && rawRange.length === 2
    && Number.isFinite(rawRange[0])
    && Number.isFinite(rawRange[1])
      ? [Number(rawRange[0]), Number(rawRange[1])] as [number, number]
      : undefined
  const sampleLines = Array.isArray(input.sampleLines)
    ? input.sampleLines.map((line) => String(line)).filter(Boolean).slice(0, 12)
    : []

  return {
    session: input.session && typeof input.session === 'object' ? input.session as ChatSession : null,
    messages: Array.isArray(input.messages) ? input.messages as Message[] : [],
    myAvatarUrl: typeof input.myAvatarUrl === 'string' ? input.myAvatarUrl : undefined,
    sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
    dateRange: typeof input.dateRange === 'string' ? input.dateRange : '',
    sampleLines,
    themeId: typeof input.themeId === 'string' ? input.themeId : '',
    focusRange,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : 0
  }
}

async function waitForAssets(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll('img'))
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true })
      img.addEventListener('error', () => resolve(), { once: true })
    })
  }))
  try { await document.fonts?.ready } catch { /* ignore */ }
}

function isSingleLinePosterBubble(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20
  const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  return el.getBoundingClientRect().height <= verticalPadding + lineHeight * 1.25
}

function lockPosterCloneLayout(source: HTMLElement, clone: HTMLElement): void {
  const sourceBubbles = Array.from(source.querySelectorAll<HTMLElement>('.poster-bubble'))
  const cloneBubbles = Array.from(clone.querySelectorAll<HTMLElement>('.poster-bubble'))

  sourceBubbles.forEach((sourceBubble, index) => {
    const cloneBubble = cloneBubbles[index]
    if (!cloneBubble) return

    const rect = sourceBubble.getBoundingClientRect()
    const singleLine = isSingleLinePosterBubble(sourceBubble)
    const width = Math.ceil(singleLine ? Math.max(rect.width, sourceBubble.scrollWidth) + 8 : rect.width)
    const height = Math.ceil(rect.height)

    cloneBubble.style.boxSizing = 'border-box'
    cloneBubble.style.width = `${width}px`
    cloneBubble.style.height = 'auto'
    cloneBubble.style.minHeight = `${height}px`
    cloneBubble.style.overflow = 'visible'
    if (singleLine && !sourceBubble.textContent?.includes('\n')) {
      cloneBubble.style.whiteSpace = 'pre'
    }
  })
}

function getPosterExportOptions(node: HTMLElement) {
  const rect = node.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const height = Math.ceil(rect.height)

  return {
    scale: 2,
    width,
    height,
    style: {
      width: `${width}px`,
      minWidth: `${width}px`,
      maxWidth: `${width}px`,
      height: `${height}px`,
      margin: '0'
    },
    onclone: (clone: HTMLElement) => lockPosterCloneLayout(node, clone)
  }
}

export default function PosterStyleWindow() {
  const cardRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLDivElement>(null)
  const [context, setContext] = useState<PosterWindowContext>({ messages: [] })
  const [senders, setSenders] = useState<Map<string, SenderInfo>>(new Map())
  const [customThemes, setCustomThemes] = useState<CustomPosterTheme[]>([])
  const [themeId, setThemeId] = useState('default')
  const [cssDraft, setCssDraft] = useState<{ id: string; css: string } | null>(null)
  const [hlRange, setHlRange] = useState<[number, number] | null>(null)
  const [agentStylePrompt, setAgentStylePrompt] = useState('')
  const [agentStyleGenerating, setAgentStyleGenerating] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)

  const session = context.session || null
  const group = isGroupChat(session?.username || '')
  const ordered = useMemo(
    () => [...(context.messages || [])].sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq),
    [context.messages]
  )
  const sessionTitle = session?.displayName || session?.username || context.sessionTitle || '聊天记录'

  const selectedCustom = useMemo(
    () => customThemes.find((t) => t.id === themeId),
    [customThemes, themeId]
  )

  const editorCss = selectedCustom
    ? (cssDraft?.id === selectedCustom.id ? cssDraft.css : selectedCustom.css)
    : ''
  const cssDirty = selectedCustom != null && editorCss !== selectedCustom.css

  const scopedThemeCss = useMemo(() => {
    const preset = POSTER_THEMES.find((t) => t.id === themeId)
    if (preset) return scopePosterCss(preset.css)
    return selectedCustom ? scopePosterCss(editorCss) : ''
  }, [editorCss, selectedCustom, themeId])

  const dateRange = useMemo(() => {
    if (ordered.length === 0) return context.dateRange || ''
    const fmt = (ts: number) => {
      const d = new Date(ts * 1000)
      return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
    }
    const first = fmt(ordered[0].createTime)
    const last = fmt(ordered[ordered.length - 1].createTime)
    return first === last ? first : `${first} - ${last}`
  }, [context.dateRange, ordered])

  const loadPosterThemeConfig = useCallback(async () => {
    const savedThemes = await window.electronAPI.config.get('posterCustomThemes')
    const savedId = await window.electronAPI.config.get('posterThemeId')
    const legacyCss = await window.electronAPI.config.get('posterCustomCss')

    let themes: CustomPosterTheme[] = Array.isArray(savedThemes)
      ? (savedThemes as CustomPosterTheme[]).filter((t) => t && t.id && typeof t.css === 'string')
      : []

    if (themes.length === 0 && typeof legacyCss === 'string' && legacyCss.trim()) {
      themes = [{ id: createCustomThemeId(), name: '我的定制', css: legacyCss, createdAt: Date.now() }]
      void window.electronAPI.config.set('posterCustomThemes', themes)
      void window.electronAPI.config.set('posterCustomCss', '')
    }

    setCustomThemes(themes)
    if (typeof savedId === 'string' && savedId) {
      setThemeId(savedId)
    } else if (themes[0]) {
      setThemeId(themes[0].id)
    }
  }, [])

  const loadContext = useCallback(async () => {
    const next = normalizeContext(await window.electronAPI.config.get('posterStyleWindowContext'))
    setContext(next)
    if (next.themeId) setThemeId(next.themeId)
    if (next.focusRange) setHlRange(next.focusRange)
  }, [])

  useEffect(() => {
    void loadPosterThemeConfig()
    void loadContext()
  }, [loadContext, loadPosterThemeConfig])

  useEffect(() => {
    return window.electronAPI.config.onChanged((payload) => {
      if (payload.key === 'posterCustomThemes' || payload.key === 'posterThemeId' || payload.key === 'posterCustomCss') {
        void loadPosterThemeConfig()
      }
      if (payload.key === 'posterStyleWindowContext') {
        const next = normalizeContext(payload.value)
        setContext(next)
        if (next.themeId) setThemeId(next.themeId)
        if (next.focusRange) setHlRange(next.focusRange)
      }
    })
  }, [loadPosterThemeConfig])

  useEffect(() => {
    if (!group) {
      setSenders(new Map())
      return
    }
    const usernames = Array.from(new Set(
      ordered
        .filter((m) => m.isSend !== 1 && m.senderUsername)
        .map((m) => m.senderUsername as string)
    ))
    if (usernames.length === 0) {
      setSenders(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const map = new Map<string, SenderInfo>()
      for (const username of usernames) {
        try {
          const result = await window.electronAPI.chat.getContactAvatar(username)
          map.set(username, { name: result?.displayName || username, avatarUrl: result?.avatarUrl })
        } catch {
          map.set(username, { name: username })
        }
      }
      if (!cancelled) setSenders(map)
    })()
    return () => { cancelled = true }
  }, [group, ordered])

  useEffect(() => {
    if (!hlRange || hlRange[1] > editorCss.length) return
    const editor = codeRef.current
    if (!editor) return

    const timer = window.setTimeout(() => {
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 16
      const line = editorCss.slice(0, hlRange[0]).split('\n').length - 1
      const top = Math.max(0, line * lineHeight - editor.clientHeight / 3)
      editor.focus()
      editor.setSelectionRange(hlRange[0], hlRange[0])
      editor.scrollTop = top
      if (hlRef.current) {
        hlRef.current.scrollTop = top
        hlRef.current.scrollLeft = editor.scrollLeft
      }
    }, 0)

    return () => window.clearTimeout(timer)
  }, [hlRange, editorCss])

  const resolveSender = (msg: Message): SenderInfo => {
    if (msg.isSend === 1) return { name: '我', avatarUrl: context.myAvatarUrl }
    if (group && msg.senderUsername) {
      return senders.get(msg.senderUsername) || { name: msg.senderUsername }
    }
    return { name: sessionTitle, avatarUrl: session?.avatarUrl }
  }

  const persistCustomThemes = (list: CustomPosterTheme[]) => {
    setCustomThemes(list)
    void window.electronAPI.config.set('posterCustomThemes', list)
  }

  const selectTheme = (id: string) => {
    setThemeId(id)
    setHlRange(null)
    void window.electronAPI.config.set('posterThemeId', id)
  }

  const deleteCustomTheme = (id: string) => {
    const next = customThemes.filter((theme) => theme.id !== id)
    persistCustomThemes(next)
    if (themeId === id) {
      const nextId = next[0]?.id || 'default'
      setThemeId(nextId)
      void window.electronAPI.config.set('posterThemeId', nextId)
    }
  }

  const handleFloppyDiskCss = () => {
    if (!selectedCustom || !cssDirty) return
    if (!scopePosterCss(editorCss)) {
      setStatusText('样式为空或属性都被过滤，请检查代码')
      return
    }
    persistCustomThemes(
      customThemes.map((theme) => (theme.id === selectedCustom.id ? { ...theme, css: editorCss } : theme))
    )
    setStatusText('样式已保存')
  }

  const handlePreviewPick = (e: ReactMouseEvent) => {
    if (!selectedCustom) {
      setStatusText('选择自定义样式后，点击预览可定位 CSS 规则')
      return
    }
    const root = cardRef.current
    if (!root) return

    let node: HTMLElement | null = e.target as HTMLElement
    let cls: string | null = null
    while (node && node !== root) {
      for (const c of Array.from(node.classList)) {
        if (c.startsWith('poster-') && c !== 'poster-message-block' && c !== 'poster-theme-scope') {
          cls = c
          break
        }
      }
      if (cls) break
      node = node.parentElement
    }
    if (!cls || !node) return

    const row = node.closest('.poster-row')
    const rowMod = row?.classList.contains('sent')
      ? 'sent'
      : row?.classList.contains('received')
        ? 'received'
        : null

    const candidates: string[] = []
    if (cls === 'poster-bubble' && rowMod) {
      candidates.push(`.poster-row.${rowMod} .poster-bubble`, '.poster-bubble')
    } else if (cls === 'poster-row' && rowMod) {
      candidates.push(`.poster-row.${rowMod}`, '.poster-row')
    } else if (cls === 'poster-divider') {
      candidates.push('.poster-divider span', '.poster-divider')
    } else {
      candidates.push(`.${cls}`)
    }

    const range = findRuleRange(editorCss, candidates)
    if (!range) {
      setStatusText('代码里还没有这部分的样式规则')
      return
    }
    setHlRange(range)
  }

  const runPosterStyleAgent = async (prompt: string): Promise<string> => {
    const runId = createPosterAgentRunId()
    let text = ''
    let chunkError = ''
    const offChunk = window.electronAPI.agent.onChunk(runId, (chunk) => {
      if (chunk === '[DONE]' || !chunk || typeof chunk !== 'object') return
      const typed = chunk as { type?: string; delta?: string; errorText?: string }
      if (typed.type === 'text-delta' && typeof typed.delta === 'string') {
        text += typed.delta
      } else if (typed.type === 'error') {
        chunkError = typed.errorText || 'Agent 生成失败'
      }
    })
    const offProgress = window.electronAPI.agent.onProgress(runId, (progress) => {
      if (!progress || typeof progress !== 'object') return
      const title = (progress as { title?: string }).title
      if (title) setStatusText(title)
    })

    try {
      const result = await window.electronAPI.agent.run(
        runId,
        [{
          id: `poster-style-user-${Date.now()}`,
          role: 'user',
          parts: [{ type: 'text', text: prompt }]
        }],
        { kind: 'global' },
        null,
        null,
        false,
        'chat',
        null
      )
      if (!result.success) throw new Error(result.error || 'Agent 生成失败')
      if (chunkError) throw new Error(chunkError)
      return text
    } finally {
      offChunk()
      offProgress()
    }
  }

  const handleGenerateAgentStyle = async () => {
    if (agentStyleGenerating) return
    const idea = agentStylePrompt.trim()
    const sampleLines = ordered.length > 0
      ? ordered
        .filter((msg) => !isSystemMessage(msg))
        .slice(0, 12)
        .map((msg) => {
          const sender = msg.isSend === 1 ? '我' : resolveSender(msg).name
          const content = (msg.parsedContent || '').replace(/\s+/g, ' ').slice(0, 90)
          return `${sender}: ${content || '（空消息）'}`
        })
        .join('\n')
      : (context.sampleLines || []).join('\n')
    const prompt = `你是 CipherTalk 海报样式设计 Agent。请为聊天记录分享海报生成一段 CSS 主题。

只输出 CSS，不要解释，不要 Markdown，除 CSS 外不要写任何文字。

可用选择器：
.poster-card
.poster-card__header
.poster-card__title
.poster-card__subtitle
.poster-divider span
.poster-system
.poster-name
.poster-row.received .poster-bubble
.poster-row.sent .poster-bubble
.poster-card__footer

只允许使用视觉属性：background、color、border、box-shadow、text-shadow、opacity、outline、filter、backdrop-filter。不要写 width、height、margin、padding、display、position、font-size、transform、animation、url()、@import。

设计要求：${idea || '根据这段聊天生成一套高级、干净、适合截图分享的中文聊天海报样式'}
会话：${sessionTitle}
日期：${dateRange || '未知'}
消息数量：${ordered.length}
消息摘录：
${sampleLines || '无'}`

    setAgentStyleGenerating(true)
    setStatusText('Agent 正在生成样式...')
    try {
      const agentText = await runPosterStyleAgent(prompt)
      const css = extractCssFromAgentText(agentText)
      if (!css || !scopePosterCss(css)) {
        throw new Error('Agent 没有生成有效 CSS')
      }

      const nameSeed = idea.replace(/\s+/g, '').slice(0, 10)
      const theme: CustomPosterTheme = {
        id: createCustomThemeId(),
        name: nameSeed ? `Agent-${nameSeed}` : `Agent 样式 ${customThemes.length + 1}`,
        css,
        createdAt: Date.now()
      }
      const next = [theme, ...customThemes]
      persistCustomThemes(next)
      setThemeId(theme.id)
      setCssDraft({ id: theme.id, css })
      setHlRange(null)
      void window.electronAPI.config.set('posterThemeId', theme.id)
      setStatusText('已生成并应用')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent 生成样式失败'
      console.error('[PosterStyleWindow] Agent 生成样式失败', error)
      setStatusText(message)
    } finally {
      setAgentStyleGenerating(false)
    }
  }

  const handleFloppyDiskImage = async () => {
    if (saving || copying) return
    const node = cardRef.current
    if (!node) return
    setSaving(true)
    try {
      await waitForAssets(node)
      const domtoimage = (await import('dom-to-image-more')).default
      const dataUrl = await (domtoimage as any).toPng(node, getPosterExportOptions(node))
      const link = document.createElement('a')
      link.download = `密语聊天记录-${Date.now()}.png`
      link.href = dataUrl
      link.click()
      setStatusText('海报已保存')
    } catch (error) {
      console.error('[PosterStyleWindow] 生成失败', error)
      setStatusText('海报生成失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyImage = async () => {
    if (saving || copying) return
    const node = cardRef.current
    if (!node) return
    setCopying(true)
    try {
      await waitForAssets(node)
      const domtoimage = (await import('dom-to-image-more')).default
      const blob: Blob = await (domtoimage as any).toBlob(node, getPosterExportOptions(node))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setStatusText('海报已复制到剪贴板')
    } catch (error) {
      console.error('[PosterStyleWindow] 复制失败', error)
      setStatusText('复制失败，请改用保存图片')
    } finally {
      setCopying(false)
    }
  }

  const busy = saving || copying

  return (
    <div className="poster-style-window-page">
      <div className="poster-editor">
        <aside className="poster-editor__sidebar" aria-label="海报样式控制">
          <section className="poster-editor__section">
            <div className="poster-editor__section-title">会话</div>
            <div className="poster-editor__session-title" title={sessionTitle}>{sessionTitle}</div>
            <div className="poster-editor__session-meta">{ordered.length} 条 · {dateRange || '未传入日期'}</div>
            {statusText && <div className="poster-editor__status">{statusText}</div>}
          </section>

          <section className="poster-editor__section poster-editor__section--themes">
            <div className="poster-editor__section-title">样式</div>
            <div className="poster-editor__theme-list">
              {POSTER_THEMES.map((theme) => (
                <Button
                  key={theme.id}
                  className={`poster-editor__theme-button${themeId === theme.id ? ' active' : ''}`}
                  size="sm"
                  variant={themeId === theme.id ? 'secondary' : 'tertiary'}
                  onPress={() => selectTheme(theme.id)}
                >
                  {theme.name}
                </Button>
              ))}
              {customThemes.map((theme) => (
                <div
                  key={theme.id}
                  className={`poster-editor__theme-row${themeId === theme.id ? ' active' : ''}`}
                  title={theme.name}
                >
                  <Button
                    className="poster-editor__theme-button poster-editor__theme-button--custom"
                    size="sm"
                    variant={themeId === theme.id ? 'secondary' : 'tertiary'}
                    onPress={() => selectTheme(theme.id)}
                  >
                    <span className="poster-editor__theme-name">{theme.name}</span>
                  </Button>
                  <Button
                    aria-label="删除该样式"
                    className="poster-editor__theme-delete"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => deleteCustomTheme(theme.id)}
                  >
                    <TrashBin width={13} height={13} />
                  </Button>
                </div>
              ))}
            </div>
          </section>

          <section className="poster-editor__section poster-editor__section--agent">
            <div className="poster-editor__section-title">Agent</div>
            <TextArea
              className="poster-editor__agent-input"
              rows={5}
              value={agentStylePrompt}
              onChange={(e) => setAgentStylePrompt(e.target.value)}
              placeholder="比如：暗黑霓虹、复古报纸、温柔奶油风..."
              disabled={agentStyleGenerating}
              variant="secondary"
            />
            <Button
              className="poster-editor__generate-button"
              fullWidth
              isDisabled={agentStyleGenerating}
              isPending={agentStyleGenerating}
              size="sm"
              variant="primary"
              onPress={() => void handleGenerateAgentStyle()}
            >
              <Sparkles width={14} height={14} />
              生成样式
            </Button>
          </section>
        </aside>

        <main className="poster-editor__main">
          <div className="poster-editor__pane-header">
            <div className="poster-editor__pane-title">
              <FileCode width={15} height={15} />
              <span>{selectedCustom ? `${selectedCustom.name}.css` : '预设样式'}</span>
              {cssDirty && <i aria-hidden="true" />}
            </div>
            <Button
              isDisabled={!selectedCustom || !cssDirty}
              size="sm"
              variant="secondary"
              onPress={handleFloppyDiskCss}
            >
              <FloppyDisk width={13} height={13} />
              保存 CSS
            </Button>
          </div>

          <section className="poster-editor__code">
            {selectedCustom ? (
              <div className="poster-css-editor poster-css-editor--designer">
                <div className="poster-css-editor__field">
                  <div className="poster-css-editor__highlight" ref={hlRef} aria-hidden="true">
                    {hlRange && hlRange[1] <= editorCss.length && (
                      <>
                        {editorCss.slice(0, hlRange[0])}
                        <mark>{editorCss.slice(hlRange[0], hlRange[1])}</mark>
                        {editorCss.slice(hlRange[1])}
                      </>
                    )}
                  </div>
                  <textarea
                    ref={codeRef}
                    className="poster-ai-input poster-css-editor__code"
                    value={editorCss}
                    onChange={(e) => {
                      setCssDraft({ id: selectedCustom.id, css: e.target.value })
                      setHlRange(null)
                    }}
                    onScroll={(e) => {
                      const hl = hlRef.current
                      if (hl) {
                        hl.scrollTop = e.currentTarget.scrollTop
                        hl.scrollLeft = e.currentTarget.scrollLeft
                      }
                    }}
                    spellCheck={false}
                  />
                </div>
              </div>
            ) : (
              <div className="poster-editor__empty">
                <Sparkles width={24} height={24} />
                <span>生成自定义样式后可编辑 CSS</span>
              </div>
            )}
          </section>
        </main>

        <aside className="poster-editor__preview-pane">
          <div className="poster-editor__pane-header poster-editor__pane-header--preview">
            <div>
              <div className="poster-editor__pane-title">海报预览</div>
              <div className="poster-editor__preview-meta">{dateRange || '未传入日期'}</div>
            </div>
            <div className="poster-editor__preview-actions">
              <Button
                isDisabled={busy || ordered.length === 0}
                isPending={copying}
                size="sm"
                variant="secondary"
                onPress={() => void handleCopyImage()}
              >
                <Copy width={14} height={14} />
                复制
              </Button>
              <Button
                isDisabled={busy || ordered.length === 0}
                isPending={saving}
                size="sm"
                variant="primary"
                onPress={() => void handleFloppyDiskImage()}
              >
                <ArrowDownToLine width={14} height={14} />
                保存图片
              </Button>
            </div>
          </div>

          <div
            className={`poster-preview poster-preview--designer${selectedCustom ? ' poster-preview--pickable' : ''}`}
            onClick={handlePreviewPick}
          >
            {ordered.length === 0 ? (
              <div className="poster-editor__empty-preview">没有可生成海报的消息</div>
            ) : (
              <div className={POSTER_THEME_SCOPE} ref={cardRef}>
                {scopedThemeCss && <style>{scopedThemeCss}</style>}
                <div className="poster-card">
                  <div className="poster-card__header">
                    <div className="poster-card__title">{sessionTitle}</div>
                    {dateRange && <div className="poster-card__subtitle">{dateRange}</div>}
                  </div>

                  <div className="poster-card__body">
                    {ordered.map((msg, index) => {
                      const prev = index > 0 ? ordered[index - 1] : undefined
                      const showDivider = shouldShowDateDivider(msg, prev)
                      const system = isSystemMessage(msg)
                      const sender = resolveSender(msg)
                      const sent = msg.isSend === 1
                      const quoteText = formatQuoteText(msg)
                      const avatar = (
                        <div className="poster-avatar">
                          {sender.avatarUrl
                            ? <img src={sender.avatarUrl} alt="" referrerPolicy="no-referrer" />
                            : <span>{avatarLetter(sender.name)}</span>}
                        </div>
                      )
                      return (
                        <div className="poster-message-block" key={`${msg.localId}-${msg.createTime}-${msg.sortSeq}`}>
                          {showDivider && (
                            <div className="poster-divider"><span>{formatDateDivider(msg.createTime)}</span></div>
                          )}
                          {system ? (
                            <div className="poster-system">{msg.parsedContent}</div>
                          ) : (
                            <div className={`poster-row ${sent ? 'sent' : 'received'}`}>
                              {avatar}
                              <div className="poster-msg">
                                {!sent && group && <div className="poster-name">{sender.name}</div>}
                                <div className="poster-bubble">{msg.parsedContent || ' '}</div>
                                {quoteText && <div className="poster-quote">{quoteText}</div>}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div className="poster-card__footer">由 密语 CipherTalk 导出</div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
