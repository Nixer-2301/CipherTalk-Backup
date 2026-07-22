import { Button, Modal } from '@heroui/react'
import { LogoTelegram, Volume, VolumeXmark, Xmark } from '@gravity-ui/icons'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as configService from '../services/config'
import { LottieView } from '@/components/LottieView'
import visionOrbUrl from '@/assets/lottie/Anumation.lottie?url'

interface WhatsNewModalProps {
  onClose: () => void
  version: string
}


const publicAsset = (fileName: string): string => `${import.meta.env.BASE_URL}${fileName}`

const VISION_AUDIO_SRC = publicAsset('音频.mp3')
const VISION_SUBTITLE_SRC = publicAsset('音频字幕.srt')
const VISION_MODAL_EXIT_MS = 240
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3)

type SubtitleCue = {
  end: number
  start: number
  text: string
}

type CharacterTiming = {
  end: number
  start: number
}

type TypewriterTextPart = string | {
  className?: string
  text: string
}

type TypewriterTextProps = {
  currentTime: number
  charTimings: CharacterTiming[]
  parts: TypewriterTextPart[]
  startIndex: number
}

function getTextFromPart(part: TypewriterTextPart) {
  return typeof part === 'string' ? part : part.text
}

function splitText(text: string) {
  return Array.from(text)
}

function parseSrtTimestamp(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return 0

  const [, hours, minutes, seconds, milliseconds] = match
  return Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000
}

function parseSrt(value: string): SubtitleCue[] {
  return value
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const timeLine = lines.find((line) => line.includes('-->'))
      if (!timeLine) return null

      const [startValue, endValue] = timeLine.split('-->').map((item) => item.trim())
      const text = lines
        .slice(lines.indexOf(timeLine) + 1)
        .join('')
        .trim()
      if (!text) return null

      return {
        end: parseSrtTimestamp(endValue),
        start: parseSrtTimestamp(startValue),
        text
      }
    })
    .filter((cue): cue is SubtitleCue => Boolean(cue))
}

function isSkippableSubtitleChar(char: string) {
  return /\s/.test(char)
}

function flattenParts(parts: TypewriterTextPart[]) {
  return parts.map(getTextFromPart).join('')
}

function buildCharacterTimings(lines: TypewriterTextPart[][], cues: SubtitleCue[]) {
  const fullText = lines.map(flattenParts).join('')
  const displayChars = splitText(fullText)
  const displaySearchChars = displayChars
    .map((char, index) => ({ char, index }))
    .filter((item) => !isSkippableSubtitleChar(item.char))
  const displaySearchText = displaySearchChars.map((item) => item.char).join('')
  const timings: Array<CharacterTiming | undefined> = Array(displayChars.length)
  let searchFrom = 0

  cues.forEach((cue) => {
    const cueChars = splitText(cue.text).filter((char) => !isSkippableSubtitleChar(char))
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
    if (timing || !isSkippableSubtitleChar(displayChars[index])) return

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

  return timings as CharacterTiming[]
}

const FALLBACK_SUBTITLE_CUES = parseSrt(`1
00:00:00,000 --> 00:00:01,943
有些话没有消失，

2
00:00:02,088 --> 00:00:03,857
只是睡在时间的深处。

3
00:00:03,996 --> 00:00:05,173
等你需要时，

4
00:00:05,328 --> 00:00:07,353
它们应该还能被找到，

5
00:00:07,524 --> 00:00:08,991
带着当时的温度，

6
00:00:09,144 --> 00:00:10,704
和足够清楚的来路。

7
00:00:10,872 --> 00:00:12,990
CipherTalk 继续往前，

8
00:00:13,140 --> 00:00:14,654
为记忆留灯，

9
00:00:14,796 --> 00:00:16,008
也为真相留门。
`)

function TypewriterText({ parts, currentTime, charTimings, startIndex }: TypewriterTextProps) {
  const lineStart = charTimings[startIndex]?.start ?? 0
  if (currentTime < lineStart) return null

  let cursor = 0

  return (
    <>
      {parts.map((part, partIndex) => {
        const text = getTextFromPart(part)
        const className = typeof part === 'string' ? undefined : part.className
        const chars = splitText(text)
        const content = chars.map((char, charIndex) => {
          const index = startIndex + cursor + charIndex
          const timing = charTimings[index]
          const charStart = timing?.start ?? Number.POSITIVE_INFINITY
          const charEnd = timing?.end ?? charStart + 0.12
          const raw = clamp((currentTime - charStart) / Math.max(charEnd - charStart, 0.001))
          const eased = easeOutCubic(raw)
          const style = {
            opacity: eased,
            transform: `translate3d(0, ${(1 - eased) * 0.38}em, 0)`,
            filter: `blur(${(1 - eased) * 1.2}px)`,
            transition: 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1), filter 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            willChange: eased < 1 ? 'opacity, transform, filter' : undefined
          } satisfies CSSProperties

          return (
            <span className={`inline-block whitespace-pre-wrap ${className || ''}`} key={`${index}-${char}`} style={style}>
              {char}
            </span>
          )
        })

        cursor += chars.length

        return <Fragment key={partIndex}>{content}</Fragment>
      })}
    </>
  )
}

const VISION_LINES: TypewriterTextPart[][] = [
  [
    '有些话没有消失，',
    {
      className: 'bg-linear-to-r from-white via-cyan-100 to-fuchsia-200 bg-clip-text text-transparent',
      text: '只是睡在时间的深处。'
    }
  ],
  ['等你需要时，它们应该还能被找到，'],
  ['带着当时的温度，和足够清楚的来路。'],
  ['CipherTalk 继续往前，'],
  ['为记忆留灯，'],
  ['也为真相留门。']
]
const VISION_LINE_STARTS = VISION_LINES.reduce<number[]>((starts, parts, index) => {
  if (index === 0) {
    starts.push(0)
    return starts
  }

  const previousLineLength = VISION_LINES[index - 1].reduce(
    (sum, part) => sum + splitText(getTextFromPart(part)).length,
    0
  )
  starts.push(starts[index - 1] + previousLineLength)
  return starts
}, [])

function WhatsNewModal({ onClose }: WhatsNewModalProps) {
  const visionAudioRef = useRef<HTMLAudioElement | null>(null)
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const audioProgressFrameRef = useRef<number | null>(null)
  const closeHandledRef = useRef(false)
  const decodedDurationRef = useRef(0)
  const lastStateProgressRef = useRef(-1)
  const closeTimeoutRef = useRef<number | null>(null)
  const [isVisionOpen, setIsVisionOpen] = useState(true)
  // 关闭按钮始终显示：不再因「首次看更新」把 X 藏到音频播完（用户反馈那样体验很差）
  const [isCloseVisible, setIsCloseVisible] = useState(true)
  const [audioProgress, setAudioProgress] = useState(0)
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>(FALLBACK_SUBTITLE_CUES)
  const [audioPreferenceLoaded, setAudioPreferenceLoaded] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState<boolean | null>(null)
  const canRunVision = audioPreferenceLoaded && audioEnabled !== null
  const isAudioOn = audioEnabled === true

  const charTimings = useMemo(
    () => buildCharacterTimings(VISION_LINES, subtitleCues),
    [subtitleCues]
  )

  useEffect(() => {
    let cancelled = false
    void configService.getNarrationAudioEnabledPreference()
      .then((value) => {
        if (cancelled) return
        setAudioEnabled(value)
      })
      .catch((error) => {
        console.warn('读取开发者愿景声音偏好失败:', error)
        if (!cancelled) setAudioEnabled(null)
      })
      .finally(() => {
        if (!cancelled) setAudioPreferenceLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const requestClose = useCallback(() => {
    if (closeHandledRef.current) return
    closeHandledRef.current = true
    setIsVisionOpen(false)
  }, [])

  const commitAudioPreference = useCallback((enabled: boolean) => {
    setAudioEnabled(enabled)
    void configService.setNarrationAudioEnabled(enabled).catch((error) => {
      console.warn('保存开发者愿景声音偏好失败:', error)
    })

    const audio = visionAudioRef.current
    if (!audio) return
    audio.muted = !enabled
    if (enabled && audio.paused) {
      void audio.play().catch((error) => {
        console.warn('开发者愿景音频播放失败:', error)
        setIsCloseVisible(true)
      })
    }
  }, [])

  useEffect(() => {
    if (isVisionOpen) return

    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null
      onClose()
    }, VISION_MODAL_EXIT_MS)

    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current)
        closeTimeoutRef.current = null
      }
    }
  }, [isVisionOpen, onClose])

  useEffect(() => {
    const getTitleBarSymbolColor = () => {
      const mode = document.documentElement.dataset.mode
      return mode === 'dark' ? '#ffffff' : '#1a1a1a'
    }

    window.electronAPI?.window?.setTitleBarOverlay?.({
      hidden: true,
      symbolColor: getTitleBarSymbolColor()
    })

    return () => {
      window.electronAPI?.window?.setTitleBarOverlay?.({
        hidden: false,
        symbolColor: getTitleBarSymbolColor()
      })
    }
  }, [])

  useEffect(() => {
    if (!canRunVision) return

    const audio = visionAudioRef.current
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
          setAudioProgress(nextProgress)
          setAudioCurrentTime(audio.currentTime)
        }
      }
      audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)
    }

    void fetch(VISION_SUBTITLE_SRC)
      .then((res) => res.text())
      .then((value) => {
        const nextCues = parseSrt(value)
        if (nextCues.length > 0) {
          setSubtitleCues(nextCues)
        }
      })
      .catch((error) => {
        console.warn('开发者愿景字幕加载失败:', error)
      })

    void fetch(VISION_AUDIO_SRC)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const context = new AudioContext()
        return context.decodeAudioData(buffer).then((decoded) => {
          decodedDurationRef.current = decoded.duration
          void context.close()
        }).catch((error) => {
          void context.close()
          console.warn('开发者愿景音频时长解析失败:', error)
        })
      })
      .catch((error) => {
        console.warn('开发者愿景音频加载解析失败:', error)
      })

    audio.currentTime = 0
    audio.muted = !isAudioOn
    setAudioCurrentTime(0)
    if (progressFillRef.current) {
      progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
    }
    void audio.play().catch((error) => {
      console.warn('开发者愿景音频自动播放失败:', error)
      setIsCloseVisible(true)
    })
    audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)

    return () => {
      if (audioProgressFrameRef.current !== null) {
        window.cancelAnimationFrame(audioProgressFrameRef.current)
      }
      audio.pause()
      audio.currentTime = 0
      setAudioCurrentTime(0)
      if (progressFillRef.current) {
        progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
      }
    }
  }, [canRunVision])

  useEffect(() => {
    if (audioEnabled === null) return
    const audio = visionAudioRef.current
    if (!audio) return
    audio.muted = !audioEnabled
    if (audioEnabled && canRunVision && audio.paused) {
      void audio.play().catch((error) => {
        console.warn('开发者愿景音频播放失败:', error)
        setIsCloseVisible(true)
      })
    }
  }, [audioEnabled, canRunVision])

  const handleTelegram = () => {
    window.electronAPI?.shell?.openExternal?.('https://t.me/+p7YzmRMBm-gzNzJl')
  }

  const showActions = audioProgress >= 78
  const actionsProgress = easeOutCubic(clamp((audioProgress - 78) / 12))
  const actionsStyle = {
    opacity: actionsProgress,
    transform: `translate3d(0, ${(1 - actionsProgress) * 10}px, 0)`,
    transition: 'opacity 260ms cubic-bezier(0.16, 1, 0.3, 1), transform 260ms cubic-bezier(0.16, 1, 0.3, 1)'
  } satisfies CSSProperties

  const visionAudioElement = (
    <audio
      ref={visionAudioRef}
      src={VISION_AUDIO_SRC}
      preload="auto"
      aria-hidden="true"
      onLoadedMetadata={() => {
        lastStateProgressRef.current = -1
        setAudioCurrentTime(0)
        setAudioProgress(0)
        if (progressFillRef.current) {
          progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
        }
      }}
      onEnded={() => {
        lastStateProgressRef.current = 100
        setAudioProgress(100)
        setIsCloseVisible(true)
        setAudioCurrentTime(decodedDurationRef.current || visionAudioRef.current?.duration || 0)
        if (progressFillRef.current) {
          progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
        }
      }}
      onError={() => {
        setIsCloseVisible(true)
      }}
    />
  )

  const visionArticle = (
    <article className="relative mx-auto flex max-w-160 flex-col gap-5 text-[16px] leading-8 text-white/88 drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] sm:text-[17px] sm:leading-9">
      <p className="m-0 text-2xl font-semibold leading-10 text-white sm:text-3xl sm:leading-12">
        <TypewriterText
          charTimings={charTimings}
          currentTime={audioCurrentTime}
          parts={VISION_LINES[0]}
          startIndex={VISION_LINE_STARTS[0]}
        />
      </p>

      <div className="flex flex-col gap-3 text-white/82">
        {[1, 2].map((lineIndex) => (
          <p className="m-0" key={lineIndex}>
            <TypewriterText
              charTimings={charTimings}
              currentTime={audioCurrentTime}
              parts={VISION_LINES[lineIndex]}
              startIndex={VISION_LINE_STARTS[lineIndex]}
            />
          </p>
        ))}
      </div>

      <div className="mt-2 flex flex-col gap-2 border-l border-white/35 py-1 pl-4 text-white">
        {[3, 4, 5].map((lineIndex) => (
          <p className={lineIndex >= 4 ? 'm-0 font-semibold' : 'm-0'} key={lineIndex}>
            <TypewriterText
              charTimings={charTimings}
              currentTime={audioCurrentTime}
              parts={VISION_LINES[lineIndex]}
              startIndex={VISION_LINE_STARTS[lineIndex]}
            />
          </p>
        ))}
      </div>

      <div className="h-px w-full overflow-hidden bg-white/12" aria-hidden="true">
        <div
          ref={progressFillRef}
          className="h-full origin-left bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80 will-change-transform"
          style={{ transform: 'translate3d(0, 0, 0) scaleX(0)' }}
        />
      </div>

      <div
        className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between"
        style={actionsStyle}
      >
        {showActions && (
          <>
            <p className="m-0 text-sm leading-6 text-white/72">想看项目动向和后续演进，进频道。</p>
            <div className="flex shrink-0 gap-2">
              <Button
                className="justify-center border-white/28 bg-white/12 text-white hover:bg-white/20"
                onPress={handleTelegram}
                variant="outline"
              >
                <LogoTelegram className="size-4" />
                Telegram 频道
              </Button>
            </div>
          </>
        )}
      </div>
    </article>
  )
  if (canRunVision) {
    return (
      <div
        aria-label="开发者手记"
        aria-modal="true"
      className={`fixed inset-0 overflow-hidden bg-black/55 text-white backdrop-blur-xl transition-opacity duration-240 ${isVisionOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        role="dialog"
        style={{ zIndex: 2000 }}
      >
        {visionAudioElement}
        <div className="fixed right-5 top-5 z-10 flex items-center gap-2 sm:right-8 sm:top-8">
          <button
            aria-label={isAudioOn ? '关闭开发者愿景声音' : '开启开发者愿景声音'}
            aria-pressed={isAudioOn}
            className="inline-flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/10 p-0 text-white shadow-lg outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60"
            onClick={() => commitAudioPreference(!isAudioOn)}
            type="button"
          >
            {isAudioOn ? (
              <Volume className="size-4.5" />
            ) : (
              <VolumeXmark className="size-4.5" />
            )}
          </button>
          <button
            aria-hidden={!isCloseVisible}
            aria-label="关闭开发者愿景"
            className={`inline-flex size-11 items-center justify-center rounded-full border border-white/10 bg-white/10 p-0 text-white shadow-lg outline-none backdrop-blur transition-[opacity,transform,background-color] duration-700 ease-out hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 ${isCloseVisible ? 'scale-100 cursor-pointer opacity-100' : 'pointer-events-none scale-95 cursor-default opacity-0'}`}
            disabled={!isCloseVisible}
            onClick={requestClose}
            tabIndex={isCloseVisible ? 0 : -1}
            type="button"
          >
            <Xmark className="size-4.5" />
          </button>
        </div>
        <div className="flex size-full items-center overflow-y-auto px-5 py-0 sm:px-10">
          <div className="mx-auto flex min-h-dvh w-full max-w-225 items-center">
            {visionArticle}
          </div>
        </div>
        {/* 讲述中的光球：固定在屏幕顶部中间；界面隐藏时不渲染，避免后台空转 WASM 渲染循环 */}
        {isVisionOpen && (
          <div className="pointer-events-none fixed inset-x-0 top-4 z-10 flex justify-center">
            <LottieView autoplay loop className="size-24" src={visionOrbUrl} />
          </div>
        )}
      </div>
    )
  }

  return (
    <Modal.Backdrop
      className="bg-black/55 backdrop-blur-xl"
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={isVisionOpen}
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
      variant="blur"
    >
      <audio
        ref={visionAudioRef}
        src={VISION_AUDIO_SRC}
        preload="auto"
        aria-hidden="true"
        onLoadedMetadata={() => {
          lastStateProgressRef.current = -1
          setAudioCurrentTime(0)
          setAudioProgress(0)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
          }
        }}
        onEnded={() => {
          lastStateProgressRef.current = 100
          setAudioProgress(100)
          setIsCloseVisible(true)
          setAudioCurrentTime(decodedDurationRef.current || visionAudioRef.current?.duration || 0)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
          }
        }}
        onError={() => {
          setIsCloseVisible(true)
        }}
      />
      {!canRunVision && (
        <Modal.Container className="px-5" placement="center" scroll="inside" size="md">
          <Modal.Dialog
            aria-label={audioPreferenceLoaded ? '开发者愿景声音提示' : '开发者愿景声音设置加载中'}
            className="border border-white/16 bg-zinc-950/78 text-white shadow-2xl backdrop-blur-xl"
          >
            <Modal.Header>
              <Modal.Icon className="bg-white/12 text-white">
                <Volume className="size-5" />
              </Modal.Icon>
              <Modal.Heading>{audioPreferenceLoaded ? '这段内容有声音' : '正在读取声音设置'}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="m-0 text-sm leading-6 text-white/72">
                {audioPreferenceLoaded
                  ? '请选择默认是否开启。之后在画面右上角也可以随时切换。'
                  : '稍等一下。'}
              </p>
            </Modal.Body>
            {audioPreferenceLoaded && (
              <Modal.Footer className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  className="justify-center border-white/20 bg-white/10 text-white hover:bg-white/20"
                  onPress={() => commitAudioPreference(false)}
                  variant="outline"
                >
                  <VolumeXmark className="size-4" />
                  静音观看
                </Button>
                <Button
                  className="justify-center bg-white text-zinc-950 hover:bg-white/90"
                  onPress={() => commitAudioPreference(true)}
                  variant="primary"
                >
                  <Volume className="size-4" />
                  开启声音
                </Button>
              </Modal.Footer>
            )}
          </Modal.Dialog>
        </Modal.Container>
      )}
    </Modal.Backdrop>
  )
}

export default WhatsNewModal
