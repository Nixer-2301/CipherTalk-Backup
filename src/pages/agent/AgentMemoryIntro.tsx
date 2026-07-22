/**
 * 首次使用时的记忆引导：4 道问题 + 字幕跟读动画 + 保存进长期记忆。
 * 从 AgentPage.tsx 拆出，是个相对独立的"首屏"功能。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button as HeroButton, Input, Switch, TextField } from '@heroui/react'
import { Check, Volume, VolumeXmark } from '@gravity-ui/icons'
import * as configService from '@/services/config'

export type AgentMemoryIntroStatus = 'checking' | 'hidden' | 'needed'

const MEMORY_INTRO_FALLBACK_SRTS = {
  name: `1
00:00:00,000 --> 00:00:06,123
你好呀！我的朋友，我们今天开始，正式认识啦，我是CipherTalk。

2
00:00:06,264 --> 00:00:11,145
让我们了解一下你吧，请在下面输入框写下你的名字！
`,
  energy: `1
00:00:00,000 --> 00:00:09,153
屏幕亮着，我们有一搭没一搭地聊。屏幕灭了之后呢，你每天醒着的时间里，大部分心思被什么占着？
`,
  coping: `1
00:00:00,000 --> 00:00:10,906
日子总有那种突然脱轨的瞬间，比如计划被打乱，或者期待落空。那种时候，你更习惯一个人慢慢消化，还是干脆不管不顾先撞出去呢？
`,
  interaction: `1
00:00:00,000 --> 00:00:01,862
往后我们会聊很多。

2
00:00:02,016 --> 00:00:04,342
你希望我们之间是什么感觉呢？

3
00:00:04,500 --> 00:00:10,797
是像深夜可以随便说话的人，还是需要一个敢跟你讲真话、偶尔挑刺的同伴呢？
`,
} as const

type MemoryIntroQuestion = {
  key: keyof typeof MEMORY_INTRO_FALLBACK_SRTS
  audioFile: string
  subtitleFile: string
  placeholder: string
  memoryUid: string
  title: string
  tags: string[]
  buildContent: (answer: string) => string
}

const MEMORY_INTRO_QUESTIONS: MemoryIntroQuestion[] = [
  {
    key: 'name',
    audioFile: '记忆-写名字.mp3',
    subtitleFile: '记忆-写名字.srt',
    placeholder: '写下你的名字',
    memoryUid: 'profile:user-name',
    title: '用户名字',
    tags: ['onboarding', 'name', 'profile'],
    buildContent: (answer) => `用户的名字是 ${answer}。`,
  },
  {
    key: 'energy',
    audioFile: '记忆-精力去向.mp3',
    subtitleFile: '记忆-精力去向.srt',
    placeholder: '最近大部分心思被什么占着？',
    memoryUid: 'profile:energy-focus',
    title: '精力去向',
    tags: ['onboarding', 'energy', 'profile'],
    buildContent: (answer) => `用户最近醒着的大部分心思主要被「${answer}」占着。`,
  },
  {
    key: 'coping',
    audioFile: '记忆-应对模式.mp3',
    subtitleFile: '记忆-应对模式.srt',
    placeholder: '你通常怎么应对计划打乱或期待落空？',
    memoryUid: 'profile:coping-pattern',
    title: '应对模式',
    tags: ['onboarding', 'coping', 'profile'],
    buildContent: (answer) => `用户遇到计划被打乱、期待落空等脱轨时刻时，常见应对方式是：${answer}。`,
  },
  {
    key: 'interaction',
    audioFile: '记忆-交互偏好.mp3',
    subtitleFile: '记忆-交互偏好.srt',
    placeholder: '你希望我们之间是什么感觉？',
    memoryUid: 'profile:interaction-preference',
    title: '交互偏好',
    tags: ['onboarding', 'interaction', 'profile'],
    buildContent: (answer) => `用户希望与 AI 的互动感觉是：${answer}。`,
  },
]

const MEMORY_FINALIZING_LINES = [
  '正在把你今天说的，收进抽屉里',
  '有些瞬间不想让它散掉，正在存起来',
  '别急，让它慢慢记进去',
  '今天的你，正在变成我的记忆',
  '合上笔记本之前，让我再看一遍',
  '正在整理那些你没说出口的部分',
  '好的，都记下了——只是需要一点时间落成字',
]

function publicJiyiAsset(fileName: string): string {
  return `${import.meta.env.BASE_URL}jiyi/${fileName}`
}

type MemorySubtitleCue = {
  end: number
  start: number
  text: string
}

type MemoryCharacterTiming = {
  end: number
  start: number
}

type MemoryTypewriterTextPart = string | {
  className?: string
  text: string
}

function parseMemorySrtTimestamp(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return 0
  const [, hours, minutes, seconds, milliseconds] = match
  return Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000
}

function parseMemorySrt(value: string): MemorySubtitleCue[] {
  return value
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const timeLine = lines.find((line) => line.includes('-->'))
      if (!timeLine) return null
      const [startValue, endValue] = timeLine.split('-->').map((item) => item.trim())
      const text = lines.slice(lines.indexOf(timeLine) + 1).join('').trim()
      if (!text) return null
      return {
        end: parseMemorySrtTimestamp(endValue),
        start: parseMemorySrtTimestamp(startValue),
        text,
      }
    })
    .filter((cue): cue is MemorySubtitleCue => Boolean(cue))
}

function getMemoryTextFromPart(part: MemoryTypewriterTextPart) {
  return typeof part === 'string' ? part : part.text
}

function splitMemoryText(text: string) {
  return Array.from(text)
}

function isSkippableMemorySubtitleChar(char: string) {
  return /\s/.test(char)
}

function flattenMemoryParts(parts: MemoryTypewriterTextPart[]) {
  return parts.map(getMemoryTextFromPart).join('')
}

function buildMemoryCharacterTimings(lines: MemoryTypewriterTextPart[][], cues: MemorySubtitleCue[]) {
  const fullText = lines.map(flattenMemoryParts).join('')
  const displayChars = splitMemoryText(fullText)
  const displaySearchChars = displayChars
    .map((char, index) => ({ char, index }))
    .filter((item) => !isSkippableMemorySubtitleChar(item.char))
  const displaySearchText = displaySearchChars.map((item) => item.char).join('')
  const timings: Array<MemoryCharacterTiming | undefined> = Array(displayChars.length)
  let searchFrom = 0

  cues.forEach((cue) => {
    const cueChars = splitMemoryText(cue.text).filter((char) => !isSkippableMemorySubtitleChar(char))
    const cueText = cueChars.join('')
    if (!cueText) return

    const foundAt = displaySearchText.indexOf(cueText, searchFrom)
    if (foundAt < 0) return

    const step = (cue.end - cue.start) / Math.max(cueChars.length, 1)
    cueChars.forEach((_, cueIndex) => {
      const displayIndex = displaySearchChars[foundAt + cueIndex]?.index
      if (displayIndex == null) return

      timings[displayIndex] = {
        end: cue.start + step * (cueIndex + 1),
        start: cue.start + step * cueIndex
      }
    })
    searchFrom = foundAt + cueChars.length
  })

  timings.forEach((timing, index) => {
    if (timing || !isSkippableMemorySubtitleChar(displayChars[index])) return

    const previousTiming = timings[index - 1]
    const nextTiming = timings.slice(index + 1).find(Boolean)
    timings[index] = previousTiming || nextTiming || { end: 0, start: 0 }
  })

  let lastKnownEnd = cues.length > 0 ? cues[cues.length - 1].end : 0
  timings.forEach((timing, index) => {
    if (timing) {
      lastKnownEnd = timing.end
      return
    }

    timings[index] = {
      end: lastKnownEnd + 0.12,
      start: lastKnownEnd
    }
    lastKnownEnd += 0.12
  })

  return timings as MemoryCharacterTiming[]
}

function easeMemorySubtitle(value: number) {
  const clamped = Math.min(1, Math.max(0, value))
  return 1 - Math.pow(1 - clamped, 3)
}

function MemoryIntroSubtitle({
  charTimings,
  currentTime,
  lineStarts,
  lines,
}: {
  charTimings: MemoryCharacterTiming[]
  currentTime: number
  lineStarts: number[]
  lines: MemoryTypewriterTextPart[][]
}) {
  return (
    <article className="flex min-h-32 w-full max-w-7xl flex-col justify-center gap-5 px-4 text-[15px] leading-8 text-black/86 drop-shadow-[0_2px_12px_rgba(255,255,255,0.55)] dark:text-white/88 dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)]">
      {lines.map((parts, lineIndex) => (
        <p className="m-0 text-center text-xl font-semibold leading-9 sm:text-2xl sm:leading-10" key={`memory-line-${lineIndex}`}>
          <MemoryTypewriterText
            charTimings={charTimings}
            currentTime={currentTime}
            parts={parts}
            startIndex={lineStarts[lineIndex] || 0}
          />
        </p>
      ))}
    </article>
  )
}

function MemoryTypewriterText({
  charTimings,
  currentTime,
  parts,
  startIndex,
}: {
  charTimings: MemoryCharacterTiming[]
  currentTime: number
  parts: MemoryTypewriterTextPart[]
  startIndex: number
}) {
  const lineStart = charTimings[startIndex]?.start ?? 0
  if (currentTime < lineStart) return null

  let cursor = 0

  return (
    <>
      {parts.map((part, partIndex) => {
        const text = getMemoryTextFromPart(part)
        const className = typeof part === 'string' ? undefined : part.className
        const chars = splitMemoryText(text)
        const content = chars.map((char, charIndex) => {
          const index = startIndex + cursor + charIndex
          const timing = charTimings[index]
          const charStart = timing?.start ?? Number.POSITIVE_INFINITY
          const charEnd = timing?.end ?? charStart + 0.12
          const raw = (currentTime - charStart) / Math.max(charEnd - charStart, 0.001)
          const eased = easeMemorySubtitle(raw)
          const style = {
            opacity: eased,
            transform: `translate3d(0, ${(1 - eased) * 0.38}em, 0)`,
            filter: `blur(${(1 - eased) * 1.2}px)`,
            transition: 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1), filter 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            willChange: eased < 1 ? 'opacity, transform, filter' : undefined
          } satisfies CSSProperties

          return (
            <span className={`memory-intro-shimmer-char inline-block whitespace-pre-wrap ${className || ''}`} key={`${index}-${char}`} style={style}>
              {char}
            </span>
          )
        })

        cursor += chars.length

        return (
          <Fragment key={partIndex}>{content}</Fragment>
        )
      })}
    </>
  )
}

export function AgentMemoryIntro({ onMemoryCreated }: { onMemoryCreated: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const audioProgressFrameRef = useRef<number | null>(null)
  const decodedDurationRef = useRef(0)
  const lastStateProgressRef = useRef(-1)
  const [step, setStep] = useState(0)
  const question = MEMORY_INTRO_QUESTIONS[Math.min(step, MEMORY_INTRO_QUESTIONS.length - 1)]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [finalizingLineIndex, setFinalizingLineIndex] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [cues, setCues] = useState<MemorySubtitleCue[]>(() => parseMemorySrt(MEMORY_INTRO_FALLBACK_SRTS.name))
  const [audioPreferenceLoaded, setAudioPreferenceLoaded] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(false)
  const currentAnswer = answers[question.key] || ''
  const lines = useMemo<MemoryTypewriterTextPart[][]>(() => cues.map((cue) => [cue.text]), [cues])
  const lineStarts = useMemo(() => {
    return lines.reduce<number[]>((starts, parts, index) => {
      if (index === 0) {
        starts.push(0)
        return starts
      }
      const previousLineLength = lines[index - 1].reduce(
        (sum, part) => sum + splitMemoryText(getMemoryTextFromPart(part)).length,
        0
      )
      starts.push(starts[index - 1] + previousLineLength)
      return starts
    }, [])
  }, [lines])
  const charTimings = useMemo(() => buildMemoryCharacterTimings(lines, cues), [cues, lines])

  useEffect(() => {
    let cancelled = false
    void configService.getNarrationAudioEnabledPreference()
      .then((value) => {
        if (cancelled) return
        setAudioEnabled(value === true)
      })
      .catch(() => {
        if (!cancelled) setAudioEnabled(false)
      })
      .finally(() => {
        if (!cancelled) setAudioPreferenceLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const commitAudioPreference = useCallback((enabled: boolean) => {
    setAudioEnabled(enabled)
    void configService.setNarrationAudioEnabled(enabled).catch(() => {
      // 声音偏好保存失败不影响本次引导。
    })

    const audio = audioRef.current
    if (!audio) return
    audio.muted = !enabled
    if (enabled && audio.paused) {
      void audio.play().catch(() => {
        // Electron/浏览器策略可能拦截自动播放；保留开关状态。
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setCues(parseMemorySrt(MEMORY_INTRO_FALLBACK_SRTS[question.key]))
    void fetch(publicJiyiAsset(question.subtitleFile))
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        if (cancelled || !text) return
        const parsed = parseMemorySrt(text)
        if (parsed.length > 0) setCues(parsed)
      })
      .catch(() => {
        // 字幕读取失败时使用内置兜底。
      })
    return () => {
      cancelled = true
    }
  }, [question.key, question.subtitleFile])

  useEffect(() => {
    if (!audioPreferenceLoaded) return

    const audio = audioRef.current
    if (!audio) return

    const syncAudioProgress = () => {
      const duration = decodedDurationRef.current || audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        const nextProgress = Math.min(100, (audio.currentTime / duration) * 100)

        if (progressFillRef.current) {
          progressFillRef.current.style.transform = `translate3d(0, 0, 0) scaleX(${nextProgress / 100})`
        }

        if (
          Math.abs(nextProgress - lastStateProgressRef.current) >= 0.12
          || nextProgress === 100
        ) {
          lastStateProgressRef.current = nextProgress
          setCurrentTime(audio.currentTime)
        }
      }
      audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)
    }

    decodedDurationRef.current = 0
    void fetch(publicJiyiAsset(question.audioFile))
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioContextCtor) return
        const context = new AudioContextCtor()
        return context.decodeAudioData(buffer).then((decoded) => {
          decodedDurationRef.current = decoded.duration
          void context.close()
        }).catch(() => {
          void context.close()
        })
      })
      .catch(() => {
        // 音频时长解析失败时回退到 HTMLAudioElement.duration。
      })

    audio.currentTime = 0
    audio.muted = !audioEnabled
    setCurrentTime(0)
    lastStateProgressRef.current = -1
    if (progressFillRef.current) {
      progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
    }
    audio.load()
    void audio.play().catch(() => {
      // Electron/浏览器策略可能拦截自动播放；用户输入时仍可继续流程。
    })
    audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)

    return () => {
      if (audioProgressFrameRef.current !== null) {
        window.cancelAnimationFrame(audioProgressFrameRef.current)
        audioProgressFrameRef.current = null
      }
      audio.pause()
      audio.currentTime = 0
      setCurrentTime(0)
      if (progressFillRef.current) {
        progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
      }
    }
  }, [audioPreferenceLoaded, question.audioFile])

  useEffect(() => {
    if (!audioPreferenceLoaded) return
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audioEnabled
    if (audioEnabled && audio.paused) {
      void audio.play().catch(() => {
        // Electron/浏览器策略可能拦截自动播放；保留开关状态。
      })
    }
  }, [audioEnabled, audioPreferenceLoaded])

  useEffect(() => {
    setError('')
  }, [step])

  useEffect(() => {
    if (!finalizing) return
    audioRef.current?.pause()
    const timer = window.setInterval(() => {
      setFinalizingLineIndex((index) => (index + 1) % MEMORY_FINALIZING_LINES.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [finalizing])

  const submitCurrentAnswer = useCallback(async () => {
    const trimmed = currentAnswer.trim()
    if (!trimmed) {
      setError(question.placeholder)
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.create({
        memoryUid: question.memoryUid,
        sourceType: 'profile',
        title: question.title,
        content: question.buildContent(trimmed),
        importance: 0.95,
        confidence: 1,
        tags: question.tags,
      })
      if (!res.success) throw new Error(res.error || '保存记忆失败')
      if (step >= MEMORY_INTRO_QUESTIONS.length - 1) {
        setFinalizing(true)
        const startedAt = Date.now()
        const consolidate = window.electronAPI.memory.consolidate()
        const minimumVisible = new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 3200 - (Date.now() - startedAt))))
        const [consolidateRes] = await Promise.all([consolidate, minimumVisible])
        if (!consolidateRes.success) throw new Error(consolidateRes.error || '整理记忆失败')
        onMemoryCreated()
      } else {
        setStep((value) => value + 1)
      }
    } catch (err) {
      setFinalizing(false)
      setError(err instanceof Error ? err.message : '保存记忆失败')
    } finally {
      setSaving(false)
    }
  }, [currentAnswer, onMemoryCreated, question, step])

  return (
    <div className="absolute inset-0 z-30 overflow-hidden bg-background">
      <style>
        {`
          .memory-intro-shimmer-char {
            --memory-shimmer-base: rgba(0, 0, 0, 0.86);
            --memory-shimmer-glint: rgba(255, 255, 255, 0.96);
            background-image: linear-gradient(105deg, var(--memory-shimmer-base) 0%, var(--memory-shimmer-base) 34%, var(--memory-shimmer-glint) 48%, var(--memory-shimmer-base) 62%, var(--memory-shimmer-base) 100%);
            background-position: 120% 0;
            background-size: 230% 100%;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            -webkit-text-fill-color: transparent;
            animation: memoryIntroShimmer 3.6s linear infinite;
          }

          .dark .memory-intro-shimmer-char,
          [data-theme="dark"] .memory-intro-shimmer-char {
            --memory-shimmer-base: rgba(255, 255, 255, 0.88);
            --memory-shimmer-glint: rgba(165, 243, 252, 0.98);
          }

          @keyframes memoryIntroShimmer {
            0% { background-position: 120% 0; }
            100% { background-position: -120% 0; }
          }
        `}
      </style>
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(20,184,166,0.22),rgba(244,63,94,0.12)_48%,rgba(15,23,42,0.18))]" />
      <div className="absolute inset-[-18%] bg-[linear-gradient(115deg,rgba(255,255,255,0.34),rgba(148,163,184,0.14)_42%,rgba(20,184,166,0.2))] blur-3xl dark:opacity-60" />
      <div className="absolute inset-0 bg-background/40 backdrop-blur-2xl" />
      <audio
        aria-hidden="true"
        preload="auto"
        ref={audioRef}
        src={publicJiyiAsset(question.audioFile)}
        onEnded={() => {
          lastStateProgressRef.current = 100
          const duration = decodedDurationRef.current || audioRef.current?.duration || 0
          setCurrentTime(duration)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
          }
        }}
      />

      <div className="absolute right-5 top-5 z-20">
        <Switch
          aria-label="记忆引导声音"
          isDisabled={!audioPreferenceLoaded}
          isSelected={audioEnabled}
          onChange={commitAudioPreference}
          size="sm"
        >
          <Switch.Content className="gap-2 rounded-(--agent-radius,12px) border border-border bg-surface/80 px-2 py-1 text-foreground shadow-xs backdrop-blur hover:bg-surface">
            <Switch.Control>
              <Switch.Thumb>
                <Switch.Icon>
                  {audioEnabled ? (
                    <Volume className="size-3" />
                  ) : (
                    <VolumeXmark className="size-3 opacity-70" />
                  )}
                </Switch.Icon>
              </Switch.Thumb>
            </Switch.Control>
            <span className="whitespace-nowrap text-xs leading-none text-muted-foreground">
              {audioEnabled ? '声音开' : '静音'}
            </span>
          </Switch.Content>
        </Switch>
      </div>

      <div className="relative z-10 flex size-full items-center justify-center px-6 py-10">
        <div className="grid w-full max-w-340 overflow-hidden">
          {finalizing ? (
            <section
              aria-label="正在整理记忆"
              className="col-start-1 row-start-1 flex min-h-105 flex-col items-center justify-center gap-8 px-4 text-center transition-all duration-500 ease-out"
            >
              <p className="m-0 max-w-260 text-balance text-2xl font-semibold leading-10 text-black/86 drop-shadow-[0_2px_12px_rgba(255,255,255,0.55)] transition-all duration-500 dark:text-white/88 dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] sm:text-3xl sm:leading-12">
                <span className="memory-intro-shimmer-char inline-block" key={finalizingLineIndex}>
                  {MEMORY_FINALIZING_LINES[finalizingLineIndex]}
                </span>
              </p>
              <div className="h-px w-full max-w-160 overflow-hidden bg-white/12">
                <div className="h-full origin-left animate-pulse bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80" />
              </div>
            </section>
          ) : (
            <section
              aria-label="首次记忆询问"
              className="col-start-1 row-start-1 flex min-h-105 flex-col items-center justify-center gap-8 transition-all duration-500 ease-out"
              key={question.key}
            >
              <MemoryIntroSubtitle charTimings={charTimings} currentTime={currentTime} lineStarts={lineStarts} lines={lines} />
              <div className="flex w-full max-w-160 flex-col">
                <TextField
                  aria-label={question.placeholder}
                  fullWidth
                  isDisabled={saving}
                  isInvalid={Boolean(error)}
                  name={`memory-intro-${question.key}`}
                  value={currentAnswer}
                  onChange={(value) => {
                    setAnswers((prev) => ({ ...prev, [question.key]: value }))
                    if (error) setError('')
                  }}
                >
                  <Input
                    autoFocus
                    className="focus-visible:border-border! focus-visible:ring-0! data-[focus-visible=true]:border-border! data-[focus-visible=true]:ring-0!"
                    placeholder={error || question.placeholder}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void submitCurrentAnswer()
                      }
                    }}
                  />
                </TextField>
                <HeroButton
                  aria-hidden={!currentAnswer.trim()}
                  className={`transition-all duration-300 ease-out ${
                    currentAnswer.trim()
                      ? 'pointer-events-auto mt-3 max-h-12 translate-y-0 opacity-100 blur-0'
                      : 'pointer-events-none mt-0 max-h-0 -translate-y-2 overflow-hidden opacity-0 blur-sm'
                  }`}
                  fullWidth
                  isDisabled={!currentAnswer.trim()}
                  isPending={saving}
                  onPress={() => { void submitCurrentAnswer() }}
                  size="lg"
                  variant="primary"
                >
                  <Check className="size-4" />
                  {step >= MEMORY_INTRO_QUESTIONS.length - 1 ? '完成' : '继续'}
                </HeroButton>
                <div
                  aria-label="记忆引导播放进度"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(Math.min(100, Math.max(0, lastStateProgressRef.current)))}
                  className="mt-3 h-px w-full overflow-hidden bg-white/12"
                  role="progressbar"
                >
                  <div
                    ref={progressFillRef}
                    className="h-full origin-left bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80 will-change-transform"
                    style={{ transform: 'translate3d(0, 0, 0) scaleX(0)' }}
                  />
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
