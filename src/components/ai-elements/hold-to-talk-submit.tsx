/**
 * 长按语音发送按钮：短按 = 正常提交（走表单 onSubmit），长按 ≥300ms = 按住说话，
 * 松开后经设置里的语音转文字(stt.transcribeBuffer)转写，结果交给 onTranscript。
 * Agent 页和克隆聊天页共用，保证两处交互一致。
 */
import { useEffect, useRef, useState } from 'react'
import { CircleDashed, Microphone } from '@gravity-ui/icons'
import { cn } from '@/lib/utils'
import { startVoiceRecording, type ActiveRecorder } from '@/lib/voiceRecorder'
import { PromptInputSubmit, type PromptInputSubmitProps } from './prompt-input'

const HOLD_MS = 300

export type HoldToTalkSubmitProps = PromptInputSubmitProps & {
  /** 转写成功回调（文本非空） */
  onTranscript: (text: string) => void
  /** 转写/录音出错回调 */
  onVoiceError?: (message: string) => void
  /** true 时长按不可用（如正在生成中，短按仍是停止/提交） */
  holdDisabled?: boolean
  /** true 时空闲态显示麦克风，并启用长按录音；false 时显示普通提交按钮 */
  voiceInputEnabled?: boolean
}

export function HoldToTalkSubmit({
  onTranscript,
  onVoiceError,
  holdDisabled,
  voiceInputEnabled = true,
  className,
  children,
  ...props
}: HoldToTalkSubmitProps) {
  const [mode, setMode] = useState<'idle' | 'pressing' | 'recording' | 'transcribing'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recorderPromiseRef = useRef<Promise<ActiveRecorder> | null>(null)
  const activePressRef = useRef(false)
  const mountedRef = useRef(true)
  // 长按发生过：抑制松开后浏览器补发的 click，避免又触发一次表单提交
  const suppressClickRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimer()
      activePressRef.current = false
      const recorderPromise = recorderPromiseRef.current
      recorderPromiseRef.current = null
      if (recorderPromise) {
        void recorderPromise.then((recorder) => recorder.cancel()).catch(() => undefined)
      }
    }
  }, [])

  const disabled = Boolean(props.isDisabled ?? props.disabled)
  const voiceActionEnabled = voiceInputEnabled && !holdDisabled && !disabled
  const canBeginHold = voiceActionEnabled && mode === 'idle'

  const beginHold = (pointerType: string) => {
    if (!canBeginHold || pointerType === 'keyboard' || pointerType === 'virtual') return
    clearTimer()
    activePressRef.current = true
    setMode('pressing')
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!activePressRef.current) return
      suppressClickRef.current = true
      setMode('recording')
      const recorderPromise = startVoiceRecording()
      recorderPromiseRef.current = recorderPromise
      // Attach a rejection handler immediately; endHold reports the actual error.
      void recorderPromise.catch(() => undefined)
    }, HOLD_MS)
  }

  const transcribeRecording = async (recorder: ActiveRecorder) => {
    const { wavBase64, durationSec } = await recorder.stop()
    if (durationSec < 0.4) {
      onVoiceError?.('录音时间太短，请按住麦克风说话后再松开')
      return
    }
    const res = await window.electronAPI.stt.transcribeBuffer(wavBase64)
    const text = res.success ? String(res.transcript || '').trim() : ''
    if (!text) {
      onVoiceError?.(res.error || '没听清，请再说一次')
      return
    }
    onTranscript(text)
  }

  const endHold = (send: boolean) => {
    if (!activePressRef.current) return
    activePressRef.current = false
    clearTimer()
    const recorderPromise = recorderPromiseRef.current
    recorderPromiseRef.current = null
    if (!recorderPromise) {
      if (mountedRef.current) setMode('idle')
      return
    }
    setMode(send ? 'transcribing' : 'idle')
    void (async () => {
      try {
        const recorder = await recorderPromise
        if (send) await transcribeRecording(recorder)
        else recorder.cancel()
      } catch (e) {
        if (send) onVoiceError?.(`无法使用麦克风：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (mountedRef.current) setMode('idle')
      }
    })()
  }

  const ariaLabel = mode === 'recording'
    ? '松开发送语音'
    : mode === 'transcribing'
      ? '正在识别语音'
      : mode === 'pressing'
        ? '继续按住开始录音'
        : canBeginHold
          ? '长按录音'
          : props['aria-label'] || (props.status === 'submitted' || props.status === 'streaming' ? '停止生成' : '发送')

  return (
    <span
      className={cn('inline-flex', voiceActionEnabled && 'touch-none select-none')}
      onContextMenu={(event) => {
        if (activePressRef.current || mode === 'recording') event.preventDefault()
      }}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      title={voiceActionEnabled ? '长按说话，松开发送' : undefined}
    >
      <PromptInputSubmit
        {...props}
        aria-label={ariaLabel}
        className={cn(
          className,
          'transition-[transform,background-color,color,box-shadow] duration-150',
          mode === 'pressing' && 'scale-95 bg-danger-soft text-danger shadow-sm',
          mode === 'recording' && 'scale-95 bg-danger text-white shadow-md',
        )}
        isDisabled={disabled || mode === 'transcribing'}
        onPressStart={(event) => {
          props.onPressStart?.(event)
          beginHold(event.pointerType)
        }}
        onPressEnd={(event) => {
          props.onPressEnd?.(event)
          endHold(true)
        }}
      >
        {mode === 'recording'
          ? <Microphone className="size-4 animate-pulse" />
          : mode === 'transcribing'
            ? <CircleDashed className="size-4 animate-spin" />
            : mode === 'pressing'
              ? <Microphone className="size-4 scale-110" />
              : canBeginHold
                ? <Microphone className="size-4" />
                : children}
      </PromptInputSubmit>
    </span>
  )
}
