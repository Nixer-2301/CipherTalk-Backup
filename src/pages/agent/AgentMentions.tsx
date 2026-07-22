/**
 * 提示词输入框里的"引用"能力：@ 提及联系人/群 + 拖入代码工作区文件引用。
 * 两者共用同一套"正文前缀"编码（@显示名[username] / <code_workspace_files>…</code_workspace_files>），
 * 所以解析、chips 展示、输入框交互都放在一起，避免拆成两个文件后互相 import 形成环。
 */
import { useCallback, useEffect, useMemo, useState, type UIEvent } from 'react'
import { Button as HeroButton, ButtonGroup } from '@heroui/react'
import { At, Code, Persons, Xmark } from '@gravity-ui/icons'
import {
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputHeader,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
import { CODE_WORKSPACE_FILE_REF_MIME, type CodeWorkspaceFileDragReference } from './CodeWorkspacePanel'
import type { UIMessage } from 'ai'

// ====== @ 提及（聚焦某个联系人/群的数据）======
export type MentionTarget = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
  avatarUrl?: string
}

export const MENTION_SESSION_PAGE_SIZE = 1000
export const MENTION_RESULT_BATCH_SIZE = 30

export function classifyTarget(username: string): MentionTarget['kind'] {
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

export function toMentionTarget(username: string, displayName?: string, avatarUrl?: string): MentionTarget {
  return {
    username,
    displayName: displayName || username,
    kind: classifyTarget(username),
    avatarUrl,
  }
}

type MentionQueryState = {
  end: number
  query: string
  start: number
}

function getPromptTextareaElement(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement && active.name === 'message') return active
  return document.querySelector<HTMLTextAreaElement>('.agent-prompt-input textarea[name="message"]')
}

export function focusPromptTextareaAt(position: number) {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    const textarea = getPromptTextareaElement()
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(position, position)
  })
}

function isAsciiWordChar(value: string): boolean {
  return /^[A-Za-z0-9_]$/.test(value)
}

function getMentionQueryAtCursor(value: string): MentionQueryState | null {
  const textarea = getPromptTextareaElement()
  const cursor = textarea && textarea.value === value ? textarea.selectionStart : value.length
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/@([^\s@\[\]\r\n]{0,24})$/)
  if (!match) return null
  const query = match[1] || ''
  const start = cursor - query.length - 1
  const beforeTrigger = value[start - 1] || ''
  if (start > 0 && query.length > 0 && !/\s/.test(beforeTrigger)) return null
  if (start > 0 && query.length === 0 && isAsciiWordChar(beforeTrigger)) return null
  return {
    end: cursor,
    query,
    start,
  }
}

export function insertMentionTriggerAtPromptCursor(value: string): { nextValue: string; nextCursor: number } {
  const textarea = getPromptTextareaElement()
  const start = textarea && textarea.value === value ? textarea.selectionStart : value.length
  const end = textarea && textarea.value === value ? textarea.selectionEnd : value.length
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}@${suffix}${after}`
  return { nextValue, nextCursor: before.length + prefix.length + 1 }
}

function removePromptTextRange(value: string, start: number, end: number): { nextValue: string; nextCursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const nextAfter = before && /\s$/.test(before) ? after.replace(/^\s+/, '') : after
  const spacer = before && nextAfter && !/\s$/.test(before) && !/^\s/.test(nextAfter) ? ' ' : ''
  let nextValue = `${before}${spacer}${nextAfter}`
  let nextCursor = before.length + spacer.length

  if (start === 0) {
    const trimmed = nextValue.replace(/^[ \t]+/, '')
    nextCursor = Math.max(0, nextCursor - (nextValue.length - trimmed.length))
    nextValue = trimmed
  }

  return { nextValue, nextCursor }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function removeMentionTokenFromPromptText(text: string, target: MentionTarget): string {
  const displayName = escapeRegExp(target.displayName)
  const username = escapeRegExp(target.username)
  return text
    .replace(new RegExp(`(^|\\s)@${displayName}\\[${username}\\](?=\\s|$)`, 'g'), '$1')
    .replace(new RegExp(`(^|\\s)@${displayName}(?=\\s|$)`, 'g'), '$1')
    .replace(/^[ \t]+/, '')
}

export function splitMentionPrefix(text: string): { mentions: MentionTarget[]; text: string } {
  const mentions: MentionTarget[] = []
  let rest = text

  while (true) {
    const match = rest.match(/^@([^\[\]\r\n]+)\[([^\]\r\n]+)\][ \t]*/)
    if (!match) break

    const displayName = match[1].trim()
    const username = match[2].trim()
    if (!displayName || !username) break

    mentions.push(toMentionTarget(username, displayName))
    rest = rest.slice(match[0].length)
  }

  if (mentions.length === 0) return { mentions, text }
  return { mentions, text: rest.replace(/^\r?\n/, '') }
}

export function getAvatarLetter(name: string): string {
  const text = name.trim()
  return text ? text.slice(0, 1).toUpperCase() : '?'
}

// ====== 代码工作区文件引用（拖入正文的文件前缀）======
const CODE_WORKSPACE_FILES_BLOCK_START = '<code_workspace_files>'
const CODE_WORKSPACE_FILES_BLOCK_END = '</code_workspace_files>'

export function displayBasename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

function normalizeWorkspaceFileRefPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return ''
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '..')) return ''
  return parts.join('/')
}

function workspaceFileRefFromPath(path: string, name?: string): CodeWorkspaceFileDragReference | null {
  const normalizedPath = normalizeWorkspaceFileRefPath(path)
  if (!normalizedPath) return null
  return {
    name: name?.trim() || displayBasename(normalizedPath),
    path: normalizedPath,
  }
}

export function parseWorkspaceFileDragPayload(value: string): CodeWorkspaceFileDragReference | null {
  if (!value) return null
  try {
    const payload = JSON.parse(value) as Partial<CodeWorkspaceFileDragReference>
    if (typeof payload.path !== 'string') return null
    return workspaceFileRefFromPath(payload.path, typeof payload.name === 'string' ? payload.name : undefined)
  } catch {
    return null
  }
}

export function hasWorkspaceFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(CODE_WORKSPACE_FILE_REF_MIME))
}

export function buildWorkspaceFilePrefix(refs: CodeWorkspaceFileDragReference[]): string {
  if (refs.length === 0) return ''
  return [
    CODE_WORKSPACE_FILES_BLOCK_START,
    ...refs.map((ref) => `- ${ref.path}`),
    CODE_WORKSPACE_FILES_BLOCK_END,
  ].join('\n')
}

export function splitWorkspaceFilePrefix(text: string): { refs: CodeWorkspaceFileDragReference[]; text: string } {
  const trimmedStart = text.replace(/^\s+/, '')
  if (!trimmedStart.startsWith(CODE_WORKSPACE_FILES_BLOCK_START)) return { refs: [], text }
  const endIndex = trimmedStart.indexOf(CODE_WORKSPACE_FILES_BLOCK_END)
  if (endIndex < 0) return { refs: [], text }

  const body = trimmedStart.slice(CODE_WORKSPACE_FILES_BLOCK_START.length, endIndex)
  const refs = body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .map((line) => workspaceFileRefFromPath(line))
    .filter((ref): ref is CodeWorkspaceFileDragReference => Boolean(ref))
  const rest = trimmedStart.slice(endIndex + CODE_WORKSPACE_FILES_BLOCK_END.length).replace(/^\r?\n/, '')
  return { refs, text: rest }
}

/** 从助手/用户消息第一段文本里拆出 @提及 前缀 + 代码工作区文件前缀，剩下的才是正文。 */
export function getUserMessageDisplay(parts: UIMessage['parts']): {
  mentions: MentionTarget[]
  workspaceFiles: CodeWorkspaceFileDragReference[]
  textByPartIndex: Map<number, string>
} {
  const textByPartIndex = new Map<number, string>()
  const firstTextIndex = parts.findIndex((part) => part.type === 'text')
  if (firstTextIndex < 0) return { mentions: [], workspaceFiles: [], textByPartIndex }

  const firstTextPart = parts[firstTextIndex] as Extract<UIMessage['parts'][number], { type: 'text' }>
  const parsed = splitMentionPrefix(firstTextPart.text || '')
  const workspaceParsed = splitWorkspaceFilePrefix(parsed.text)
  if (parsed.mentions.length > 0 || workspaceParsed.refs.length > 0) {
    textByPartIndex.set(firstTextIndex, workspaceParsed.text)
  }
  return {
    mentions: parsed.mentions,
    workspaceFiles: workspaceParsed.refs,
    textByPartIndex,
  }
}

// ====== 组件 ======
export function MentionAvatar({ target, className = 'size-7' }: { target: MentionTarget; className?: string }) {
  const [avatarUrl, setAvatarUrl] = useState(target.avatarUrl || '')
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    setAvatarUrl(target.avatarUrl || '')
    setImageError(false)
  }, [target.avatarUrl, target.username])

  useEffect(() => {
    if (avatarUrl || imageError) return
    let cancelled = false
    void (async () => {
      try {
        const result = await (window as any)?.electronAPI?.chat?.getContactAvatar?.(target.username)
        if (!cancelled && result?.avatarUrl) setAvatarUrl(result.avatarUrl)
      } catch {
        // 头像兜底失败时保持文字占位。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [avatarUrl, imageError, target.username])

  return (
    <span
      className={`${className} inline-flex shrink-0 items-center justify-center overflow-hidden rounded-(--agent-radius,12px) bg-muted text-muted-foreground text-xs`}
    >
      {avatarUrl && !imageError ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={avatarUrl}
          onError={() => setImageError(true)}
        />
      ) : target.kind === 'group' ? (
        <Persons className="size-4" />
      ) : (
        <span>{getAvatarLetter(target.displayName || target.username)}</span>
      )}
    </span>
  )
}

export function MentionTargetChips({
  targets,
  align = 'start',
  onRemove,
}: {
  targets: MentionTarget[]
  align?: 'start' | 'end'
  onRemove?: (target: MentionTarget) => void
}) {
  if (targets.length === 0) return null
  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${align === 'end' ? 'ml-auto justify-end' : ''}`}>
      {targets.map((target) => (
        <span
          className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-1.5 pr-2 font-medium text-primary text-xs"
          key={target.username}
          title={`${target.displayName} · ${target.username}`}
        >
          <MentionAvatar className="size-5" target={target} />
          <span className="min-w-0 truncate">@{target.displayName}</span>
          {target.kind === 'group' && <span className="shrink-0 text-[10px] opacity-75">群</span>}
          {onRemove && (
            <button
              aria-label={`移除 ${target.displayName}`}
              className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-65 transition hover:bg-primary/15 hover:opacity-100"
              onClick={() => onRemove(target)}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <Xmark className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

export function WorkspaceFileReferenceChips({
  refs,
  align = 'start',
  onRemove,
}: {
  refs: CodeWorkspaceFileDragReference[]
  align?: 'start' | 'end'
  onRemove?: (path: string) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${align === 'end' ? 'ml-auto justify-end' : ''}`}>
      {refs.map((ref) => (
        <span
          className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border/70 bg-muted/70 px-2 py-0.5 text-muted-foreground text-xs"
          key={ref.path}
          title={ref.path}
        >
          <Code className="size-3.5 shrink-0 text-accent" />
          <span className="truncate">{ref.name || displayBasename(ref.path)}</span>
          {onRemove && (
            <button
              aria-label={`移除 ${ref.name || displayBasename(ref.path)}`}
              className="ml-0.5 shrink-0 opacity-60 hover:opacity-100"
              onClick={() => onRemove(ref.path)}
              type="button"
            >
              <Xmark className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

export function AgentPromptAssetHeader({
  onRemoveWorkspaceFileReference,
  workspaceFileReferences,
}: {
  onRemoveWorkspaceFileReference: (path: string) => void
  workspaceFileReferences: CodeWorkspaceFileDragReference[]
}) {
  const { attachments } = usePromptInputController()
  if (workspaceFileReferences.length === 0 && attachments.files.length === 0) return null

  return (
    <PromptInputHeader className="flex-col items-stretch gap-1.5 px-3 pt-2 pb-0">
      <WorkspaceFileReferenceChips
        onRemove={onRemoveWorkspaceFileReference}
        refs={workspaceFileReferences}
      />
      <PromptInputAttachments className="p-0">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
    </PromptInputHeader>
  )
}

/**
 * 提及栏：渲染已选 chips + 输入框里键入 @ 时弹出联系人/群选择列表。
 * 必须放在 PromptInputProvider 内（用 usePromptInputController 读写输入框）。
 */
export function MentionField({
  sessions,
  mentions,
  hasMore,
  isLoading,
  onAdd,
  onLoadMore,
  onRemove,
  onSearch,
}: {
  sessions: MentionTarget[]
  mentions: MentionTarget[]
  hasMore: boolean
  isLoading: boolean
  onAdd: (m: MentionTarget) => void
  onLoadMore: () => void
  onRemove: (m: MentionTarget) => void
  onSearch: (query: string) => void
}) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  const [queryState, setQueryState] = useState<MentionQueryState | null>(() => getMentionQueryAtCursor(value))
  const query = queryState?.query ?? null
  const [visibleLimit, setVisibleLimit] = useState(MENTION_RESULT_BATCH_SIZE)
  const picked = useMemo(() => new Set(mentions.map((m) => m.username)), [mentions])
  const pickedKey = useMemo(() => mentions.map((m) => m.username).join('\n'), [mentions])
  const allResults = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return sessions
      .filter((s) => !picked.has(s.username))
      .filter((s) => !q || s.displayName.toLowerCase().includes(q) || s.username.toLowerCase().includes(q))
  }, [sessions, query, picked])
  const results = allResults.slice(0, visibleLimit)

  const refreshQueryState = useCallback(() => {
    setQueryState(getMentionQueryAtCursor(textInput.value))
  }, [textInput.value])

  useEffect(() => {
    refreshQueryState()
  }, [refreshQueryState])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.addEventListener('selectionchange', refreshQueryState)
    return () => {
      document.removeEventListener('selectionchange', refreshQueryState)
    }
  }, [refreshQueryState])

  useEffect(() => {
    setVisibleLimit(MENTION_RESULT_BATCH_SIZE)
  }, [query, pickedKey])

  useEffect(() => {
    if (query !== null && sessions.length === 0 && hasMore && !isLoading) onLoadMore()
  }, [hasMore, isLoading, onLoadMore, query, sessions.length])

  useEffect(() => {
    const q = query?.trim()
    if (!q) return
    const timer = window.setTimeout(() => onSearch(q), 180)
    return () => window.clearTimeout(timer)
  }, [onSearch, query])

  const loadNextVisibleBatch = useCallback(() => {
    if (visibleLimit < allResults.length) {
      setVisibleLimit((limit) => Math.min(limit + MENTION_RESULT_BATCH_SIZE, allResults.length))
      return
    }
    if (hasMore && !isLoading) onLoadMore()
  }, [allResults.length, hasMore, isLoading, onLoadMore, visibleLimit])

  const handleResultsScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) return
      loadNextVisibleBatch()
    },
    [loadNextVisibleBatch]
  )

  const select = (s: MentionTarget) => {
    if (!queryState) return
    onAdd(s)
    const { nextCursor, nextValue } = removePromptTextRange(value, queryState.start, queryState.end)
    textInput.setInput(nextValue)
    setQueryState(null)
    focusPromptTextareaAt(nextCursor)
  }

  const removeSelectedMention = (target: MentionTarget) => {
    onRemove(target)
    const nextValue = removeMentionTokenFromPromptText(textInput.value, target)
    if (nextValue !== textInput.value) textInput.setInput(nextValue)
    focusPromptTextareaAt(nextValue.length)
  }

  return (
    <>
      {mentions.length > 0 && (
        <div className="w-full px-3 pt-2">
          <MentionTargetChips targets={mentions} onRemove={removeSelectedMention} />
        </div>
      )}
      <div className="relative h-0 w-full self-stretch">
        {query !== null && (
          <div
            className="absolute bottom-full left-3 z-50 mb-2 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-(--agent-radius,12px) border border-border bg-popover p-1 shadow-lg"
          >
          <div className="max-h-80 overflow-y-auto pr-1 scrollbar-gutter-stable" onScroll={handleResultsScroll}>
              {results.length > 0 ? (
                <>
                  {results.map((s) => (
                    <button
                      className="flex w-full items-center gap-2 rounded-(--agent-radius,12px) px-2 py-1.5 text-left text-sm hover:bg-accent"
                      key={s.username}
                      onClick={() => select(s)}
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                    >
                      <MentionAvatar target={s} />
                      <span className="min-w-0 flex-1 truncate">{s.displayName}</span>
                      {s.kind === 'group' && <span className="ml-auto shrink-0 text-muted-foreground text-xs">群</span>}
                    </button>
                  ))}
                  {(visibleLimit < allResults.length || hasMore || isLoading) && (
                    <button
                      className="mt-1 w-full rounded-(--agent-radius,12px) px-2 py-2 text-center text-muted-foreground text-xs hover:bg-accent"
                      disabled={isLoading}
                      onClick={loadNextVisibleBatch}
                      type="button"
                    >
                      {isLoading ? '加载中…' : '加载更多会话'}
                    </button>
                  )}
                </>
              ) : (
                <div className="px-2 py-3 text-center text-muted-foreground text-xs">
                  {isLoading
                    ? '联系人加载中…'
                    : hasMore || sessions.length === 0
                      ? (
                        <button className="rounded-(--agent-radius,12px) px-2 py-1 hover:bg-accent" onClick={onLoadMore} type="button">
                          {sessions.length === 0 ? '重新加载联系人' : '继续加载更多会话'}
                        </button>
                      )
                      : '未找到匹配的联系人'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** 工具栏里的 @ 按钮：往输入框塞一个 @ 触发选择列表（提升可发现性）。 */
export function MentionTriggerButton({ showGroupSeparator = false }: { showGroupSeparator?: boolean }) {
  const { textInput } = usePromptInputController()
  return (
    <HeroButton
      aria-label="提及联系人或群"
      className="size-8 p-0"
      isIconOnly
      onPress={() => {
        const v = textInput.value
        const { nextCursor, nextValue } = insertMentionTriggerAtPromptCursor(v)
        textInput.setInput(nextValue)
        focusPromptTextareaAt(nextCursor)
      }}
      size="sm"
      variant="tertiary"
    >
      {showGroupSeparator && <ButtonGroup.Separator />}
      <At className="size-3.5" />
    </HeroButton>
  )
}
