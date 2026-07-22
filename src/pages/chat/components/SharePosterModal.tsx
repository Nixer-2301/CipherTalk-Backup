import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ArrowDownToLine, CircleDashed, Code, Copy, Xmark } from '@gravity-ui/icons'
import type { ChatSession, Message } from '../../../types/models'
import { isGroupChat, isSystemMessage } from '../utils/messageGuards'
import { formatDateDivider, shouldShowDateDivider } from '../utils/time'
import {
  POSTER_THEMES,
  POSTER_THEME_SCOPE,
  createCustomThemeId,
  scopePosterCss,
  type CustomPosterTheme
} from '../posterThemes'

interface SenderInfo {
  name: string
  avatarUrl?: string
}

interface SharePosterModalProps {
  session: ChatSession
  messages: Message[]
  myAvatarUrl?: string
  onClose: () => void
  showTopToast: (text: string, success?: boolean) => void
}

function avatarLetter(name: string): string {
  const trimmed = (name || '?').trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

function formatQuoteText(message: Message): string {
  if (!message.quotedContent) return ''
  return message.quotedSender ? `${message.quotedSender}: ${message.quotedContent}` : message.quotedContent
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
  // 字体未就绪会让 SVG 重排时回退字体，导致换行与高度和预览不一致
  try { await document.fonts?.ready } catch { /* 忽略 */ }
}

function posterClassOf(el: Element): string | null {
  for (const c of Array.from(el.classList)) {
    if (c.startsWith('poster-') && c !== 'poster-message-block' && c !== 'poster-theme-scope') {
      return c
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在 CSS 文本中按优先级查找第一条命中候选选择器的规则，返回其字符区间 [起, 止] */
function findRuleRange(css: string, candidates: string[]): [number, number] | null {
  const ruleRe = /[^{}]+\{[^{}]*\}/g
  for (const cand of candidates) {
    const tokenRe = new RegExp(`${escapeRegExp(cand)}(?![\\w-])`)
    ruleRe.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ruleRe.exec(css))) {
      const selector = match[0].slice(0, match[0].indexOf('{'))
      if (tokenRe.test(selector)) {
        // 规则前的换行/空白也被 [^{}]+ 吞进来了，跳过它们
        let start = match.index
        while (start < css.length && /\s/.test(css[start])) start++
        return [start, match.index + match[0].length]
      }
    }
  }
  return null
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

export function SharePosterModal({ session, messages, myAvatarUrl, onClose, showTopToast }: SharePosterModalProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [senders, setSenders] = useState<Map<string, SenderInfo>>(new Map())
  const group = isGroupChat(session.username)

  const [themeId, setThemeId] = useState('default')
  const [customThemes, setCustomThemes] = useState<CustomPosterTheme[]>([])

  const ordered = useMemo(
    () => [...messages].sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq),
    [messages]
  )

  const loadPosterThemeConfig = useCallback(async () => {
    try {
      const savedThemes = await window.electronAPI.config.get('posterCustomThemes')
      const savedId = await window.electronAPI.config.get('posterThemeId')
      const legacyCss = await window.electronAPI.config.get('posterCustomCss')

      let themes: CustomPosterTheme[] = Array.isArray(savedThemes)
        ? (savedThemes as CustomPosterTheme[]).filter((t) => t && t.id && typeof t.css === 'string')
        : []

      // 旧版单槽位自定义样式迁移进样式库
      if (themes.length === 0 && typeof legacyCss === 'string' && legacyCss.trim()) {
        themes = [{ id: createCustomThemeId(), name: '我的定制', css: legacyCss, createdAt: Date.now() }]
        void window.electronAPI.config.set('posterCustomThemes', themes)
        void window.electronAPI.config.set('posterCustomCss', '')
      }

      setCustomThemes(themes)
      if (typeof savedId === 'string' && savedId) setThemeId(savedId)
    } catch {
      /* 使用默认主题 */
    }
  }, [])

  // 读取并监听已保存的自定义样式库与上次选择的主题
  useEffect(() => {
    void loadPosterThemeConfig()
  }, [loadPosterThemeConfig])

  useEffect(() => {
    return window.electronAPI.config.onChanged((payload) => {
      if (payload.key === 'posterCustomThemes' || payload.key === 'posterThemeId' || payload.key === 'posterCustomCss') {
        void loadPosterThemeConfig()
      }
    })
  }, [loadPosterThemeConfig])

  // 解析群聊发送者头像 / 昵称
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
  }, [ordered, group])

  const selectedCustom = useMemo(
    () => customThemes.find((t) => t.id === themeId),
    [customThemes, themeId]
  )

  const scopedThemeCss = useMemo(() => {
    const preset = POSTER_THEMES.find((t) => t.id === themeId)
    if (preset) return scopePosterCss(preset.css)
    return selectedCustom ? scopePosterCss(selectedCustom.css) : ''
  }, [themeId, selectedCustom])

  const resolveSender = (msg: Message): SenderInfo => {
    if (msg.isSend === 1) return { name: '我', avatarUrl: myAvatarUrl }
    if (group && msg.senderUsername) {
      return senders.get(msg.senderUsername) || { name: msg.senderUsername }
    }
    return { name: session.displayName || session.username, avatarUrl: session.avatarUrl }
  }

  const dateRange = useMemo(() => {
    if (ordered.length === 0) return ''
    const fmt = (ts: number) => {
      const d = new Date(ts * 1000)
      return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
    }
    const first = fmt(ordered[0].createTime)
    const last = fmt(ordered[ordered.length - 1].createTime)
    return first === last ? first : `${first} - ${last}`
  }, [ordered])

  const selectTheme = (id: string) => {
    setThemeId(id)
    void window.electronAPI.config.set('posterThemeId', id)
  }

  const persistCustomThemes = (list: CustomPosterTheme[]) => {
    setCustomThemes(list)
    void window.electronAPI.config.set('posterCustomThemes', list)
  }

  const deleteCustomTheme = (id: string) => {
    const list = customThemes.filter((t) => t.id !== id)
    persistCustomThemes(list)
    if (themeId === id) selectTheme('default')
  }

  const buildStyleWindowContext = (focusRange?: [number, number]) => {
    const sessionTitle = session.displayName || session.username
    const sampleLines = ordered
      .filter((msg) => !isSystemMessage(msg))
      .slice(0, 12)
      .map((msg) => {
        const sender = msg.isSend === 1 ? '我' : resolveSender(msg).name
        const content = (msg.parsedContent || '').replace(/\s+/g, ' ').slice(0, 90)
        return `${sender}: ${content || '（空消息）'}`
      })
    return {
      sessionTitle,
      dateRange,
      messageCount: ordered.length,
      sampleLines,
      themeId,
      focusRange,
      updatedAt: Date.now()
    }
  }

  const openStyleWorkbench = async (focusRange?: [number, number]) => {
    try {
      await window.electronAPI.config.set('posterStyleWindowContext', buildStyleWindowContext(focusRange))
      await window.electronAPI.window.openPosterStyleWindow()
    } catch (error) {
      console.error('[SharePoster] 打开样式工作台失败', error)
      showTopToast('打开样式工作台失败', false)
    }
  }

  // 点击预览元素 → 在代码框里定位并选中对应的样式规则
  const handlePreviewPick = (e: ReactMouseEvent) => {
    const root = cardRef.current
    if (!selectedCustom || !root) return

    let node: HTMLElement | null = e.target as HTMLElement
    let cls: string | null = null
    while (node && node !== root) {
      cls = posterClassOf(node)
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

    const range = findRuleRange(selectedCustom.css, candidates)
    if (!range) {
      showTopToast('代码里还没有这部分的样式规则', false)
      return
    }

    void openStyleWorkbench(range)
  }

  const handleSave = async () => {
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
      showTopToast('海报已保存', true)
    } catch (e) {
      console.error('[SharePoster] 生成失败', e)
      showTopToast('海报生成失败', false)
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async () => {
    if (saving || copying) return
    const node = cardRef.current
    if (!node) return
    setCopying(true)
    try {
      await waitForAssets(node)
      const domtoimage = (await import('dom-to-image-more')).default
      const blob: Blob = await (domtoimage as any).toBlob(node, getPosterExportOptions(node))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      showTopToast('海报已复制到剪贴板', true)
    } catch (e) {
      console.error('[SharePoster] 复制失败', e)
      showTopToast('复制失败，请改用保存图片', false)
    } finally {
      setCopying(false)
    }
  }

  const busy = saving || copying

  return (
    <div className="poster-overlay" onMouseDown={onClose}>
      <div className="poster-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="poster-panel">
          <div className="poster-panel__header">
            <span className="poster-panel__title">分享海报</span>
            <button type="button" className="poster-btn poster-btn--icon" onClick={onClose} aria-label="关闭">
              <Xmark width={15} height={15} />
            </button>
          </div>
          <div className="poster-panel__hint">
            共 {ordered.length} 条{ordered.length > 120 ? ' · 条数较多，生成可能稍慢' : ''}
          </div>

          <div className="poster-panel__scroll">
            <div className="poster-panel__section">
              <div className="poster-panel__label">选择样式</div>
              <div className="poster-theme-bar">
                {POSTER_THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    className={`poster-theme-chip${themeId === theme.id ? ' active' : ''}`}
                    onClick={() => selectTheme(theme.id)}
                  >
                    {theme.name}
                  </button>
                ))}
                {customThemes.map((theme) => (
                  <div
                    key={theme.id}
                    className={`poster-theme-chip poster-theme-chip--custom${themeId === theme.id ? ' active' : ''}`}
                    onClick={() => selectTheme(theme.id)}
                    title={theme.name}
                  >
                    <span className="poster-theme-chip__name">{theme.name}</span>
                    <span
                      className="poster-theme-chip__del"
                      role="button"
                      aria-label="删除该样式"
                      onClick={(e) => { e.stopPropagation(); deleteCustomTheme(theme.id) }}
                    >
                      <Xmark width={11} height={11} />
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="poster-panel__section">
              <div className="poster-panel__label">样式工作台</div>
              <div className="poster-style-entry">
                <div className="poster-style-entry__info">
                  <div className="poster-style-entry__name">
                    {selectedCustom ? selectedCustom.name : 'Agent 自定义样式'}
                  </div>
                  <div className="poster-style-entry__meta">
                    {selectedCustom
                      ? '当前自定义样式已选中'
                      : '生成新样式，或编辑已有自定义主题'}
                  </div>
                </div>
                <button
                  type="button"
                  className="poster-btn poster-btn--primary poster-style-entry__btn"
                  onClick={() => void openStyleWorkbench()}
                >
                  <Code width={14} height={14} />
                  打开
                </button>
              </div>
            </div>
          </div>

          <div className="poster-panel__actions">
            <button type="button" className="poster-btn" onClick={handleCopy} disabled={busy}>
              {copying ? <CircleDashed width={14} height={14} className="poster-spin" /> : <Copy width={14} height={14} />}
              复制图片
            </button>
            <button type="button" className="poster-btn poster-btn--primary" onClick={handleSave} disabled={busy}>
              {saving ? <CircleDashed width={14} height={14} className="poster-spin" /> : <ArrowDownToLine width={14} height={14} />}
              保存图片
            </button>
          </div>
        </aside>

        <main
          className={`poster-preview${selectedCustom ? ' poster-preview--pickable' : ''}`}
          onClick={handlePreviewPick}
        >
          <div className={POSTER_THEME_SCOPE} ref={cardRef}>
            {scopedThemeCss && <style>{scopedThemeCss}</style>}
            <div className="poster-card">
              <div className="poster-card__header">
                <div className="poster-card__title">{session.displayName || session.username}</div>
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
        </main>

      </div>
    </div>
  )
}
