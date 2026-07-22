import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, ListBox, Modal, Popover, ScrollShadow, Spinner, TextField, TimeField, Toolbar } from '@heroui/react'
import { Time } from '@internationalized/date'
import { ArrowDownToLine, ArrowRotateLeft, ArrowsRotateLeft, BookOpen, Check, Clock, Copy, FloppyDisk, Gear, PencilToLine, Text, TrashBin } from '@gravity-ui/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { MemoryDiaryEntryInfo } from '../types/electron'
import {
  DEFAULT_DIARY_SUMMARY_HOUR,
  MAX_DIARY_CUSTOM_PROMPT_LENGTH,
  getDiaryCustomPrompt,
  getDiarySummaryHour,
  normalizeDiaryCustomPrompt,
  normalizeDiarySummaryHour,
  setDiaryCustomPrompt,
  setDiarySummaryHour,
} from '../services/config'

type DiaryFontMode = 'hand' | 'song' | 'native'
type DiaryExportMemoryMode = 'with-memory' | 'without-memory'

type DiarySettingsDraft = {
  summaryHour: number
  customPrompt: string
}

function toDiarySummaryTime(hour: number): Time {
  return new Time(normalizeDiarySummaryHour(hour), 0)
}

function formatDiaryDate(date: string): string {
  const [year, month, day] = date.split('-')
  return year && month && day ? `${year}/${month}/${day}` : date
}

function stripMemoryIndex(markdown: string): string {
  return markdown.replace(/\n## 记忆线索[\s\S]*$/u, '').trim()
}

function cardPreview(diary: MemoryDiaryEntryInfo): string {
  return diary.excerpt || stripMemoryIndex(diary.content || '').replace(/^# .+$/gm, '').replace(/\s+/g, ' ').trim() || '这一天还没有留下太多文字。'
}

function splitCardPreview(text: string): { head: string; tail: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const headLength = Math.min(96, Math.max(52, Math.floor(normalized.length * 0.58)))
  const head = normalized.slice(0, headLength).trimEnd()
  const tail = normalized.slice(headLength).trimStart()

  return {
    head,
    tail,
    truncated: tail.length > 0,
  }
}

const DIARY_SUMMARIZING_LINES = [
  '把今天摊开，挑几段舍不得散的',
  '有些句子已经在时间里褪色了，趁还看得见，记下来',
  '今天的你说了很多。我在听第二遍',
  '正在替以后的你，保管今天的自己',
  '让我把今天叠好，放进抽屉',
  '有一段话我想多读几遍——今天的',
  '别催，日记不是赶出来的',
]

const EXISTING_TODAY_DIARY_NOTICE = '今天的日记已经躺在那儿了。再写一篇，前一篇就会被盖掉。 我不想让它还没被好好看过，就消失了。'

const DIARY_FONT_OPTIONS: Array<{ id: DiaryFontMode; label: string }> = [
  { id: 'hand', label: '手写' },
  { id: 'song', label: '宋体' },
  { id: 'native', label: '原生' },
]

const DIARY_EXPORT_MEMORY_OPTIONS: Array<{ id: DiaryExportMemoryMode; label: string }> = [
  { id: 'with-memory', label: '包含记忆线索' },
  { id: 'without-memory', label: '不含记忆线索' },
]

const DIARY_EXPORT_WATERMARK_SRC = '/About.png'
const DIARY_EXPORT_WATERMARK_HEIGHT = 68

let diaryExportWatermarkDataUrl: string | null = null

function cssPx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isMemoryClueHeading(element: HTMLElement): boolean {
  return /^H[1-6]$/u.test(element.tagName) && element.textContent?.replace(/\s+/g, '') === '记忆线索'
}

function getDiaryPageExportChildren(page: HTMLElement, includeMemoryClues: boolean): HTMLElement[] {
  const children = Array.from(page.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
  if (includeMemoryClues) return children

  const memoryIndex = children.findIndex(isMemoryClueHeading)
  return memoryIndex >= 0 ? children.slice(0, memoryIndex) : children
}

function removeMemoryClueSection(page: HTMLElement): void {
  const children = Array.from(page.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
  const memoryIndex = children.findIndex(isMemoryClueHeading)
  if (memoryIndex < 0) return
  children.slice(memoryIndex).forEach((child) => child.remove())
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result || '')))
    reader.addEventListener('error', () => reject(reader.error || new Error('读取水印图片失败')))
    reader.readAsDataURL(blob)
  })
}

async function loadDiaryExportWatermarkSrc(): Promise<string> {
  if (diaryExportWatermarkDataUrl) return diaryExportWatermarkDataUrl
  const res = await fetch(DIARY_EXPORT_WATERMARK_SRC)
  if (!res.ok) throw new Error('读取水印图片失败')
  diaryExportWatermarkDataUrl = await readBlobAsDataUrl(await res.blob())
  return diaryExportWatermarkDataUrl
}

function appendDiaryExportWatermark(container: HTMLElement, src: string): Promise<void> {
  const watermark = container.ownerDocument.createElement('div')
  const image = container.ownerDocument.createElement('img')

  watermark.className = 'diary-export-watermark'
  watermark.style.alignItems = 'center'
  watermark.style.display = 'flex'
  watermark.style.height = '52px'
  watermark.style.justifyContent = 'center'
  watermark.style.margin = '16px 0 0'
  watermark.style.pointerEvents = 'none'
  watermark.style.position = 'relative'
  watermark.style.width = '100%'
  watermark.style.zIndex = '1'
  image.alt = ''
  image.className = 'diary-export-watermark-image'
  image.decoding = 'sync'
  image.style.display = 'block'
  image.style.height = '34px'
  image.style.maxHeight = '34px'
  image.style.maxWidth = '180px'
  image.style.objectFit = 'contain'
  image.style.pointerEvents = 'none'
  image.style.userSelect = 'none'
  image.style.width = 'auto'
  image.src = src
  watermark.appendChild(image)
  container.appendChild(watermark)

  if (image.complete) return Promise.resolve()
  return new Promise<void>((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => resolve(), { once: true })
  })
}

function getDiaryPageContentHeight(page: HTMLElement, includeMemoryClues: boolean): number {
  const pageStyle = window.getComputedStyle(page)
  const paddingTop = cssPx(pageStyle.paddingTop)
  const paddingBottom = cssPx(pageStyle.paddingBottom)
  const children = getDiaryPageExportChildren(page, includeMemoryClues)

  if (children.length === 0) {
    return Math.ceil(Math.max(paddingTop + paddingBottom, 1))
  }

  const contentBottom = children.reduce((bottom, child) => {
    const childStyle = window.getComputedStyle(child)
    return Math.max(bottom, child.offsetTop + child.offsetHeight + cssPx(childStyle.marginBottom))
  }, paddingTop)

  return Math.ceil(Math.max(contentBottom + paddingBottom, paddingTop + paddingBottom, 1))
}

async function waitForDiaryExportReady(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll('img'))
  await Promise.all(imgs.map((img) => {
    if (img.complete) return Promise.resolve()
    return new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true })
      img.addEventListener('error', () => resolve(), { once: true })
    })
  }))
  try { await document.fonts?.ready } catch { /* 忽略字体加载异常，按当前可用字体导出 */ }
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  })
}

function getDiaryExportOptions(node: HTMLElement, includeMemoryClues: boolean, watermarkSrc: string) {
  const rect = node.getBoundingClientRect()
  const scroll = node.querySelector<HTMLElement>('.diary-reader-scroll')
  const page = node.querySelector<HTMLElement>('.diary-book-page')
  const style = window.getComputedStyle(node)
  const borderX = cssPx(style.borderLeftWidth) + cssPx(style.borderRightWidth)
  const width = Math.ceil(Math.max(node.clientWidth, rect.width - borderX, 1))
  const pageContentHeight = page ? getDiaryPageContentHeight(page, includeMemoryClues) : 0
  const fallbackHeight = Math.max(scroll?.scrollHeight ?? 0, node.scrollHeight, 1)
  const scrollHeight = Math.ceil(page ? Math.max(pageContentHeight + DIARY_EXPORT_WATERMARK_HEIGHT, 1) : fallbackHeight)
  const height = scrollHeight

  return {
    bgcolor: '#f4e7c8',
    cacheBust: true,
    filter: (target: Node) => {
      if (!(target instanceof HTMLElement)) return true
      return !target.closest('.diary-reader-toolbar, .diary-paper-close')
    },
    height,
    scale: 2,
    width,
    style: {
      height: `${height}px`,
      margin: '0',
      maxHeight: 'none',
      maxWidth: `${width}px`,
      minWidth: `${width}px`,
      overflow: 'visible',
      width: `${width}px`,
    },
    onclone: async (clone: HTMLElement) => {
      clone.classList.add('diary-exporting')
      clone.style.border = '0'
      clone.style.borderRadius = '0'
      clone.style.boxShadow = 'none'
      clone.style.height = `${height}px`
      clone.style.maxHeight = 'none'
      clone.style.overflow = 'visible'
      clone.style.width = `${width}px`
      clone.style.minWidth = `${width}px`
      clone.style.maxWidth = `${width}px`

      const clonedScroll = clone.querySelector<HTMLElement>('.diary-reader-scroll')
      if (clonedScroll) {
        clonedScroll.scrollTop = 0
        clonedScroll.style.borderRadius = '0'
        clonedScroll.style.boxShadow = 'none'
        clonedScroll.style.height = `${scrollHeight}px`
        clonedScroll.style.margin = '0'
        clonedScroll.style.maxHeight = 'none'
        clonedScroll.style.overflow = 'visible'
        clonedScroll.style.setProperty('mask-image', 'none')
        clonedScroll.style.setProperty('-webkit-mask-image', 'none')
      }

      const clonedPage = clone.querySelector<HTMLElement>('.diary-book-page')
      if (clonedPage) {
        if (!includeMemoryClues) removeMemoryClueSection(clonedPage)
        await appendDiaryExportWatermark(clonedPage, watermarkSrc)
        clonedPage.style.height = 'auto'
        clonedPage.style.margin = '0'
        clonedPage.style.minHeight = 'auto'
      }
    },
  }
}

export default function DiaryPage() {
  const [diaries, setDiaries] = useState<MemoryDiaryEntryInfo[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const selectedDateRef = useRef('')
  const [selectedDiary, setSelectedDiary] = useState<MemoryDiaryEntryInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summarizingLineIndex, setSummarizingLineIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [html, setHtml] = useState('')
  const [readerFont, setReaderFont] = useState<DiaryFontMode>('hand')
  const [fontPopoverOpen, setFontPopoverOpen] = useState(false)
  const [downloadPopoverOpen, setDownloadPopoverOpen] = useState(false)
  const [copiedDiary, setCopiedDiary] = useState(false)
  const [downloadingDiary, setDownloadingDiary] = useState(false)
  const [deletePopoverDate, setDeletePopoverDate] = useState('')
  const [deletingDiary, setDeletingDiary] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<DiarySettingsDraft>({
    summaryHour: DEFAULT_DIARY_SUMMARY_HOUR,
    customPrompt: '',
  })
  const [settingsError, setSettingsError] = useState('')
  const diaryExportRef = useRef<HTMLDivElement | null>(null)

  const loadDiarySettings = useCallback(async () => {
    setSettingsLoading(true)
    setSettingsError('')
    try {
      const [summaryHour, customPrompt] = await Promise.all([
        getDiarySummaryHour(),
        getDiaryCustomPrompt(),
      ])
      setSettingsDraft({
        summaryHour,
        customPrompt,
      })
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '读取日记设置失败')
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  const loadDiary = useCallback(async (date: string) => {
    if (!date) return
    setReading(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.readDiary(date)
      if (!res.success || !res.diary) throw new Error(res.error || '读取日记失败')
      setSelectedDiary(res.diary)
      const rendered = await marked.parse(res.diary.content || '')
      setHtml(DOMPurify.sanitize(rendered))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取日记失败')
      setSelectedDiary(null)
      setHtml('')
    } finally {
      setReading(false)
    }
  }, [])

  const loadDiaries = useCallback(async (preferredDate?: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.listDiaries(200)
      if (!res.success) throw new Error(res.error || '读取日记列表失败')
      const nextDiaries = res.diaries || []
      setDiaries(nextDiaries)
      const targetDate = preferredDate || selectedDateRef.current
      const nextSelected = nextDiaries.some((diary) => diary.date === targetDate)
        ? targetDate
        : nextDiaries[0]?.date || ''
      selectedDateRef.current = nextSelected
      setSelectedDate(nextSelected)
      if (!nextSelected) {
        setSelectedDiary(null)
        setHtml('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取日记列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDiaries()
  }, [loadDiaries])

  useEffect(() => {
    if (settingsOpen) void loadDiarySettings()
  }, [loadDiarySettings, settingsOpen])

  useEffect(() => {
    if (!summarizing) return
    const timer = window.setInterval(() => {
      setSummarizingLineIndex((index) => (index + 1) % DIARY_SUMMARIZING_LINES.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [summarizing])

  const handleSelect = (date: string) => {
    selectedDateRef.current = date
    setSelectedDate(date)
    setNotice('')
    setReaderOpen(true)
    void loadDiary(date)
  }

  const showDiary = useCallback(async (diary: MemoryDiaryEntryInfo) => {
    selectedDateRef.current = diary.date
    setSelectedDate(diary.date)
    setSelectedDiary(diary)
    setReaderOpen(true)
    const rendered = await marked.parse(diary.content || '')
    setHtml(DOMPurify.sanitize(rendered))
  }, [])

  const summarizeToday = useCallback(async () => {
    if (summarizing) return
    setSummarizing(true)
    setNotice('')
    setError('')
    setSummarizingLineIndex(0)
    setSelectedDiary(null)
    setHtml('')
    setReaderOpen(true)
    try {
      const res = await window.electronAPI.memory.summarizeTodayDiary()
      if (!res.success || !res.diary) throw new Error(res.error || '总结日记失败')
      if (res.alreadyExists) {
        setNotice(EXISTING_TODAY_DIARY_NOTICE)
        await showDiary(res.diary)
      } else {
        await showDiary(res.diary)
        await loadDiaries(res.diary.date)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '总结日记失败')
      setReaderOpen(false)
    } finally {
      setSummarizing(false)
    }
  }, [loadDiaries, showDiary, summarizing])

  const deleteDiary = useCallback(async (date: string) => {
    if (!date || deletingDiary) return
    setDeletingDiary(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.deleteDiary(date)
      if (!res.success) throw new Error(res.error || '删除日记失败')
      setDeletePopoverDate('')
      await loadDiaries()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除日记失败')
    } finally {
      setDeletingDiary(false)
    }
  }, [deletingDiary, loadDiaries])

  const copyDiaryText = useCallback(async () => {
    const text = stripMemoryIndex(selectedDiary?.content || '').trim()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopiedDiary(true)
    window.setTimeout(() => setCopiedDiary(false), 1200)
  }, [selectedDiary])

  const downloadDiaryImage = useCallback(async (memoryMode: DiaryExportMemoryMode = 'with-memory') => {
    const node = diaryExportRef.current
    if (!node || downloadingDiary) return

    const includeMemoryClues = memoryMode === 'with-memory'
    setDownloadPopoverOpen(false)
    setDownloadingDiary(true)
    try {
      await waitForDiaryExportReady(node)

      const domtoimage = (await import('dom-to-image-more')).default
      const watermarkSrc = await loadDiaryExportWatermarkSrc()
      const dataUrl = await domtoimage.toPng(node, getDiaryExportOptions(node, includeMemoryClues, watermarkSrc))
      const link = document.createElement('a')
      link.download = `${selectedDiary?.date || 'diary'}-日记${includeMemoryClues ? '' : '-不含记忆线索'}.png`
      link.href = dataUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载日记图片失败')
    } finally {
      setDownloadingDiary(false)
    }
  }, [downloadingDiary, selectedDiary])

  const updateSettingsDraft = useCallback((patch: Partial<DiarySettingsDraft>) => {
    setSettingsDraft((draft) => ({
      ...draft,
      ...patch,
    }))
  }, [])

  const resetSettingsDraft = useCallback(() => {
    setSettingsDraft({
      summaryHour: DEFAULT_DIARY_SUMMARY_HOUR,
      customPrompt: '',
    })
    setSettingsError('')
  }, [])

  const saveDiarySettings = useCallback(async () => {
    if (settingsSaving) return
    setSettingsSaving(true)
    setSettingsError('')
    try {
      const summaryHour = normalizeDiarySummaryHour(settingsDraft.summaryHour)
      const customPrompt = normalizeDiaryCustomPrompt(settingsDraft.customPrompt)
      await Promise.all([
        setDiarySummaryHour(summaryHour),
        setDiaryCustomPrompt(customPrompt),
      ])
      setSettingsDraft({ summaryHour, customPrompt })
      setSettingsOpen(false)
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '保存日记设置失败')
    } finally {
      setSettingsSaving(false)
    }
  }, [settingsDraft.customPrompt, settingsDraft.summaryHour, settingsSaving])

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--bg-primary)">
      <header className="flex shrink-0 items-center justify-between gap-4 px-7 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted">
            <BookOpen className="size-4" />
            <span>Memory Diary</span>
          </div>
          <h1 className="m-0 mt-1 text-2xl font-semibold text-foreground">日记</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button isDisabled={summarizing} variant="primary" onPress={() => void summarizeToday()}>
            <PencilToLine className="size-4" />
            总结日记
          </Button>
          <Button isIconOnly aria-label="日记设置" variant="ghost" onPress={() => setSettingsOpen(true)}>
            <Gear className="size-4" />
          </Button>
          <Button isIconOnly aria-label="刷新日记" variant="ghost" onPress={() => void loadDiaries()}>
            <ArrowsRotateLeft className="size-4" />
          </Button>
        </div>
      </header>

      {error && (
        <Card className="mx-7 mb-4 border-danger/20 bg-danger-soft text-danger-soft-foreground">
          <Card.Header>
            <Card.Description>{error}</Card.Description>
          </Card.Header>
        </Card>
      )}

      {notice && (
        <Card className="mx-7 mb-4">
          <Card.Header className="gap-2">
            <Card.Title className="text-base">今天的日记</Card.Title>
            <Card.Description className="text-sm leading-7">{notice}</Card.Description>
          </Card.Header>
        </Card>
      )}

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : diaries.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-7">
          <Card className="w-full max-w-120 text-center">
            <Card.Header className="items-center gap-3">
              <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-soft-foreground">
                <BookOpen className="size-5" />
              </div>
              <Card.Title>还没有日记</Card.Title>
              <Card.Description>等夜间整理完成后，这里会出现第一张日记卡片。</Card.Description>
            </Card.Header>
          </Card>
        </div>
      ) : (
        <ScrollShadow hideScrollBar className="min-h-0 flex-1 px-7 pb-7" size={48}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4 pr-1">
            {diaries.map((diary) => {
              const active = diary.date === selectedDate
              const preview = splitCardPreview(cardPreview(diary))
              return (
                <Card
                  key={diary.date}
                  variant={active ? 'secondary' : 'default'}
                  className="diary-list-card relative overflow-hidden"
                >
                  <Card.Header className="gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <Card.Title className="truncate text-base">{diary.title}</Card.Title>
                      <span className="shrink-0 text-xs text-muted">{formatDiaryDate(diary.date)}</span>
                    </div>
                    <div className="relative max-h-27 overflow-hidden">
                      <Card.Description className="diary-card-preview text-sm leading-7">
                        <span className="diary-card-preview-head">{preview.head}</span>
                        {preview.truncated && (
                          <span className="diary-card-preview-tail">{preview.tail}</span>
                        )}
                      </Card.Description>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        className="px-4"
                        size="sm"
                        variant="secondary"
                        onPress={() => handleSelect(diary.date)}
                      >
                        <BookOpen className="size-4" />
                        点击查看
                      </Button>
                      <Popover
                        isOpen={deletePopoverDate === diary.date}
                        onOpenChange={(open) => setDeletePopoverDate(open ? diary.date : '')}
                      >
                        <Button
                          isIconOnly
                          aria-label="删除日记"
                          className="hover:bg-danger hover:text-white"
                          isDisabled={deletingDiary}
                          size="sm"
                          variant="ghost"
                        >
                          <TrashBin className="size-4" />
                        </Button>
                        <Popover.Content placement="bottom end" offset={8}>
                          <Popover.Dialog className="w-60 p-3">
                            <p className="m-0 text-sm leading-6 text-foreground">删除这一天的日记？删掉后无法恢复。</p>
                            <div className="mt-3 flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onPress={() => setDeletePopoverDate('')}>
                                取消
                              </Button>
                              <Button
                                isDisabled={deletingDiary}
                                size="sm"
                                variant="danger"
                                onPress={() => void deleteDiary(diary.date)}
                              >
                                {deletingDiary ? <Spinner size="sm" /> : '删除'}
                              </Button>
                            </div>
                          </Popover.Dialog>
                        </Popover.Content>
                      </Popover>
                    </div>
                  </Card.Header>
                </Card>
              )
            })}
          </div>
        </ScrollShadow>
      )}

      <Modal.Backdrop isOpen={settingsOpen} onOpenChange={(open) => {
        if (!settingsSaving) setSettingsOpen(open)
      }} variant="blur">
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog className="bg-transparent p-0 shadow-none">
            <Card className="w-full gap-0 p-0">
              <Modal.CloseTrigger />
              <Card.Header className="flex-row items-start gap-3 border-b border-border p-5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                  <Gear className="size-5" />
                </div>
                <div className="min-w-0">
                  <Card.Title>日记设置</Card.Title>
                  <Card.Description>调整自动总结时间和日记输出方式。</Card.Description>
                </div>
              </Card.Header>

              <Card.Content className="space-y-5 p-5">
                {settingsLoading ? (
                  <div className="flex h-48 items-center justify-center">
                    <Spinner />
                  </div>
                ) : (
                  <>
                    {settingsError && (
                      <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
                        {settingsError}
                      </div>
                    )}

                    <TimeField
                      fullWidth
                      granularity="hour"
                      hourCycle={24}
                      maxValue={new Time(23, 0)}
                      minValue={new Time(0, 0)}
                      shouldForceLeadingZeros
                      value={toDiarySummaryTime(settingsDraft.summaryHour)}
                      onChange={(value) => {
                        if (value) updateSettingsDraft({ summaryHour: normalizeDiarySummaryHour(value.hour) })
                      }}
                    >
                      <Label>自动总结时间</Label>
                      <TimeField.Group fullWidth variant="secondary">
                        <TimeField.Prefix>
                          <Clock className="size-4 text-muted-foreground" />
                        </TimeField.Prefix>
                        <TimeField.Input>
                          {(segment) => <TimeField.Segment segment={segment} />}
                        </TimeField.Input>
                      </TimeField.Group>
                      <Description className="flex items-center gap-1.5">
                        每天 {String(settingsDraft.summaryHour).padStart(2, '0')}:00 后整理当天内容。
                      </Description>
                    </TimeField>

                    <TextField
                      fullWidth
                      value={settingsDraft.customPrompt}
                      onChange={(value) => updateSettingsDraft({ customPrompt: normalizeDiaryCustomPrompt(value) })}
                    >
                      <Label>用户提示词</Label>
                      <InputGroup fullWidth variant="secondary">
                        <InputGroup.TextArea
                          placeholder="例如：请写成工作日报，包含今日进展、风险、明日计划，语言简洁。"
                          rows={8}
                        />
                      </InputGroup>
                      <Description>
                        留空使用默认日记规则；记忆线索会继续作为内部索引保留。{settingsDraft.customPrompt.length}/{MAX_DIARY_CUSTOM_PROMPT_LENGTH}
                      </Description>
                    </TextField>
                  </>
                )}
              </Card.Content>

              <Card.Footer className="flex justify-end gap-2 border-t border-border p-5">
                <Button
                  isDisabled={settingsLoading || settingsSaving}
                  type="button"
                  variant="tertiary"
                  onPress={resetSettingsDraft}
                >
                  <ArrowRotateLeft className="size-4" />
                  恢复默认
                </Button>
                <Button
                  isDisabled={settingsLoading}
                  isPending={settingsSaving}
                  type="button"
                  variant="primary"
                  onPress={() => void saveDiarySettings()}
                >
                  <FloppyDisk className="size-4" />
                  保存
                </Button>
              </Card.Footer>
            </Card>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={readerOpen} onOpenChange={setReaderOpen} variant="blur">
        <Modal.Container className="py-10" size="cover" placement="center" scroll="inside">
          <Modal.Dialog className="relative bg-transparent p-0 shadow-none">
            <Card
              ref={diaryExportRef}
              className="diary-book-card relative mx-auto flex max-h-[calc(100vh-5rem)] w-full max-w-210 flex-col overflow-hidden rounded-4xl p-0"
            >
              <Modal.CloseTrigger className="diary-paper-tool-button diary-paper-close absolute right-4 top-4 z-20" />
              {!reading && !summarizing && selectedDiary && (
                <Toolbar
                  isAttached
                  aria-label="日记工具栏"
                  className="diary-reader-toolbar absolute left-4 top-4 z-20"
                >
                  <Popover isOpen={fontPopoverOpen} onOpenChange={setFontPopoverOpen}>
                    <Button
                      isIconOnly
                      aria-label="切换字体"
                      className="diary-paper-tool-button"
                      size="sm"
                      variant="tertiary"
                    >
                      <Text className="size-4" />
                    </Button>
                    <Popover.Content placement="bottom start" offset={8}>
                      <Popover.Dialog className="p-1">
                        <ListBox
                          aria-label="选择日记字体"
                          className="w-36"
                          selectedKeys={new Set([readerFont])}
                          selectionMode="single"
                          onSelectionChange={(keys) => {
                            const next = [...keys][0]
                            if (!next) return
                            setReaderFont(String(next) as DiaryFontMode)
                            setFontPopoverOpen(false)
                          }}
                        >
                          {DIARY_FONT_OPTIONS.map((option) => (
                            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                              <Label>{option.label}</Label>
                              <ListBox.ItemIndicator>
                                {({ isSelected }) => isSelected ? <Check className="size-4 text-accent" /> : null}
                              </ListBox.ItemIndicator>
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Popover.Dialog>
                    </Popover.Content>
                  </Popover>
                  <Button
                    isIconOnly
                    aria-label="复制日记文本"
                    className="diary-paper-tool-button"
                    size="sm"
                    variant="tertiary"
                    onPress={() => void copyDiaryText()}
                  >
                    {copiedDiary ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                  <Popover isOpen={downloadPopoverOpen} onOpenChange={setDownloadPopoverOpen}>
                    <Button
                      isIconOnly
                      aria-label="下载日记图片"
                      className="diary-paper-tool-button"
                      isDisabled={downloadingDiary}
                      size="sm"
                      variant="tertiary"
                    >
                      {downloadingDiary ? <Spinner size="sm" /> : <ArrowDownToLine className="size-4" />}
                    </Button>
                    <Popover.Content placement="bottom start" offset={8}>
                      <Popover.Dialog className="p-1">
                        <ListBox
                          aria-label="选择日记图片下载内容"
                          className="w-44"
                          selectionMode="none"
                          onAction={(key) => void downloadDiaryImage(String(key) as DiaryExportMemoryMode)}
                        >
                          {DIARY_EXPORT_MEMORY_OPTIONS.map((option) => (
                            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                              <Label>{option.label}</Label>
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Popover.Dialog>
                    </Popover.Content>
                  </Popover>
                </Toolbar>
              )}
              <Card.Content className="relative z-10 min-h-0 p-0">
                {summarizing ? (
                  <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-8 py-20 text-center">
                    <div className="flex size-14 items-center justify-center rounded-full bg-black/5">
                      <PencilToLine className="size-6 animate-pulse" />
                    </div>
                    <div className="text-2xl font-semibold">正在总结日记</div>
                    <p className="diary-summary-line m-0 max-w-md text-base leading-8 opacity-70" key={summarizingLineIndex}>
                      {DIARY_SUMMARIZING_LINES[summarizingLineIndex]}
                    </p>
                  </div>
                ) : reading ? (
                  <div className="flex h-80 items-center justify-center">
                    <Spinner />
                  </div>
                ) : (
                  <ScrollShadow hideScrollBar className="diary-reader-scroll max-h-[calc(100vh-5rem)]" size={56}>
                    <article
                      className={`diary-markdown diary-book-page diary-font-${readerFont} w-full px-0 py-20`}
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  </ScrollShadow>
                )}
              </Card.Content>
            </Card>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <style>
        {`
          @font-face {
            font-family: "CipherTalkDiaryHand";
            src: url("/日记1.ttf") format("truetype");
            font-display: swap;
          }
          .diary-book-card {
            color: #3e3022;
            gap: 0 !important;
            isolation: isolate;
            padding: 0 !important;
            background:
              linear-gradient(135deg, rgba(255, 255, 255, 0.36), transparent 38%),
              linear-gradient(90deg, rgba(74, 48, 22, 0.1), transparent 4.2rem),
              #f2e3bd;
            border: 1px solid rgba(87, 60, 31, 0.22);
            box-shadow:
              0 26px 70px rgba(36, 24, 10, 0.28),
              0 2px 0 rgba(255, 255, 255, 0.5) inset,
              0 -2px 0 rgba(82, 58, 31, 0.08) inset;
          }
          .dark .diary-book-card {
            color: #3e3022;
            background:
              linear-gradient(135deg, rgba(255, 255, 255, 0.3), transparent 38%),
              linear-gradient(90deg, rgba(74, 48, 22, 0.12), transparent 4.2rem),
              #f2e3bd;
          }
          .diary-book-card::before {
            content: "";
            position: absolute;
            inset: 0;
            z-index: 0;
            pointer-events: none;
            background:
              radial-gradient(circle at 2.1rem 4.75rem, rgba(55, 38, 19, 0.24) 0 0.32rem, rgba(255, 249, 229, 0.96) 0.36rem 0.7rem, transparent 0.73rem),
              radial-gradient(circle at 2.1rem 11.65rem, rgba(55, 38, 19, 0.2) 0 0.32rem, rgba(255, 249, 229, 0.92) 0.36rem 0.7rem, transparent 0.73rem),
              radial-gradient(circle at 2.1rem 18.55rem, rgba(55, 38, 19, 0.18) 0 0.32rem, rgba(255, 249, 229, 0.9) 0.36rem 0.7rem, transparent 0.73rem),
              linear-gradient(90deg, rgba(61, 39, 18, 0.12), transparent 0.95rem, transparent calc(100% - 1.2rem), rgba(61, 39, 18, 0.08));
            filter: drop-shadow(0 1px 1px rgba(58, 38, 16, 0.16));
          }
          .diary-book-card::after {
            content: "";
            position: absolute;
            inset: 0;
            z-index: 0;
            pointer-events: none;
            opacity: 0.42;
            background:
              linear-gradient(100deg, transparent 0 78%, rgba(115, 78, 35, 0.08) 88%, rgba(255, 255, 255, 0.24) 96%, transparent 100%),
              radial-gradient(circle at 20% 10%, rgba(93, 65, 30, 0.12) 0 0.035rem, transparent 0.055rem),
              radial-gradient(circle at 70% 30%, rgba(93, 65, 30, 0.1) 0 0.03rem, transparent 0.05rem),
              radial-gradient(circle at 46% 78%, rgba(93, 65, 30, 0.08) 0 0.03rem, transparent 0.05rem);
            background-size: 100% 100%, 1.9rem 1.9rem, 2.6rem 2.6rem, 2.2rem 2.2rem;
            mix-blend-mode: multiply;
          }
          .diary-reader-scroll {
            background:
              linear-gradient(90deg, transparent 0 4.78rem, rgba(179, 74, 72, 0.42) 4.78rem, rgba(179, 74, 72, 0.42) 4.86rem, transparent 4.86rem),
              repeating-linear-gradient(180deg, transparent 0 3.52rem, rgba(66, 114, 146, 0.24) 3.52rem, rgba(66, 114, 146, 0.24) calc(3.52rem + 1px), transparent calc(3.52rem + 1px) 3.84rem),
              radial-gradient(circle at 24% 18%, rgba(112, 79, 36, 0.09) 0 0.035rem, transparent 0.055rem),
              radial-gradient(circle at 62% 64%, rgba(112, 79, 36, 0.08) 0 0.03rem, transparent 0.05rem),
              linear-gradient(90deg, rgba(104, 70, 31, 0.08), transparent 1.2rem, transparent calc(100% - 1rem), rgba(104, 70, 31, 0.06)),
              rgba(255, 249, 226, 0.52);
            background-attachment: local, local, local, local, local, local;
            background-size: auto, auto, 2.1rem 2.1rem, 2.6rem 2.6rem, auto, auto;
            border-radius: inherit;
            box-shadow:
              inset 0.85rem 0 1.2rem -1.4rem rgba(47, 30, 12, 0.48),
              inset -1.2rem 0 1.8rem -1.8rem rgba(47, 30, 12, 0.38);
            width: 100%;
          }
          .diary-book-card.diary-exporting {
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            max-height: none !important;
            overflow: visible !important;
          }
          .diary-book-card.diary-exporting::before {
            filter: none !important;
          }
          .diary-book-card.diary-exporting .diary-reader-scroll {
            border-radius: 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            mask-image: none !important;
            max-height: none !important;
            overflow: visible !important;
            -webkit-mask-image: none !important;
          }
          .diary-book-card.diary-exporting .diary-book-page {
            margin: 0 !important;
            min-height: auto !important;
          }
          .diary-book-card.diary-exporting .diary-export-watermark {
            align-items: center;
            display: flex;
            height: 52px;
            justify-content: center;
            margin: 16px 0 0;
            pointer-events: none;
            position: relative;
            width: 100%;
            z-index: 1;
          }
          .diary-book-card.diary-exporting .diary-export-watermark-image {
            display: block;
            height: 34px;
            max-height: 34px;
            max-width: 180px;
            object-fit: contain;
            pointer-events: none;
            user-select: none;
            width: auto;
          }
          .diary-book-card.diary-exporting .diary-reader-toolbar,
          .diary-book-card.diary-exporting .diary-paper-close {
            display: none !important;
          }
          .diary-book-page {
            color: #3e3022;
            min-height: calc(100vh - 5rem);
            padding-left: clamp(6.2rem, 13vw, 8.75rem);
            padding-right: clamp(2.25rem, 8vw, 5.5rem);
            position: relative;
            font-size: 1.72rem;
            font-weight: 700;
            line-height: 2.2;
            letter-spacing: 0;
          }
          .diary-book-page::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background:
              linear-gradient(180deg, rgba(255, 255, 255, 0.36), transparent 12rem),
              linear-gradient(6deg, transparent 0 92%, rgba(98, 68, 31, 0.08) 96%, rgba(255, 255, 255, 0.22) 100%);
            mix-blend-mode: soft-light;
          }
          .diary-book-page > * {
            max-width: 42rem;
            position: relative;
            z-index: 1;
          }
          .diary-markdown :where(h1, h2, h3, h4, h5, h6, p, ul, ol, li, blockquote) {
            border-width: 0 !important;
            border-style: none !important;
            outline: 0 !important;
          }
          .diary-font-hand {
            font-family: "CipherTalkDiaryHand", "LXGW WenKai", "霞鹜文楷", "Ma Shan Zheng", "华文行楷", "STXingkai", "STKaiti", "KaiTi", "楷体", cursive, serif;
          }
          .diary-font-song {
            font-family: "Songti SC", "SimSun", "宋体", serif;
          }
          .diary-font-native {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          }
          .diary-reader-toolbar {
            border-color: rgba(62, 48, 34, 0.1) !important;
            background: rgba(244, 231, 200, 0.52) !important;
            color: rgba(62, 48, 34, 0.7) !important;
            box-shadow: 0 8px 24px rgba(62, 48, 34, 0.08) !important;
            backdrop-filter: blur(10px);
          }
          .diary-paper-tool-button {
            background: rgba(62, 48, 34, 0.055) !important;
            color: rgba(62, 48, 34, 0.72) !important;
            box-shadow: none !important;
          }
          .diary-paper-tool-button:hover,
          .diary-paper-tool-button[data-hovered="true"] {
            background: rgba(62, 48, 34, 0.11) !important;
            color: rgba(62, 48, 34, 0.86) !important;
          }
          .diary-markdown h1 {
            margin: 0 0 1.75rem;
            font-size: 2.85rem;
            line-height: 1.25;
            font-weight: 600;
          }
          .diary-markdown h2 {
            margin: 2rem 0 0.75rem;
            font-size: 1.85rem;
            line-height: 1.5;
            font-weight: 650;
          }
          .diary-markdown p {
            margin: 0 0 1.35rem;
          }
          .diary-markdown ul {
            margin: 0.5rem 0 1.5rem;
            padding-left: 1.25rem;
          }
          .diary-markdown li {
            margin: 0.35rem 0;
          }
          .diary-markdown blockquote {
            margin: 1.25rem 0;
            border-left: 3px solid hsl(var(--heroui-accent, 180 65% 42%)) !important;
            border-top: 0 !important;
            border-right: 0 !important;
            border-bottom: 0 !important;
            padding-left: 1rem;
            color: var(--muted);
          }
          .diary-list-card::after {
            content: "";
            position: absolute;
            inset: auto 0 0 0;
            height: 45%;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.28s ease;
            background: radial-gradient(120% 130% at 50% 100%, hsl(var(--heroui-accent, 180 65% 42%) / 0.3), transparent 72%);
          }
          .diary-list-card:hover::after {
            opacity: 1;
          }
          .diary-card-preview {
            display: block;
            height: 5.25rem;
            overflow: hidden;
          }
          .diary-card-preview-head {
            display: -webkit-box;
            height: 3.5rem;
            overflow: hidden;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
          }
          .diary-card-preview-tail {
            display: block;
            overflow: hidden;
            height: 1.75rem;
            max-width: 100%;
            white-space: nowrap;
            text-overflow: ellipsis;
            filter: blur(1.25px);
            opacity: 0.62;
          }
          .diary-summary-line {
            animation: diarySummaryLineIn 420ms ease-out both;
          }
          @keyframes diarySummaryLineIn {
            from {
              opacity: 0;
              transform: translate3d(0, 6px, 0);
              filter: blur(4px);
            }
            to {
              opacity: 1;
              transform: translate3d(0, 0, 0);
              filter: blur(0);
            }
          }
        `}
      </style>
    </div>
  )
}
