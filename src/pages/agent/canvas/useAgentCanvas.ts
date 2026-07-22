/**
 * Canvas 面板核心状态 —— revision 乐观锁、600ms 防抖自动保存、冲突处理、跨窗口同步
 * 全部集中在这里（编辑器组件只负责文本，见 Docs Canvas 文档 §11）。
 *
 * 关键约束：
 * - draft !== savedContent 即本地 dirty，不能只看 saving。
 * - 保存失败/冲突时保留 draft，绝不回滚用户输入。
 * - 收到 REVISION_CONFLICT 后停止自动保存，等用户在冲突条上做选择。
 * - 同窗口保存带 originClientId，收到同源 agentCanvas:updated 只校准不重载。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentCanvasConflictInfo,
  AgentCanvasKind,
  AgentCanvasRecord,
  AgentCanvasRunContextInput,
  AgentCanvasSaveStatus,
  AgentCanvasUpdatedEvent,
} from './agentCanvasTypes'
import { canvasApi } from './agentCanvasStore'

const AUTO_SAVE_DEBOUNCE_MS = 600

export interface UseAgentCanvasOptions {
  conversationId: number | null
  clientId: string
  onError?: (message: string) => void
}

export interface UseAgentCanvasResult {
  open: boolean
  loading: boolean
  saving: boolean
  record: AgentCanvasRecord | null
  draft: string
  isDirty: boolean
  saveStatus: AgentCanvasSaveStatus
  conflict: AgentCanvasConflictInfo | null
  error: string | null
  openCanvas: (canvasId: string) => Promise<void>
  closePanel: () => void
  createCanvas: (kind: AgentCanvasKind) => Promise<void>
  setDraft: (text: string) => void
  flushSave: () => Promise<boolean>
  rename: (title: string) => Promise<void>
  restoreRevision: (revision: number) => Promise<void>
  archiveCanvas: () => Promise<void>
  conflictUseLatest: () => void
  conflictKeepMine: () => Promise<void>
  /** transport 的 getCanvasContext：ref 读取，避免闭包过期 */
  getRunContext: () => AgentCanvasRunContextInput | null
}

export function useAgentCanvas({ conversationId, clientId, onError }: UseAgentCanvasOptions): UseAgentCanvasResult {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [record, setRecord] = useState<AgentCanvasRecord | null>(null)
  const [draft, setDraftState] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [conflict, setConflict] = useState<AgentCanvasConflictInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  const recordRef = useRef<AgentCanvasRecord | null>(null)
  recordRef.current = record
  const draftRef = useRef('')
  draftRef.current = draft
  const savedContentRef = useRef('')
  savedContentRef.current = savedContent
  const conflictRef = useRef<AgentCanvasConflictInfo | null>(null)
  conflictRef.current = conflict
  const savingRef = useRef(false)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  // onError 走 ref：调用方通常传内联箭头函数，直接进依赖会让保存/订阅链每次渲染重建
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const reportError = useCallback((message: string) => {
    setError(message)
    onErrorRef.current?.(message)
  }, [])

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const applyRecord = useCallback((next: AgentCanvasRecord, adoptContent: boolean) => {
    recordRef.current = next
    savedContentRef.current = next.content
    setRecord(next)
    setSavedContent(next.content)
    if (adoptContent) {
      draftRef.current = next.content
      setDraftState(next.content)
    }
    setSaveFailed(false)
    setError(null)
  }, [])

  /** 单飞保存队列：调用方会等待当前保存，并自动追存请求期间产生的新输入。 */
  const save = useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current
    const current = recordRef.current
    if (!current) return Promise.resolve(true)
    if (conflictRef.current) return Promise.resolve(false)
    if (draftRef.current === savedContentRef.current) return Promise.resolve(true)

    const pending = Promise.resolve().then(async (): Promise<boolean> => {
      savingRef.current = true
      setSaving(true)
      try {
        while (!conflictRef.current && draftRef.current !== savedContentRef.current) {
          const active = recordRef.current
          if (!active) return false
          const content = draftRef.current
          const result = await canvasApi().update({
            canvasId: active.id,
            baseRevision: active.revision,
            content,
            originClientId: clientId,
          })
          if (result.success && result.canvas) {
            recordRef.current = result.canvas
            savedContentRef.current = content
            setRecord(result.canvas)
            setSavedContent(content)
            setSaveFailed(false)
            setError(null)
            continue
          }
          if (result.conflict) {
            conflictRef.current = result.conflict
            setConflict(result.conflict)
            return false
          }
          setSaveFailed(true)
          reportError(`画布保存失败：${result.error || '未知错误'}`)
          return false
        }
        return !conflictRef.current && draftRef.current === savedContentRef.current
      } catch (err) {
        setSaveFailed(true)
        reportError(`画布保存失败：${err instanceof Error ? err.message : String(err)}`)
        return false
      } finally {
        savingRef.current = false
        savePromiseRef.current = null
        setSaving(false)
      }
    })
    savePromiseRef.current = pending
    return pending
  }, [clientId, reportError])

  const flushSave = useCallback(async (): Promise<boolean> => {
    clearDebounce()
    return save()
  }, [clearDebounce, save])

  const setDraft = useCallback((text: string) => {
    setDraftState(text)
    draftRef.current = text
    if (conflictRef.current) return // 冲突期间停止自动保存，draft 保留
    clearDebounce()
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      void save()
    }, AUTO_SAVE_DEBOUNCE_MS)
  }, [clearDebounce, save])

  const openCanvas = useCallback(async (canvasId: string) => {
    if (!await flushSave()) return
    setLoading(true)
    setError(null)
    setConflict(null)
    try {
      const result = await canvasApi().get(canvasId)
      if (!result.success || !result.canvas) {
        reportError(`画布加载失败：${result.error || '未知错误'}`)
        return
      }
      if (conversationIdRef.current && result.canvas.conversationId !== conversationIdRef.current) {
        reportError('该画布不属于当前会话')
        return
      }
      applyRecord(result.canvas, true)
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }, [applyRecord, flushSave, reportError])

  const closePanel = useCallback(() => {
    void flushSave()
    setOpen(false)
  }, [flushSave])

  const createCanvas = useCallback(async (kind: AgentCanvasKind) => {
    const targetConversationId = conversationIdRef.current
    if (!targetConversationId) {
      reportError('请先发送一条消息创建会话，再新建画布')
      return
    }
    if (!await flushSave()) return
    const result = await canvasApi().create({
      conversationId: targetConversationId,
      kind,
      title: kind === 'code' ? '未命名代码' : '未命名文档',
      content: '',
      originClientId: clientId,
    })
    if (!result.success || !result.canvas) {
      reportError(`创建画布失败：${result.error || '未知错误'}`)
      return
    }
    setConflict(null)
    applyRecord(result.canvas, true)
    setOpen(true)
  }, [applyRecord, clientId, flushSave, reportError])

  const rename = useCallback(async (title: string) => {
    const current = recordRef.current
    if (!current || !title.trim()) return
    if (!await flushSave()) return
    const latest = recordRef.current
    if (!latest) return
    const result = await canvasApi().rename({
      canvasId: latest.id,
      baseRevision: latest.revision,
      title: title.trim(),
      originClientId: clientId,
    })
    if (result.success && result.canvas) {
      applyRecord(result.canvas, false)
    } else if (result.conflict) {
      conflictRef.current = result.conflict
      setConflict(result.conflict)
    } else {
      reportError(`重命名失败：${result.error || '未知错误'}`)
    }
  }, [applyRecord, clientId, flushSave, reportError])

  const restoreRevision = useCallback(async (revision: number) => {
    const current = recordRef.current
    if (!current) return
    if (!await flushSave()) return
    const latest = recordRef.current
    if (!latest) return
    const result = await canvasApi().restore({
      canvasId: latest.id,
      baseRevision: latest.revision,
      revision,
      originClientId: clientId,
    })
    if (result.success && result.canvas) {
      conflictRef.current = null
      setConflict(null)
      applyRecord(result.canvas, true)
    } else if (result.conflict) {
      conflictRef.current = result.conflict
      setConflict(result.conflict)
    } else {
      reportError(`恢复历史版本失败：${result.error || '未知错误'}`)
    }
  }, [applyRecord, clientId, flushSave, reportError])

  const archiveCanvas = useCallback(async () => {
    const current = recordRef.current
    if (!current) return
    if (!await flushSave()) return
    const latest = recordRef.current
    if (!latest) return
    const result = await canvasApi().archive({
      canvasId: latest.id,
      baseRevision: latest.revision,
      originClientId: clientId,
    })
    if (result.success) {
      setOpen(false)
      recordRef.current = null
      draftRef.current = ''
      savedContentRef.current = ''
      conflictRef.current = null
      setRecord(null)
      setDraftState('')
      setSavedContent('')
      setConflict(null)
    } else if (result.conflict) {
      conflictRef.current = result.conflict
      setConflict(result.conflict)
    } else {
      reportError(`归档失败：${result.error || '未知错误'}`)
    }
  }, [clientId, flushSave, reportError])

  /** 冲突：放弃本地 draft，采用服务端最新版本 */
  const conflictUseLatest = useCallback(() => {
    const latest = conflictRef.current?.current
    conflictRef.current = null
    setConflict(null)
    if (latest) {
      applyRecord(latest, true)
    } else if (recordRef.current) {
      void openCanvas(recordRef.current.id)
    }
  }, [applyRecord, openCanvas])

  /** 冲突：全文覆盖为本地 draft（调用方需先经 AlertDialog 二次确认） */
  const conflictKeepMine = useCallback(async () => {
    const current = recordRef.current
    if (!current) return
    // 重新读取最新 revision 再覆盖，避免又一轮冲突
    const latest = await canvasApi().get(current.id)
    if (!latest.success || !latest.canvas) {
      reportError(`获取最新版本失败：${latest.error || '未知错误'}`)
      return
    }
    const content = draftRef.current
    const result = await canvasApi().update({
      canvasId: current.id,
      baseRevision: latest.canvas.revision,
      content,
      originClientId: clientId,
    })
    if (result.success && result.canvas) {
      conflictRef.current = null
      recordRef.current = result.canvas
      savedContentRef.current = content
      setConflict(null)
      setRecord(result.canvas)
      setSavedContent(content)
      setSaveFailed(false)
      if (draftRef.current !== content) void save()
    } else if (result.conflict) {
      conflictRef.current = result.conflict
      setConflict(result.conflict)
    } else {
      reportError(`覆盖保存失败：${result.error || '未知错误'}`)
    }
  }, [clientId, reportError, save])

  // 跨窗口/Agent 写入同步（见文档 §12）
  useEffect(() => {
    const off = window.electronAPI?.agentCanvas?.onUpdated?.((event: AgentCanvasUpdatedEvent) => {
      if (!event || event.conversationId !== conversationIdRef.current) return
      const active = recordRef.current
      const isSelfOrigin = Boolean(event.originClientId && event.originClientId === clientId)
      // Agent 新建（无 originClientId）→ 自动打开；历史引用仍只在点击时打开
      if (event.action === 'created' && !event.originClientId) {
        void openCanvas(event.canvasId)
        return
      }
      if (!active || active.id !== event.canvasId || isSelfOrigin) return
      if (event.action === 'archived') {
        void canvasApi().get(event.canvasId).then((result) => {
          if (!result.success || !result.canvas || recordRef.current?.id !== event.canvasId) return
          const hasLocalDraft = draftRef.current !== savedContentRef.current
          recordRef.current = result.canvas
          savedContentRef.current = result.canvas.content
          setRecord(result.canvas)
          setSavedContent(result.canvas.content)
          if (hasLocalDraft) {
            setSaveFailed(true)
            reportError('画布已在其他窗口归档，本地未保存内容仍保留，可复制或下载后再关闭。')
          } else {
            draftRef.current = result.canvas.content
            setDraftState(result.canvas.content)
          }
        })
        return
      }
      if (event.revision === active.revision) return
      const dirty = draftRef.current !== savedContentRef.current
      if (!dirty && !savingRef.current && !conflictRef.current) {
        // 本地无未保存修改 → 直接刷新
        void canvasApi().get(event.canvasId).then((result) => {
          if (result.success && result.canvas && recordRef.current?.id === event.canvasId) {
            applyRecord(result.canvas, true)
          }
        })
      } else if (!conflictRef.current) {
        // 本地 dirty → 进入冲突态，保留 draft
        void canvasApi().get(event.canvasId).then((result) => {
          const activeNow = recordRef.current
          if (result.success && result.canvas && activeNow && activeNow.id === event.canvasId) {
            const nextConflict: AgentCanvasConflictInfo = {
              code: 'REVISION_CONFLICT',
              canvasId: event.canvasId,
              expectedRevision: activeNow.revision,
              actualRevision: result.canvas.revision,
              current: result.canvas,
            }
            conflictRef.current = nextConflict
            setConflict(nextConflict)
          }
        })
      }
    })
    return () => { off?.() }
  }, [applyRecord, clientId, openCanvas, reportError])

  // 切换会话：Canvas 随会话走，关面板并清空状态（未保存内容先 flush）
  useEffect(() => {
    return () => { clearDebounce() }
  }, [clearDebounce])
  const prevConversationRef = useRef(conversationId)
  useEffect(() => {
    if (prevConversationRef.current === conversationId) return
    prevConversationRef.current = conversationId
    void flushSave().finally(() => {
      setOpen(false)
      recordRef.current = null
      draftRef.current = ''
      savedContentRef.current = ''
      conflictRef.current = null
      setRecord(null)
      setDraftState('')
      setSavedContent('')
      setConflict(null)
      setError(null)
      setSaveFailed(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 conversationId 变化时清理
  }, [conversationId])

  const isDirty = draft !== savedContent
  const saveStatus: AgentCanvasSaveStatus = conflict
    ? 'conflict'
    : saving
      ? 'saving'
      : saveFailed
        ? 'save-failed'
        : isDirty
          ? 'dirty'
          : 'saved'

  const getRunContext = useCallback((): AgentCanvasRunContextInput | null => {
    const current = recordRef.current
    return current ? { activeCanvasId: current.id, activeRevision: current.revision } : null
  }, [])

  return useMemo(() => ({
    open,
    loading,
    saving,
    record,
    draft,
    isDirty,
    saveStatus,
    conflict,
    error,
    openCanvas,
    closePanel,
    createCanvas,
    setDraft,
    flushSave,
    rename,
    restoreRevision,
    archiveCanvas,
    conflictUseLatest,
    conflictKeepMine,
    getRunContext,
  }), [
    open, loading, saving, record, draft, isDirty, saveStatus, conflict, error,
    openCanvas, closePanel, createCanvas, setDraft, flushSave, rename,
    restoreRevision, archiveCanvas, conflictUseLatest, conflictKeepMine, getRunContext,
  ])
}
