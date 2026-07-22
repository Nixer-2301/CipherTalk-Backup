import { useEffect, useMemo, useState, type Key } from 'react'
import type { TimeValue } from 'react-aria-components/TimeField'
import { Button as HeroButton, Calendar as HeroCalendar, DateField, DatePicker, Label, ListBox, Modal, ScrollShadow, Select, Switch, Tabs, TextArea, TextField, TimeField, toast } from '@heroui/react'
import { ArrowDownToLine, Bell, Calendar as CalendarIcon, Check, CircleDashed, CircleQuestion, Display, FaceRobot, FileZipper, Magnifier, Plus, TrashBin, Volume } from '@gravity-ui/icons'
import { CalendarDateTime, Time } from '@internationalized/date'
import { cn } from '../lib/utils'
import { PetSprite } from '../features/pets/PetSprite'
import type { PersonaRecordInfo } from '../types/electron'

type InstalledPet = { slug: string; displayName: string; description: string; spriteUrl: string; builtin?: boolean }
type OnlinePet = { slug: string; displayName: string; submittedBy?: string; spritesheetUrl: string }
type PetTab = 'gallery' | 'installed' | 'interaction'
type PetReminderKind = 'once' | 'daily' | 'yearly'
type PetReminder = {
  id: string
  text: string
  kind: PetReminderKind
  date?: string
  time: string
  lastFired?: string
}
type ReminderDraft = {
  text: string
  kind: PetReminderKind
  date: string
  time: string
}

const ONLINE_PAGE_SIZE = 30
const AI_ASSISTANT_KEY = '__ai_assistant__'

function localDateInputValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function defaultReminderTime(): string {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 10)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDateInputParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatTimeInputParts(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseReminderDateParts(value: string): { year: number; month: number; day: number } | null {
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null

  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null

  return { year, month, day }
}

function parseReminderTimeParts(value: string): { hour: number; minute: number } | null {
  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  return { hour, minute }
}

function toReminderDateTimeValue(dateValue: string, timeValue: string): CalendarDateTime | null {
  const date = parseReminderDateParts(dateValue)
  const time = parseReminderTimeParts(timeValue) ?? { hour: 0, minute: 0 }

  if (!date) return null

  return new CalendarDateTime(date.year, date.month, date.day, time.hour, time.minute)
}

function toReminderTimeValue(value: string): Time | null {
  const time = parseReminderTimeParts(value)
  if (!time) return null
  return new Time(time.hour, time.minute)
}
function createReminderId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `reminder-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

function reminderKindLabel(kind: PetReminderKind): string {
  if (kind === 'daily') return '每天'
  if (kind === 'yearly') return '每年'
  return '一次'
}

function formatReminderSchedule(reminder: PetReminder): string {
  if (reminder.kind === 'daily') return `每天 ${reminder.time}`
  if (reminder.kind === 'yearly') return `每年 ${String(reminder.date || '').slice(5)} ${reminder.time}`
  return `${reminder.date || '未设日期'} ${reminder.time}`
}

/**
 * AI 宠物页：宠物库（petdex.dev 在线画廊）/ 已安装 两个 Tab，
 * 支持在线领养和本地压缩包导入。选中的宠物展示在 AI 助手页和桌面桌宠。
 */
export default function PetsPage() {
  const [tab, setTab] = useState<PetTab>('gallery')
  const [helpOpen, setHelpOpen] = useState(false)
  const [installed, setInstalled] = useState<InstalledPet[]>([])
  const [currentSlug, setCurrentSlug] = useState('')
  const [desktopEnabled, setDesktopEnabled] = useState(false)
  const [personas, setPersonas] = useState<PersonaRecordInfo[]>([])
  const [personaSessionId, setPersonaSessionId] = useState('')
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [dailySummaryEnabled, setDailySummaryEnabled] = useState(true)
  const [reminders, setReminders] = useState<PetReminder[]>([])
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft>({
    text: '',
    kind: 'once',
    date: localDateInputValue(),
    time: defaultReminderTime(),
  })
  const [online, setOnline] = useState<OnlinePet[] | null>(null)
  const [onlineError, setOnlineError] = useState('')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(ONLINE_PAGE_SIZE)
  const [installingSlug, setInstallingSlug] = useState('')
  const [importing, setImporting] = useState(false)

  const loadInstalled = async () => {
    const res = await window.electronAPI.pet.listInstalled()
    if (!res.success || !res.pets) return
    const pets = await Promise.all(res.pets.map(async (pet) => {
      const sprite = await window.electronAPI.pet.getSprite(pet.slug)
      return sprite.success && sprite.dataUrl ? { ...pet, spriteUrl: sprite.dataUrl } : null
    }))
    setInstalled(pets.filter((pet): pet is InstalledPet => pet !== null))
  }

  useEffect(() => {
    void loadInstalled()
    void window.electronAPI.config.get('petCurrent').then((value) => setCurrentSlug((value as string) || ''))
    void window.electronAPI.config.get('petDesktopEnabled').then((value) => setDesktopEnabled(Boolean(value)))
    void window.electronAPI.config.get('petPersonaSessionId').then((value) => setPersonaSessionId(String(value || '')))
    void window.electronAPI.config.get('petTtsEnabled').then((value) => setTtsEnabled(Boolean(value)))
    void window.electronAPI.config.get('petDailySummaryEnabled').then((value) => setDailySummaryEnabled(value !== false))
    void window.electronAPI.config.get('petReminders').then((value) => {
      setReminders(Array.isArray(value) ? (value as PetReminder[]) : [])
    })
    void window.electronAPI.persona.list().then((res) => {
      if (res.success && res.personas) setPersonas(res.personas)
    })
    window.electronAPI.pet.manifest()
      .then((res) => {
        if (res.success && res.pets) setOnline(res.pets)
        else setOnlineError(res.error || '在线宠物库加载失败')
      })
      .catch((error) => setOnlineError(String(error)))

    const off = window.electronAPI.config.onChanged(({ key, value }) => {
      if (key === 'petPersonaSessionId') setPersonaSessionId(String(value || ''))
      if (key === 'petTtsEnabled') setTtsEnabled(Boolean(value))
      if (key === 'petDailySummaryEnabled') setDailySummaryEnabled(value !== false)
      if (key === 'petReminders') setReminders(Array.isArray(value) ? (value as PetReminder[]) : [])
    })
    return off
  }, [])

  const filteredOnline = useMemo(() => {
    if (!online) return []
    const installedSlugs = new Set(installed.map((pet) => pet.slug))
    const keyword = query.trim().toLowerCase()
    return online.filter((pet) => {
      if (installedSlugs.has(pet.slug)) return false
      if (!keyword) return true
      return pet.slug.includes(keyword) || pet.displayName.toLowerCase().includes(keyword)
    })
  }, [online, installed, query])

  const selectPet = async (slug: string) => {
    await window.electronAPI.config.set('petCurrent', slug)
    setCurrentSlug(slug)
  }

  const removePet = async (slug: string) => {
    const res = await window.electronAPI.pet.remove(slug)
    if (!res.success) {
      toast.danger(res.error || '删除失败')
      return
    }
    if (currentSlug === slug) setCurrentSlug('')
    void loadInstalled()
  }

  const installPet = async (slug: string) => {
    setInstallingSlug(slug)
    try {
      const res = await window.electronAPI.pet.install(slug)
      if (res.success) {
        await loadInstalled()
        if (!currentSlug) await selectPet(slug)
        toast.success(`已领养 ${res.pet?.displayName || slug}`)
      } else {
        toast.danger(res.error || '安装失败')
      }
    } finally {
      setInstallingSlug('')
    }
  }

  const importZip = async () => {
    setImporting(true)
    try {
      const res = await window.electronAPI.pet.importZip()
      if (res.success && res.pet) {
        await loadInstalled()
        if (!currentSlug) await selectPet(res.pet.slug)
        toast.success(`已导入 ${res.pet.displayName}`)
      } else if (!res.canceled) {
        toast.danger(res.error || '导入失败')
      }
    } finally {
      setImporting(false)
    }
  }

  const toggleDesktop = async (enabled: boolean) => {
    setDesktopEnabled(enabled)
    await window.electronAPI.pet.toggleDesktopWindow(enabled)
  }

  const selectPersona = async (key: Key | null) => {
    const value = key == null || String(key) === AI_ASSISTANT_KEY ? '' : String(key)
    setPersonaSessionId(value)
    await window.electronAPI.config.set('petPersonaSessionId', value)
  }

  const toggleTts = async (enabled: boolean) => {
    setTtsEnabled(enabled)
    await window.electronAPI.config.set('petTtsEnabled', enabled)
  }

  const toggleDailySummary = async (enabled: boolean) => {
    setDailySummaryEnabled(enabled)
    await window.electronAPI.config.set('petDailySummaryEnabled', enabled)
    if (enabled) await window.electronAPI.config.set('petDailySummaryDate', '')
  }

  const saveReminders = async (next: PetReminder[]) => {
    setReminders(next)
    await window.electronAPI.config.set('petReminders', next)
  }

  const addReminder = async () => {
    const text = reminderDraft.text.trim()
    if (!text) {
      toast.danger('先写提醒内容')
      return
    }
    if (!reminderDraft.time) {
      toast.danger('先设置提醒时间')
      return
    }
    if (reminderDraft.kind !== 'daily' && !reminderDraft.date) {
      toast.danger('先设置提醒日期')
      return
    }
    const next: PetReminder = {
      id: createReminderId(),
      text,
      kind: reminderDraft.kind,
      time: reminderDraft.time,
      ...(reminderDraft.kind === 'daily' ? {} : { date: reminderDraft.date }),
    }
    await saveReminders([...reminders, next])
    setReminderDraft((draft) => ({ ...draft, text: '' }))
  }

  const removeReminder = async (id: string) => {
    await saveReminders(reminders.filter((item) => item.id !== id))
  }

  const petGridClass = 'grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8'
  const currentPersona = personas.find((persona) => persona.sessionId === personaSessionId)

  const handleReminderDateTimeChange = (value: CalendarDateTime | null) => {
    setReminderDraft((draft) => ({
      ...draft,
      date: value ? formatDateInputParts(value.year, value.month, value.day) : '',
      time: value ? formatTimeInputParts(value.hour, value.minute) : draft.time,
    }))
  }

  const handleReminderTimeChange = (value: Time | null) => {
    setReminderDraft((draft) => ({
      ...draft,
      time: value ? formatTimeInputParts(value.hour, value.minute) : '',
    }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 顶栏：Tab 切换 + 说明 + 桌宠开关 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Tabs selectedKey={tab} onSelectionChange={(key: Key) => setTab(key === 'installed' || key === 'interaction' ? key : 'gallery')}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="宠物页签">
              <Tabs.Tab className="min-w-max whitespace-nowrap" id="gallery">
                宠物库
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="min-w-max whitespace-nowrap" id="installed">
                已安装{installed.length > 0 ? `（${installed.length}）` : ''}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="min-w-max whitespace-nowrap" id="interaction">
                互动
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <div className="flex items-center gap-3">
          <HeroButton
            aria-label="使用说明"
            isIconOnly
            onPress={() => setHelpOpen(true)}
            size="sm"
            variant="ghost"
          >
            <CircleQuestion className="size-4.5" />
          </HeroButton>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-foreground text-sm">
            <Display className="size-4 text-muted" />
            桌面桌宠
            <Switch aria-label="桌面悬浮桌宠" isSelected={desktopEnabled} onChange={(selected) => void toggleDesktop(Boolean(selected))}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch>
          </label>
        </div>
      </div>

      <ScrollShadow hideScrollBar className="min-h-0 flex-1 pb-3" size={56}>
        {tab === 'gallery' ? (
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted text-sm">
                petdex.dev 开源画廊{online ? ` · ${filteredOnline.length} 只可领养` : ''}
              </span>
              <div className="relative">
                <Magnifier className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted" />
                <input
                  className="h-9 w-60 rounded-full border border-border bg-surface pr-3 pl-8 text-foreground text-sm outline-none placeholder:text-muted focus:border-primary"
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setVisibleCount(ONLINE_PAGE_SIZE)
                  }}
                  placeholder="搜索宠物…"
                  value={query}
                />
              </div>
            </div>
            {!online && !onlineError && (
              <p className="flex items-center gap-2 px-1 py-6 text-muted text-sm">
                <CircleDashed className="size-4 animate-spin" />
                正在加载在线宠物库…
              </p>
            )}
            {onlineError && (
              <p className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-danger text-sm">
                {onlineError}
              </p>
            )}
            {online && (
              <>
                <div className={petGridClass}>
                  {filteredOnline.slice(0, visibleCount).map((pet) => (
                    <div
                      className="ct-pet-card flex flex-col items-center gap-1.5 rounded-2xl border border-border p-3"
                      key={pet.slug}
                      title={pet.submittedBy ? `by ${pet.submittedBy}` : pet.displayName}
                    >
                      <PetSprite scale={0.4} src={pet.spritesheetUrl} state="idle" />
                      <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                      <HeroButton
                        className="h-7 w-full min-w-0 rounded-full text-xs"
                        isDisabled={installingSlug !== ''}
                        onPress={() => void installPet(pet.slug)}
                        size="sm"
                        variant="secondary"
                      >
                        {installingSlug === pet.slug
                          ? <CircleDashed className="size-3 animate-spin" />
                          : <ArrowDownToLine className="size-3" />}
                        领养
                      </HeroButton>
                    </div>
                  ))}
                </div>
                {filteredOnline.length > visibleCount && (
                  <div className="mt-3 flex justify-center">
                    <HeroButton className="rounded-full" onPress={() => setVisibleCount((count) => count + ONLINE_PAGE_SIZE)} size="sm" variant="tertiary">
                      加载更多（还有 {filteredOnline.length - visibleCount} 只）
                    </HeroButton>
                  </div>
                )}
              </>
            )}
          </section>
        ) : tab === 'installed' ? (
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted text-sm">点击宠物选用或取消，普通宠物悬停可删除</span>
              <HeroButton
                className="rounded-full"
                isDisabled={importing}
                onPress={() => void importZip()}
                size="sm"
                variant="secondary"
              >
                {importing ? <CircleDashed className="size-3.5 animate-spin" /> : <FileZipper className="size-3.5" />}
                导入压缩包
              </HeroButton>
            </div>
            {installed.length === 0 ? (
              <p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted text-sm">
                还没有宠物，去宠物库领养一只，或导入下载好的宠物压缩包
              </p>
            ) : (
              <div className={petGridClass}>
                {installed.map((pet) => {
                  const selected = pet.slug === currentSlug
                  return (
                    <button
                      className={cn(
                        'ct-pet-card group relative flex flex-col items-center gap-1.5 rounded-2xl border p-3 transition-colors',
                        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-tertiary'
                      )}
                      data-pet-live={selected || undefined}
                      key={pet.slug}
                      onClick={() => void selectPet(selected ? '' : pet.slug)}
                      title={selected ? '点击取消展示' : pet.description || pet.displayName}
                      type="button"
                    >
                      <PetSprite scale={0.4} src={pet.spriteUrl} state={selected ? 'waving' : 'idle'} />
                      <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                      {selected && (
                        <span className="absolute top-1.5 left-1.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                          <Check className="size-3" />
                        </span>
                      )}
                      {pet.builtin ? (
                        <span className="absolute top-1.5 right-1.5 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[10px] text-muted">
                          内置
                        </span>
                      ) : (
                        <span
                          className="absolute top-1.5 right-1.5 rounded-full p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          onClick={(event) => {
                            event.stopPropagation()
                            void removePet(pet.slug)
                          }}
                          role="button"
                          title="删除宠物"
                        >
                          <TrashBin className="size-3.5" />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        ) : (
          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="mb-4 flex items-start gap-3">
                  <span className="rounded-full bg-primary/10 p-2 text-primary">
                    <FaceRobot className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-semibold text-foreground text-sm">数字分身实体</h2>
                    <p className="mt-0.5 text-muted text-xs">点击桌宠时使用这里绑定的分身对话；未绑定时走 AI 助手。</p>
                  </div>
                </div>
                <Select
                  fullWidth
                  onSelectionChange={(key) => void selectPersona(key)}
                  placeholder="AI 助手"
                  selectedKey={personaSessionId || AI_ASSISTANT_KEY}
                  variant="secondary"
                >
                  <Label>快捷对话对象</Label>
                  <Select.Trigger>
                    <Select.Value>
                      {() => currentPersona?.displayName || 'AI 助手'}
                    </Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id={AI_ASSISTANT_KEY} textValue="AI 助手">
                        AI 助手
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      {personas.map((persona) => (
                        <ListBox.Item id={persona.sessionId} key={persona.sessionId} textValue={persona.displayName}>
                          {persona.displayName}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                {personas.length === 0 && (
                  <p className="mt-2 text-muted text-xs">还没有数字分身，创建后会出现在这里。</p>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="mb-4 flex items-start gap-3">
                  <span className="rounded-full bg-primary/10 p-2 text-primary">
                    <Volume className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-semibold text-foreground text-sm">播报</h2>
                    <p className="mt-0.5 text-muted text-xs">桌宠气泡、每日摘要和快捷对话回复可使用已配置的 TTS 朗读。</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-secondary px-3 py-2">
                    <span className="text-foreground text-sm">朗读气泡和回复</span>
                    <Switch aria-label="朗读气泡和回复" isSelected={ttsEnabled} onChange={(selected) => void toggleTts(Boolean(selected))}>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch>
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-secondary px-3 py-2">
                    <span className="text-foreground text-sm">每日摘要播报</span>
                    <Switch aria-label="每日摘要播报" isSelected={dailySummaryEnabled} onChange={(selected) => void toggleDailySummary(Boolean(selected))}>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch>
                  </label>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="mb-4 flex items-start gap-3">
                <span className="rounded-full bg-primary/10 p-2 text-primary">
                  <CalendarIcon className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <h2 className="font-semibold text-foreground text-sm">纪念日 / 定时提醒</h2>
                  <p className="mt-0.5 text-muted text-xs">到点后桌宠弹气泡；桌宠没开时走系统通知。</p>
                </div>
              </div>

              <div className="grid gap-3">
                <Select
                  fullWidth
                  onSelectionChange={(key) => {
                    if (key) setReminderDraft((draft) => ({ ...draft, kind: key as PetReminderKind }))
                  }}
                  selectedKey={reminderDraft.kind}
                  variant="secondary"
                >
                  <Label>类型</Label>
                  <Select.Trigger>
                    <Select.Value>{() => reminderKindLabel(reminderDraft.kind)}</Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="once" textValue="一次提醒">一次提醒<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="daily" textValue="每天提醒">每天提醒<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="yearly" textValue="纪念日">纪念日<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                {reminderDraft.kind === 'daily' ? (
                  <TimeField
                    fullWidth
                    granularity="minute"
                    hourCycle={24}
                    shouldForceLeadingZeros
                    value={toReminderTimeValue(reminderDraft.time)}
                    onChange={handleReminderTimeChange}
                  >
                    <Label>提醒时间</Label>
                    <TimeField.Group fullWidth variant="secondary">
                      <TimeField.Input>
                        {(segment) => <TimeField.Segment segment={segment} />}
                      </TimeField.Input>
                    </TimeField.Group>
                  </TimeField>
                ) : (
                  <DatePicker
                    className="w-full"
                    granularity="minute"
                    hourCycle={24}
                    shouldForceLeadingZeros
                    value={toReminderDateTimeValue(reminderDraft.date, reminderDraft.time)}
                    onChange={handleReminderDateTimeChange}
                  >
                    {({ state }) => (
                      <>
                        <Label>{reminderDraft.kind === 'yearly' ? '纪念日时间' : '提醒时间'}</Label>
                        <DateField.Group fullWidth variant="secondary">
                          <DateField.Input>
                            {(segment) => <DateField.Segment segment={segment} />}
                          </DateField.Input>
                          <DateField.Suffix>
                            <DatePicker.Trigger>
                              <DatePicker.TriggerIndicator />
                            </DatePicker.Trigger>
                          </DateField.Suffix>
                        </DateField.Group>
                        <DatePicker.Popover className="flex flex-col gap-3">
                          <HeroCalendar aria-label="选择提醒日期">
                            <HeroCalendar.Header>
                              <HeroCalendar.YearPickerTrigger>
                                <HeroCalendar.YearPickerTriggerHeading />
                                <HeroCalendar.YearPickerTriggerIndicator />
                              </HeroCalendar.YearPickerTrigger>
                              <HeroCalendar.NavButton slot="previous" />
                              <HeroCalendar.NavButton slot="next" />
                            </HeroCalendar.Header>
                            <HeroCalendar.Grid>
                              <HeroCalendar.GridHeader>
                                {(day) => <HeroCalendar.HeaderCell>{day}</HeroCalendar.HeaderCell>}
                              </HeroCalendar.GridHeader>
                              <HeroCalendar.GridBody>
                                {(date) => <HeroCalendar.Cell date={date} />}
                              </HeroCalendar.GridBody>
                            </HeroCalendar.Grid>
                            <HeroCalendar.YearPickerGrid>
                              <HeroCalendar.YearPickerGridBody>
                                {({ year }) => <HeroCalendar.YearPickerCell year={year} />}
                              </HeroCalendar.YearPickerGridBody>
                            </HeroCalendar.YearPickerGrid>
                          </HeroCalendar>
                          <div className="flex items-center justify-between gap-3">
                            <Label>时间</Label>
                            <TimeField
                              aria-label="时间"
                              granularity="minute"
                              hourCycle={24}
                              shouldForceLeadingZeros
                              value={state.timeValue}
                              onChange={(value) => state.setTimeValue(value as TimeValue)}
                            >
                              <TimeField.Group variant="secondary">
                                <TimeField.Input>
                                  {(segment) => <TimeField.Segment segment={segment} />}
                                </TimeField.Input>
                              </TimeField.Group>
                            </TimeField>
                          </div>
                        </DatePicker.Popover>
                      </>
                    )}
                  </DatePicker>
                )}

                <TextField
                  fullWidth
                  onChange={(value) => setReminderDraft((draft) => ({ ...draft, text: value }))}
                  value={reminderDraft.text}
                >
                  <Label>提醒内容</Label>
                  <TextArea placeholder="例如：记得喝水，或者今天是纪念日" rows={3} variant="secondary" />
                </TextField>

                <HeroButton className="rounded-full" fullWidth onPress={() => void addReminder()} size="sm" variant="secondary">
                  <Plus className="size-3.5" />
                  添加提醒
                </HeroButton>
              </div>

              <div className="mt-4 space-y-2">
                {reminders.length === 0 ? (
                  <p className="rounded-xl border border-border border-dashed px-3 py-4 text-center text-muted text-xs">
                    暂无提醒
                  </p>
                ) : reminders.map((reminder) => (
                  <div className="flex items-start gap-2 rounded-xl border border-border bg-surface-secondary px-3 py-2" key={reminder.id}>
                    <Bell className="mt-0.5 size-3.5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-foreground text-xs">{reminder.text}</p>
                      <p className="mt-0.5 text-muted text-[11px]">{formatReminderSchedule(reminder)}</p>
                    </div>
                    <HeroButton
                      aria-label="删除提醒"
                      isIconOnly
                      onPress={() => void removeReminder(reminder.id)}
                      size="sm"
                      variant="ghost"
                    >
                      <TrashBin className="size-3.5" />
                    </HeroButton>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </ScrollShadow>

      {/* 使用说明 */}
      {helpOpen && (
        <Modal>
          <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) setHelpOpen(false) }}>
            <Modal.Container className="px-3 sm:px-6" placement="center">
              <Modal.Dialog aria-label="AI 宠物说明" className="w-full max-w-110">
                <div className="flex flex-col gap-3 p-5 text-foreground text-sm leading-relaxed">
                  <h2 className="font-semibold text-base">AI 宠物是什么？</h2>
                  <p>
                    挑一只像素小伙伴陪你用 AI 助手：新对话时它在对话区中间等你，开聊后站在输入框上方——AI
                    回复时它会奔跑，出错会沮丧，完成后挥手庆祝，闲下来还会随机做点小动作。
                  </p>
                  <p>
                    打开「桌面桌宠」后，宠物会悬浮在桌面上实时反映 AI 运行状态，拖动它还会跟着跑跳。
                  </p>
                  <p className="text-muted text-xs">
                    宠物来自开源画廊 petdex.dev（与 Codex Pets 同一格式，约 3000 只），也可以导入下载好的宠物压缩包（pet.json
                    + 精灵图）。宠物素材版权归各自作者所有。
                  </p>
                </div>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </div>
  )
}
