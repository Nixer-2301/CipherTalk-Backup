import { useEffect, useMemo, useState } from 'react'
import {
  AlertDialog,
  Button,
  ButtonGroup,
  Card,
  Chip,
  Description,
  InputGroup,
  Label,
  ListBox,
  NumberField,
  Select,
  Skeleton,
  Switch,
  TextField,
  Typography,
  type Key,
} from '@heroui/react'
import { ArrowDownToLine, ArrowsRotateLeft, Check, FileText, ListCheck, Magnifier, Pencil, Plus, Sparkles, TrashBin, Xmark } from '@gravity-ui/icons'
import type { AgentMemoryItem, AgentMemorySourceType, MemoryBankNoteInfo, MemoryBankNoteKind } from '../../../types/electron'
import { useSettingsStore } from '../settingsStore'

interface MemoryTabProps {
  showMessage: (text: string, success: boolean) => void
}

const MEMORY_SOURCE_OPTIONS: Array<{ value: AgentMemorySourceType; label: string }> = [
  { value: 'profile', label: '画像' },
  { value: 'fact', label: '事实' },
  { value: 'relationship', label: '关系' },
  { value: 'message', label: '消息' },
  { value: 'conversation_block', label: '对话块' },
  { value: 'timeline_summary', label: '时间线' },
  { value: 'media', label: '媒体' },
]

const LOAD_LIMIT = 2000
const BANK_NOTE_LOAD_LIMIT = 200

type MemoryTypeFilter = AgentMemorySourceType | 'all'
type MemoryStatusFilter = 'all' | 'auto' | 'pending'
type EditingId = number | 'new' | null

type MemoryDraft = {
  content: string
  sourceType: AgentMemorySourceType
  importance: number
  confidence: number
  tagsText: string
}

const DEFAULT_DRAFT: MemoryDraft = {
  content: '',
  sourceType: 'fact',
  importance: 0.5,
  confidence: 1,
  tagsText: '',
}

function sourceLabel(value: string) {
  return MEMORY_SOURCE_OPTIONS.find((option) => option.value === value)?.label || value || '未知'
}

function toSourceType(value: unknown): AgentMemorySourceType {
  const text = String(value || '').trim()
  return MEMORY_SOURCE_OPTIONS.some((option) => option.value === text)
    ? text as AgentMemorySourceType
    : 'fact'
}

function clamp01(value: number, fallback = 0) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function formatScore(value: number) {
  return `${Math.round(clamp01(value) * 100)}%`
}

function isPendingMemory(item: AgentMemoryItem): boolean {
  return item.tags?.includes('pending')
}

function isAutoMemory(item: AgentMemoryItem): boolean {
  return item.tags?.includes('auto')
}

function parseTags(tagsText: string): string[] {
  return Array.from(new Set(
    tagsText
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ))
}

function toDraft(item: AgentMemoryItem): MemoryDraft {
  return {
    content: item.content,
    sourceType: toSourceType(item.sourceType),
    importance: clamp01(item.importance, 0.5),
    confidence: clamp01(item.confidence, 1),
    tagsText: item.tags.join(', '),
  }
}

function searchableText(item: AgentMemoryItem) {
  return [
    item.title,
    item.content,
    item.sourceType,
    item.tags?.join(' '),
  ].filter(Boolean).join('\n').toLowerCase()
}

function searchableBankNote(note: MemoryBankNoteInfo) {
  return [
    note.title,
    note.excerpt,
    note.content,
    note.status,
    note.tags?.join(' '),
    note.fileName,
  ].filter(Boolean).join('\n').toLowerCase()
}

function formatDateTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function bankNoteKindLabel(kind: MemoryBankNoteKind) {
  return kind === 'tasks' ? '任务笔记' : '知识笔记'
}

export default function MemoryTab({ showMessage }: MemoryTabProps) {
  const diaryEnabled = useSettingsStore(s => s.config.diaryEnabled)
  const setField = useSettingsStore(s => s.setField)
 const [items, setItems] = useState<AgentMemoryItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [editingId, setEditingId] = useState<EditingId>(null)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [typeFilter, setTypeFilter] = useState<MemoryTypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<MemoryStatusFilter>('all')
  const [query, setQuery] = useState('')
  const [bankNotes, setBankNotes] = useState<MemoryBankNoteInfo[]>([])
  const [bankNoteKind, setBankNoteKind] = useState<MemoryBankNoteKind>('tasks')
  const [bankNoteLoading, setBankNoteLoading] = useState(false)
  const [bankNoteQuery, setBankNoteQuery] = useState('')

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.sourceType !== typeFilter) return false
      if (statusFilter === 'auto' && !isAutoMemory(item)) return false
      if (statusFilter === 'pending' && !isPendingMemory(item)) return false
      if (normalizedQuery && !searchableText(item).includes(normalizedQuery)) return false
      return true
    })
  }, [items, query, statusFilter, typeFilter])

  const filteredBankNotes = useMemo(() => {
    const normalizedQuery = bankNoteQuery.trim().toLowerCase()
    return bankNotes.filter((note) => !normalizedQuery || searchableBankNote(note).includes(normalizedQuery))
  }, [bankNoteQuery, bankNotes])

  const load = async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.memory.list({ limit: LOAD_LIMIT })
      if (res.success) {
        const merged = [...(res.items ?? [])]
          .sort((a, b) => (b.timeEnd || b.timeStart || b.updatedAt) - (a.timeEnd || a.timeStart || a.updatedAt) || b.id - a.id)
        setItems(merged)
        setCount(res.stats?.itemCount ?? merged.length)
      } else {
        showMessage(res.error || '加载记忆失败', false)
      }
    } catch {
      showMessage('加载记忆失败', false)
    } finally {
      setLoading(false)
    }
  }

  const loadBankNotes = async (kind = bankNoteKind) => {
    setBankNoteLoading(true)
    try {
      const res = await window.electronAPI.memory.listBankNotes(kind, BANK_NOTE_LOAD_LIMIT)
      if (res.success) {
        setBankNotes(res.notes || [])
      } else {
        showMessage(res.error || `加载${bankNoteKindLabel(kind)}失败`, false)
      }
    } catch {
      showMessage(`加载${bankNoteKindLabel(kind)}失败`, false)
    } finally {
      setBankNoteLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => { void loadBankNotes(bankNoteKind) }, [bankNoteKind])

  const updateDraft = (patch: Partial<MemoryDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const startCreate = () => {
    setEditingId('new')
    setDraft(DEFAULT_DRAFT)
  }

  const startEdit = (item: AgentMemoryItem) => {
    setEditingId(item.id)
    setDraft(toDraft(item))
  }

  const handleDelete = async (id: number) => {
    const res = await window.electronAPI.memory.delete(id)
    if (res.success) {
      setItems((prev) => prev.filter((memory) => memory.id !== id))
      setCount((current) => Math.max(0, current - 1))
      if (editingId === id) cancelEdit()
    } else {
      showMessage(res.error || '删除失败', false)
    }
  }

  const handleSave = async () => {
    if (!draft || !editingId) return
    const content = draft.content.trim()
    if (!content) {
      showMessage('记忆内容不能为空', false)
      return
    }

    const payload = {
      sourceType: draft.sourceType,
      content,
      importance: clamp01(draft.importance, 0.5),
      confidence: clamp01(draft.confidence, 1),
      tags: parseTags(draft.tagsText),
    }

    try {
      const res = editingId === 'new'
        ? await window.electronAPI.memory.create({ ...payload, title: content.slice(0, 40) })
        : await window.electronAPI.memory.update({ id: editingId, ...payload })

      if (res.success && res.item) {
        if (editingId === 'new') {
          setItems((prev) => [res.item!, ...prev])
          setCount((current) => current + 1)
        } else {
          setItems((prev) => prev.map((item) => (item.id === editingId ? res.item! : item)))
        }
        cancelEdit()
        showMessage(editingId === 'new' ? '记忆已创建' : '记忆已更新', true)
      } else {
        showMessage(res.error || '保存失败', false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showMessage(message.includes('No handler registered')
        ? '记忆保存 IPC 尚未加载，请重启应用后再试'
        : `保存失败：${message}`, false)
    }
  }

  const handleConfirmMemory = async (item: AgentMemoryItem) => {
    const res = await window.electronAPI.memory.update({
      id: item.id,
      sourceType: toSourceType(item.sourceType),
      content: item.content,
      importance: Math.max(item.importance, 0.75),
      confidence: Math.max(item.confidence, 0.85),
      tags: (item.tags || []).filter((tag) => tag !== 'pending'),
    })
    if (res.success && res.item) {
      setItems((prev) => prev.map((memory) => (memory.id === item.id ? res.item! : memory)))
      showMessage('已确认自动记忆', true)
    } else {
      showMessage(res.error || '确认失败', false)
    }
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const res = await window.electronAPI.memory.consolidate()
      if (res.success) {
        showMessage(`整理完成，清理 ${res.result?.removed ?? 0} 条`, true)
        void load()
      } else {
        showMessage(res.error || '整理失败', false)
      }
    } finally {
      setConsolidating(false)
    }
  }

  const handleExportMarkdown = async () => {
    setExporting(true)
    try {
      const picked = await window.electronAPI.dialog.openFile({ title: '选择记忆导出目录', properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return
      const res = await window.electronAPI.memory.exportMarkdown(picked.filePaths[0])
      if (res.success) {
        showMessage(`已导出 ${res.result?.itemCount ?? 0} 条记忆`, true)
      } else {
        showMessage(res.error || '导出失败', false)
      }
    } catch {
      showMessage('导出失败', false)
    } finally {
      setExporting(false)
    }
  }

  const handleDeleteBankNote = async (note: MemoryBankNoteInfo) => {
    const res = await window.electronAPI.memory.deleteBankNote(note.kind, note.fileName)
    if (res.success) {
      setBankNotes((prev) => prev.filter((item) => item.fileName !== note.fileName || item.kind !== note.kind))
      showMessage('笔记已删除', true)
    } else {
      showMessage(res.error || '删除笔记失败', false)
    }
  }

  const renderTypeSelect = (value: MemoryTypeFilter, onChange: (value: MemoryTypeFilter) => void) => (
    <Select
      fullWidth
      selectedKey={value}
      variant="secondary"
      onSelectionChange={(key: Key | null) => {
        if (key != null) onChange(String(key) as MemoryTypeFilter)
      }}
    >
      <Label>类型</Label>
      <Select.Trigger>
        <Select.Value>{() => value === 'all' ? '全部' : sourceLabel(value)}</Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="all" textValue="全部">
            全部
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {MEMORY_SOURCE_OPTIONS.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )

  const renderEditor = () => {
    if (!draft) return null
    return (
      <div className="space-y-4 rounded-lg border border-border bg-default p-3">
        <TextField fullWidth onChange={(value) => updateDraft({ content: value })} value={draft.content}>
          <Label>内容</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.TextArea placeholder="写清这条长期记忆" rows={4} />
          </InputGroup>
        </TextField>

        <div className="grid gap-3 md:grid-cols-3">
          <Select
            fullWidth
            selectedKey={draft.sourceType}
            variant="secondary"
            onSelectionChange={(key: Key | null) => {
              if (key != null) updateDraft({ sourceType: toSourceType(key) })
            }}
          >
            <Label>类型</Label>
            <Select.Trigger>
              <Select.Value>{() => sourceLabel(draft.sourceType)}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {MEMORY_SOURCE_OPTIONS.map((option) => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <NumberField
            aria-label="重要度"
            maxValue={1}
            minValue={0}
            step={0.05}
            value={draft.importance}
            variant="secondary"
            onChange={(value) => updateDraft({ importance: clamp01(value ?? 0, 0.5) })}
          >
            <Label>重要度</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
          </NumberField>

          <NumberField
            aria-label="置信度"
            maxValue={1}
            minValue={0}
            step={0.05}
            value={draft.confidence}
            variant="secondary"
            onChange={(value) => updateDraft({ confidence: clamp01(value ?? 0, 1) })}
          >
            <Label>置信度</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
          </NumberField>
        </div>

        <TextField fullWidth onChange={(value) => updateDraft({ tagsText: value })} value={draft.tagsText}>
          <Label>标签</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="用逗号分隔" />
          </InputGroup>
        </TextField>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onPress={() => void handleSave()}>
            <Check width={16} height={16} />
            保存
          </Button>
          <Button type="button" variant="tertiary" onPress={cancelEdit}>
            <Xmark width={16} height={16} />
            取消
          </Button>
        </div>
      </div>
    )
  }

  const renderMemoryItem = (item: AgentMemoryItem) => {
    if (editingId === item.id) return <div key={item.id}>{renderEditor()}</div>

    return (
      <div className="rounded-lg border border-border bg-default p-3" key={item.id}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft">{sourceLabel(item.sourceType)}</Chip>
          {isAutoMemory(item) && <Chip size="sm" variant="soft">自动</Chip>}
          {isPendingMemory(item) && <Chip color="warning" size="sm" variant="soft">待确认</Chip>}
          <span className="text-xs text-muted">重要度 {formatScore(item.importance)}</span>
          <span className="text-xs text-muted">置信度 {formatScore(item.confidence)}</span>
        </div>

        <Typography.Paragraph className="mt-2 whitespace-pre-wrap wrap-break-word text-sm leading-6">
          {item.content}
        </Typography.Paragraph>

        {item.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <Chip key={tag} size="sm" variant="soft">{tag}</Chip>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {isPendingMemory(item) && (
            <Button size="sm" type="button" variant="secondary" onPress={() => void handleConfirmMemory(item)}>
              <Check width={14} height={14} />
              确认
            </Button>
          )}
          <Button size="sm" type="button" variant="tertiary" onPress={() => startEdit(item)}>
            <Pencil width={14} height={14} />
            编辑
          </Button>
          <AlertDialog>
            <Button size="sm" type="button" variant="danger">
              <TrashBin width={14} height={14} />
              删除
            </Button>
            <AlertDialog.Backdrop>
              <AlertDialog.Container>
                <AlertDialog.Dialog>
                  <AlertDialog.CloseTrigger />
                  <AlertDialog.Header>
                    <AlertDialog.Icon status="danger" />
                    <AlertDialog.Heading>删除这条记忆？</AlertDialog.Heading>
                  </AlertDialog.Header>
                  <AlertDialog.Body>
                    <Typography.Paragraph size="sm">
                      删除后，AI 不会再把这条内容作为长期记忆参考。此操作不可撤销。
                    </Typography.Paragraph>
                    <Typography.Paragraph size="sm" color="muted">
                      {item.content}
                    </Typography.Paragraph>
                  </AlertDialog.Body>
                  <AlertDialog.Footer>
                    <Button slot="close" variant="tertiary">取消</Button>
                    <Button slot="close" variant="danger" onPress={() => void handleDelete(item.id)}>
                      删除
                    </Button>
                  </AlertDialog.Footer>
                </AlertDialog.Dialog>
              </AlertDialog.Container>
            </AlertDialog.Backdrop>
          </AlertDialog>
        </div>
      </div>
    )
  }

  const renderBankNoteItem = (note: MemoryBankNoteInfo) => (
    <div className="rounded-lg border border-border bg-default p-3" key={`${note.kind}:${note.fileName}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft">{bankNoteKindLabel(note.kind)}</Chip>
        {note.status && <Chip size="sm" variant="soft">{note.status}</Chip>}
        <span className="text-xs text-muted">{formatDateTime(note.updatedAt)}</span>
      </div>

      <Typography.Paragraph className="mt-2 text-sm font-medium leading-6">
        {note.title}
      </Typography.Paragraph>
      <Typography.Paragraph className="mt-1 whitespace-pre-wrap wrap-break-word text-sm leading-6" color="muted">
        {note.excerpt || '暂无内容。'}
      </Typography.Paragraph>

      {note.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.tags.map((tag) => (
            <Chip key={tag} size="sm" variant="soft">{tag}</Chip>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{note.fileName}</span>
        <AlertDialog>
          <Button size="sm" type="button" variant="danger">
            <TrashBin width={14} height={14} />
            删除
          </Button>
          <AlertDialog.Backdrop>
            <AlertDialog.Container>
              <AlertDialog.Dialog>
                <AlertDialog.CloseTrigger />
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>删除这篇笔记？</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <Typography.Paragraph size="sm">
                    删除后，Agent 不会再从这篇 Markdown 笔记里读取上下文。此操作不可撤销。
                  </Typography.Paragraph>
                  <Typography.Paragraph size="sm" color="muted">
                    {note.title}
                  </Typography.Paragraph>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary">取消</Button>
                  <Button slot="close" variant="danger" onPress={() => void handleDeleteBankNote(note)}>
                    删除
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
    <Card>
      <Card.Header className="flex-col items-start gap-1">
        <Card.Title>日记功能</Card.Title>
        <Card.Description>关闭后将隐藏侧边栏日记入口，并停止每日自动生成日记的夜间记忆整理。</Card.Description>
      </Card.Header>
      <Card.Content>
        <Switch
          className="max-w-2xl"
          isSelected={diaryEnabled}
          onChange={(enabled) => setField('diaryEnabled', enabled)}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>
            <Label>启用日记</Label>
            <Description>默认开启。关闭后不再自动生成日记，已有日记仍可查看。</Description>
          </Switch.Content>
        </Switch>
      </Card.Content>
    </Card>
    <Card>
      <Card.Header className="flex-col items-start gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Card.Title>长期记忆</Card.Title>
          <Card.Description>只显示可修改的记忆字段。</Card.Description>
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip color="accent" size="sm" variant="soft">{count} 条</Chip>
            <Chip size="sm" variant="soft">显示 {filteredItems.length}</Chip>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onPress={startCreate}>
            <Plus width={16} height={16} />
            新增
          </Button>
          <Button isDisabled={loading} type="button" variant="secondary" onPress={() => void load()}>
            <ArrowsRotateLeft className={loading ? 'animate-spin' : ''} width={16} height={16} />
            刷新
          </Button>
          <Button isDisabled={consolidating} type="button" variant="secondary" onPress={() => void handleConsolidate()}>
            <Sparkles width={16} height={16} />
            {consolidating ? '整理中...' : '整理'}
          </Button>
          <Button isDisabled={exporting} type="button" variant="secondary" onPress={() => void handleExportMarkdown()}>
            <ArrowDownToLine width={16} height={16} />
            导出
          </Button>
        </div>
      </Card.Header>

      <Card.Content className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
          <TextField fullWidth onChange={setQuery} value={query}>
            <Label>搜索</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Prefix>
                <Magnifier width={15} height={15} />
              </InputGroup.Prefix>
              <InputGroup.Input placeholder="搜索内容或标签" />
            </InputGroup>
          </TextField>
          {renderTypeSelect(typeFilter, setTypeFilter)}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup variant="tertiary">
            <Button onPress={() => setStatusFilter('all')} variant={statusFilter === 'all' ? 'secondary' : 'tertiary'}>全部</Button>
            <Button onPress={() => setStatusFilter('auto')} variant={statusFilter === 'auto' ? 'secondary' : 'tertiary'}>自动</Button>
            <Button onPress={() => setStatusFilter('pending')} variant={statusFilter === 'pending' ? 'secondary' : 'tertiary'}>待确认</Button>
          </ButtonGroup>
        </div>

        {editingId === 'new' && renderEditor()}

        {loading && items.length === 0 ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
          </div>
        ) : filteredItems.length === 0 ? (
          <Typography.Paragraph color="muted" size="sm">
            没有匹配的记忆。
          </Typography.Paragraph>
        ) : (
          <div className="space-y-3">
            {filteredItems.map(renderMemoryItem)}
          </div>
        )}
      </Card.Content>
    </Card>
    <Card>
      <Card.Header className="flex-col items-start gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Card.Title>任务与知识笔记</Card.Title>
          <Card.Description>自动写入 memory-bank/tasks 与 memory-bank/notes 的 Markdown。</Card.Description>
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip color="accent" size="sm" variant="soft">{bankNotes.length} 篇</Chip>
            <Chip size="sm" variant="soft">显示 {filteredBankNotes.length}</Chip>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonGroup variant="tertiary">
            <Button onPress={() => setBankNoteKind('tasks')} variant={bankNoteKind === 'tasks' ? 'secondary' : 'tertiary'}>
              <ListCheck width={16} height={16} />
              任务
            </Button>
            <Button onPress={() => setBankNoteKind('notes')} variant={bankNoteKind === 'notes' ? 'secondary' : 'tertiary'}>
              <ButtonGroup.Separator />
              <FileText width={16} height={16} />
              笔记
            </Button>
          </ButtonGroup>
          <Button isDisabled={bankNoteLoading} type="button" variant="secondary" onPress={() => void loadBankNotes()}>
            <ArrowsRotateLeft className={bankNoteLoading ? 'animate-spin' : ''} width={16} height={16} />
            刷新
          </Button>
        </div>
      </Card.Header>

      <Card.Content className="space-y-4">
        <TextField fullWidth onChange={setBankNoteQuery} value={bankNoteQuery}>
          <Label>搜索</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Prefix>
              <Magnifier width={15} height={15} />
            </InputGroup.Prefix>
            <InputGroup.Input placeholder="搜索标题、内容、标签或文件名" />
          </InputGroup>
        </TextField>

        {bankNoteLoading && bankNotes.length === 0 ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
          </div>
        ) : filteredBankNotes.length === 0 ? (
          <Typography.Paragraph color="muted" size="sm">
            没有匹配的{bankNoteKindLabel(bankNoteKind)}。
          </Typography.Paragraph>
        ) : (
          <div className="space-y-3">
            {filteredBankNotes.map(renderBankNoteItem)}
          </div>
        )}
      </Card.Content>
    </Card>
    </div>
  )
}
