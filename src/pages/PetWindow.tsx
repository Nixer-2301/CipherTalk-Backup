import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleDashed, PaperPlane, Xmark } from '@gravity-ui/icons'
import { useCurrentPetLoader } from '@/features/pets/PetContext'
import { PetSprite } from '@/features/pets/PetSprite'
import { PET_STATES, petStateForAgent, type PetAgentState, type PetStateId } from '@/features/pets/petStates'
import { DEFAULT_FLAIR_POOL, useIdleFlair } from '@/features/pets/useIdleFlair'
import { speakText } from '@/lib/ttsPlayer'

type NotifyPayload = {
  username: string
  displayName: string
  avatarUrl?: string
  preview: string
  timestamp: number
}

/** 气泡队列项：消息提醒沿用旧样式，提醒/摘要等走通用文本气泡 */
type BubbleItem =
  | { kind: 'notify'; notify: NotifyPayload }
  | { kind: 'text'; title: string; text: string; speak?: boolean; durationMs?: number }

type ChatUiMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: Array<{ type: 'text'; text: string }>
}

type BubbleFrame = {
  expanded: boolean
  baseLeft: number
  baseTop: number
  baseWidth: number
  baseHeight: number
}

const NOTIFY_DURATION_MS = 5000
const TEXT_DURATION_MS = 9000
const NOTICE_QUEUE_MAX = 5
const CHAT_HISTORY_MAX = 10
const SHORT_CLICK_MAX_MS = 220
const SHORT_CLICK_MAX_DISTANCE = 4
const NOTIFY_ACTION: PetStateId = 'waving'
const DEFAULT_BUBBLE_FRAME: BubbleFrame = {
  expanded: false,
  baseLeft: 0,
  baseTop: 0,
  baseWidth: 150,
  baseHeight: 170,
}

type PointerDownInfo = {
  pointerId: number
  // 屏幕坐标：拖拽期间窗口在动，client 坐标会漂移，位移必须按 screen 坐标算
  screenX: number
  screenY: number
  at: number
  dragging: boolean
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `pet-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/** 消息提醒气泡：头像 + 昵称 + 预览，点击把主窗口带到前台。 */
function PetNotice({ notice, onClose }: { notice: NotifyPayload; onClose: () => void }) {
  const [avatarError, setAvatarError] = useState(false)
  const showAvatar = notice.avatarUrl && !avatarError

  return (
    <div
      className="pet-notice mb-1 flex max-w-70 cursor-pointer items-center gap-2 rounded-2xl px-2.5 py-1.5 text-left"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={() => window.electronAPI.notify.activate()}
      role="button"
    >
      {showAvatar ? (
        <img
          src={notice.avatarUrl}
          alt=""
          className="size-7 shrink-0 rounded-full object-cover"
          onError={() => setAvatarError(true)}
        />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px] font-medium text-white">
          {(notice.displayName || '?').slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-white/95">{notice.displayName}</div>
        <div className="truncate text-[10px] text-white/70">{notice.preview}</div>
      </div>
      <button
        aria-label="关闭提醒"
        className="shrink-0 rounded-full p-0.5 text-white/60 hover:text-white/90"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        type="button"
      >
        <Xmark className="size-3" />
      </button>
    </div>
  )
}

/** 通用文本气泡：定时提醒 / 纪念日 / 每日摘要。 */
function PetTextBubble({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <div
      className="pet-notice mb-1 flex max-w-70 cursor-pointer items-start gap-2 rounded-2xl px-2.5 py-1.5 text-left"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={() => window.electronAPI.notify.activate()}
      role="button"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-white/95">{title}</div>
        <div className="line-clamp-4 text-[10px] leading-relaxed text-white/80">{text}</div>
      </div>
      <button
        aria-label="关闭提醒"
        className="shrink-0 rounded-full p-0.5 text-white/60 hover:text-white/90"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        type="button"
      >
        <Xmark className="size-3" />
      </button>
    </div>
  )
}

/**
 * 桌面悬浮桌宠窗口（透明无边框，跟随 Agent 运行状态切动画）。
 * 整个窗口是拖拽区域，悬停时右上角出现关闭按钮；拖动时按方向播跑/跳动画。
 * 气泡区按优先级显示：迷你对话面板 > 提醒/摘要/消息气泡 > Agent 运行进度行。
 * 点击桌宠打开迷你对话框：绑定了数字分身走 persona:chat，否则走 AI 助手 agent:run。
 */
export default function PetWindow() {
  const pet = useCurrentPetLoader()
  const [agentState, setAgentState] = useState<PetAgentState>('idle')
  const [dragState, setDragState] = useState<PetStateId | null>(null)
  const [clickState, setClickState] = useState<PetStateId | null>(null)
  const [notifyState, setNotifyState] = useState<PetStateId | null>(null)
  const [bubble, setBubble] = useState<BubbleItem | null>(null)
  const [bubbleFrame, setBubbleFrame] = useState<BubbleFrame>(DEFAULT_BUBBLE_FRAME)
  const [isPointerInside, setIsPointerInside] = useState(false)
  const [hoverFlair, setHoverFlair] = useState<PetStateId | null>(null)
  const [progress, setProgress] = useState<{ title: string; detail?: string } | null>(null)

  // 迷你对话
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatReply, setChatReply] = useState('')
  const [chatError, setChatError] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [personaBinding, setPersonaBinding] = useState<{ sessionId: string; name: string } | null>(null)

  const queueRef = useRef<BubbleItem[]>([])
  const showingRef = useRef(false)
  const dismissTimerRef = useRef(0)
  const hoverFlairTimerRef = useRef(0)
  const clickActionTimerRef = useRef(0)
  const notifyActionTimerRef = useRef(0)
  const progressTimerRef = useRef(0)
  const pointerDownRef = useRef<PointerDownInfo | null>(null)
  const ttsEnabledRef = useRef(false)
  const speakSeqRef = useRef(0)
  const chatMessagesRef = useRef<ChatUiMessage[]>([])
  const personaRef = useRef(personaBinding)
  personaRef.current = personaBinding
  const chatBusyRef = useRef(false)
  chatBusyRef.current = chatBusy

  const clearHoverState = useCallback(() => {
    setIsPointerInside(false)
    setHoverFlair(null)
    pointerDownRef.current = null
    window.clearTimeout(hoverFlairTimerRef.current)
  }, [])

  const triggerHoverFlair = useCallback(() => {
    if (agentState !== 'idle' || dragState !== null) return
    const next = DEFAULT_FLAIR_POOL[Math.floor(Math.random() * DEFAULT_FLAIR_POOL.length)]
    setHoverFlair(next)
    window.clearTimeout(hoverFlairTimerRef.current)
    hoverFlairTimerRef.current = window.setTimeout(() => {
      setHoverFlair(null)
    }, PET_STATES[next].durationMs * 2)
  }, [agentState, dragState])

  const triggerClickJump = useCallback(() => {
    if (dragState !== null) return
    setHoverFlair(null)
    setClickState('jumping')
    window.clearTimeout(clickActionTimerRef.current)
    clickActionTimerRef.current = window.setTimeout(() => {
      setClickState(null)
    }, PET_STATES.jumping.durationMs * 2)
  }, [dragState])

  const triggerNotifyAction = useCallback(() => {
    setNotifyState(NOTIFY_ACTION)
    window.clearTimeout(notifyActionTimerRef.current)
    notifyActionTimerRef.current = window.setTimeout(() => {
      setNotifyState(null)
    }, PET_STATES[NOTIFY_ACTION].durationMs * 2)
  }, [])

  // 手动拖拽 + 点击判定：app-region: drag 会吞掉左键 DOM 事件（点击永远不触发），
  // 改为宠物区域 no-drag，按下后位移超过阈值走 IPC 移窗，否则按点击处理
  const handlePetPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    pointerDownRef.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      at: performance.now(),
      dragging: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    window.electronAPI.pet.dragStart()
  }, [])

  const handlePetPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const down = pointerDownRef.current
    if (!down || down.pointerId !== event.pointerId) return
    const dx = event.screenX - down.screenX
    const dy = event.screenY - down.screenY
    if (!down.dragging && Math.hypot(dx, dy) <= SHORT_CLICK_MAX_DISTANCE) return
    down.dragging = true
    window.electronAPI.pet.dragMove(dx, dy)
  }, [])

  const handlePetPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const down = pointerDownRef.current
    pointerDownRef.current = null
    if (!down || down.pointerId !== event.pointerId) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch { /* 已释放 */ }
    // 松手必须通知主进程：解除气泡扩窗冻结并应用拖拽期间积压的状态
    window.electronAPI.pet.dragEnd()
    if (!down.dragging && performance.now() - down.at <= SHORT_CLICK_MAX_MS) {
      triggerClickJump()
      setChatOpen((open) => !open)
    }
  }, [triggerClickJump])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  // 气泡队列：一次只显示一条，自动消失后接着弹下一条
  const showNext = useCallback(() => {
    const next = queueRef.current.shift()
    if (!next) {
      showingRef.current = false
      setBubble(null)
      return
    }
    showingRef.current = true
    setBubble(next)
    const duration = next.kind === 'text' ? (next.durationMs ?? TEXT_DURATION_MS) : NOTIFY_DURATION_MS
    if (next.kind === 'text' && next.speak && ttsEnabledRef.current) {
      speakSeqRef.current += 1
      void speakText(`pet-bubble-${speakSeqRef.current}`, `${next.title}：${next.text}`)
    }
    window.clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = window.setTimeout(() => showNext(), duration)
  }, [])

  const dismissBubble = useCallback(() => {
    window.clearTimeout(dismissTimerRef.current)
    showNext()
  }, [showNext])

  const enqueueBubble = useCallback((item: BubbleItem) => {
    const queue = queueRef.current
    // 合并同一个人的多条消息提醒，避免刷屏
    if (item.kind === 'notify') {
      const idx = queue.findIndex((q) => q.kind === 'notify' && q.notify.username === item.notify.username)
      if (idx >= 0) {
        queue[idx] = item
      } else {
        queue.push(item)
      }
    } else {
      queue.push(item)
    }
    if (queue.length > NOTICE_QUEUE_MAX) queue.shift()
    if (!showingRef.current) showNext()
  }, [showNext])

  useEffect(() => {
    const off = window.electronAPI.pet.onNotify((payload) => {
      triggerNotifyAction()
      enqueueBubble({ kind: 'notify', notify: payload })
    })
    return () => {
      off()
      window.clearTimeout(dismissTimerRef.current)
      window.clearTimeout(hoverFlairTimerRef.current)
      window.clearTimeout(clickActionTimerRef.current)
      window.clearTimeout(notifyActionTimerRef.current)
      window.clearTimeout(progressTimerRef.current)
      window.electronAPI.pet.setBubble(false)
    }
  }, [enqueueBubble, triggerNotifyAction])

  // 定时提醒/纪念日：主进程 petReminderService 推送
  useEffect(() => {
    const off = window.electronAPI.pet.onBubble((payload) => {
      triggerNotifyAction()
      enqueueBubble({ kind: 'text', title: payload.title, text: payload.text, speak: true, durationMs: 10000 })
    })
    return off
  }, [enqueueBubble, triggerNotifyAction])

  // 每日摘要：开窗 8s 后请求一次，之后每 10 分钟重试（库没连上时主进程不记日期）；
  // 当天已展示过由主进程 petDailySummaryDate 防重，这里无脑轮询即可。
  useEffect(() => {
    let stopped = false
    const request = async () => {
      try {
        const res = await window.electronAPI.pet.getDailySummary()
        if (!stopped && res?.success && res.text) {
          enqueueBubble({ kind: 'text', title: '每日摘要', text: res.text, speak: true, durationMs: 12000 })
        }
      } catch { /* 下一轮再试 */ }
    }
    const initial = window.setTimeout(() => void request(), 8000)
    const interval = window.setInterval(() => void request(), 10 * 60 * 1000)
    return () => {
      stopped = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [enqueueBubble])

  // Agent 运行进度行：主窗口 AI 助手运行时的工具/阶段进度
  useEffect(() => {
    const off = window.electronAPI.pet.onAgentProgress((p) => {
      window.clearTimeout(progressTimerRef.current)
      setProgress({ title: p.title, detail: p.detail })
      // 运行结束/出错短暂停留后隐藏；运行中常显（思考/长工具/流式生成期间没有新事件，
      // 不能按几秒收掉），只留长看门狗兜底——结束事件丢失时不至于永久挂着。
      const hideDelay = p.stage === 'run_finished' || p.stage === 'error' ? 1500 : 120_000
      progressTimerRef.current = window.setTimeout(() => setProgress(null), hideDelay)
    })
    return off
  }, [])

  // 朗读开关 + 数字分身绑定（config 驱动，设置页改动实时生效）
  const loadPersona = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      setPersonaBinding(null)
      return
    }
    try {
      const res = await window.electronAPI.persona.get(sessionId)
      const persona = (res as { persona?: { displayName?: string } | null })?.persona
      setPersonaBinding({ sessionId, name: persona?.displayName || sessionId })
    } catch {
      setPersonaBinding({ sessionId, name: sessionId })
    }
  }, [])

  useEffect(() => {
    void window.electronAPI.config.get('petTtsEnabled').then((v) => { ttsEnabledRef.current = Boolean(v) })
    void window.electronAPI.config.get('petPersonaSessionId').then((v) => { void loadPersona(String(v || '')) })
    const off = window.electronAPI.config.onChanged(({ key, value }) => {
      if (key === 'petTtsEnabled') ttsEnabledRef.current = Boolean(value)
      if (key === 'petPersonaSessionId') void loadPersona(String(value || ''))
    })
    return off
  }, [loadPersona])

  // 迷你对话：绑定分身走 persona:chat（带分身腔调），否则走 AI 助手 agent:run
  const sendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatBusyRef.current) return
    setChatInput('')
    setChatError('')
    setChatReply('')
    setChatBusy(true)
    window.electronAPI.pet.setAgentState('running')

    const runId = randomRunId()
    const userMessage: ChatUiMessage = { id: `${runId}-u`, role: 'user', parts: [{ type: 'text', text }] }
    const messages = [...chatMessagesRef.current.slice(-(CHAT_HISTORY_MAX - 1)), userMessage]
    chatMessagesRef.current = messages

    const persona = personaRef.current
    const bridge = persona ? window.electronAPI.persona : window.electronAPI.agent
    let reply = ''
    const off = bridge.onChunk(runId, (chunk) => {
      const part = chunk as { type?: string; delta?: string; errorText?: string } | string
      if (!part || typeof part === 'string') return
      if (part.type === 'text-delta' && typeof part.delta === 'string') {
        reply += part.delta
        setChatReply(reply)
      } else if (part.type === 'error' && part.errorText) {
        setChatError(String(part.errorText))
      }
    })
    let failed = false
    try {
      const res = persona
        ? await window.electronAPI.persona.chat(runId, persona.sessionId, messages)
        : await window.electronAPI.agent.run(runId, messages)
      if (!res.success) {
        failed = true
        setChatError(res.error || '请求失败')
      }
    } catch (e) {
      failed = true
      setChatError(e instanceof Error ? e.message : String(e))
    } finally {
      off()
      setChatBusy(false)
      window.electronAPI.pet.setAgentState(failed && !reply ? 'failed' : 'done')
      window.setTimeout(() => window.electronAPI.pet.setAgentState('idle'), 2600)
      if (reply) {
        chatMessagesRef.current = [
          ...chatMessagesRef.current,
          { id: `${runId}-a`, role: 'assistant', parts: [{ type: 'text', text: reply }] },
        ]
        if (ttsEnabledRef.current) void speakText(`pet-chat-${runId}`, reply)
      }
    }
  }, [chatInput])

  useEffect(() => {
    const off = window.electronAPI.pet.onBubbleFrame((frame) => {
      setBubbleFrame(frame.expanded ? frame : DEFAULT_BUBBLE_FRAME)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.electronAPI.pet.onContextMenuOpened(clearHoverState)
    return off
  }, [clearHoverState])

  useEffect(() => {
    let doneTimer = 0
    const off = window.electronAPI.pet.onAgentState((state) => {
      window.clearTimeout(doneTimer)
      if (state === 'done') {
        window.clearTimeout(progressTimerRef.current)
        setProgress(null)
        setAgentState('done')
        doneTimer = window.setTimeout(() => setAgentState('idle'), 2600)
        return
      }
      if (state === 'idle' || state === 'failed') {
        window.clearTimeout(progressTimerRef.current)
        setProgress(null)
      }
      if (state === 'running' || state === 'failed' || state === 'idle') {
        setAgentState(state)
      }
    })
    return () => {
      window.clearTimeout(doneTimer)
      off()
    }
  }, [])

  // 拖动动作：一拖就锁定跑姿（默认原地跑），只在有明确水平位移时切左/右跑方向，
  // 期间绝不切别的动作避免闪烁；停止移动 800ms 后才复原。
  useEffect(() => {
    let lastX: number | null = null
    let settleTimer = 0
    const off = window.electronAPI.pet.onWindowMove((x) => {
      window.clearTimeout(settleTimer)
      setDragState((current) => {
        let next: PetStateId = current ?? 'running'
        if (lastX !== null) {
          const dx = x - lastX
          if (dx > 2) next = 'running-right'
          else if (dx < -2) next = 'running-left'
          // |dx| ≤ 2：保持当前跑姿不变
        }
        return next
      })
      lastX = x
      settleTimer = window.setTimeout(() => {
        setDragState(null)
        lastX = null
      }, 800)
    })
    return () => {
      window.clearTimeout(settleTimer)
      off()
    }
  }, [])

  // 气泡区有内容（对话面板/气泡/进度行）时请求主进程扩窗，全空后还原
  const layerVisible = chatOpen || bubble !== null || progress !== null

  useEffect(() => {
    window.electronAPI.pet.setBubble(layerVisible)
  }, [layerVisible])

  // 空闲彩蛋（Codex 同款）：待机且没在拖动/悬停时，不定时来一段随机小动作
  const flair = useIdleFlair(agentState === 'idle' && dragState === null && !isPointerInside)

  const state: PetStateId = dragState
    ?? clickState
    ?? notifyState
    ?? (agentState === 'idle' && hoverFlair ? hoverFlair : agentState === 'idle' && flair ? flair : petStateForAgent(agentState))

  const petStageStyle: React.CSSProperties = {
    WebkitAppRegion: 'no-drag',
    background: 'transparent',
    height: bubbleFrame.baseHeight,
    position: 'absolute',
    width: bubbleFrame.baseWidth,
  } as React.CSSProperties

  if (bubbleFrame.expanded) {
    petStageStyle.left = bubbleFrame.baseLeft
    petStageStyle.top = bubbleFrame.baseTop
  } else {
    petStageStyle.right = 0
    petStageStyle.bottom = 0
  }

  const noticeLayerStyle: React.CSSProperties = {
    WebkitAppRegion: 'no-drag',
    maxWidth: '17.5rem',
    position: 'absolute',
  } as React.CSSProperties

  if (bubbleFrame.baseTop > 0) {
    noticeLayerStyle.bottom = `calc(100% - ${bubbleFrame.baseTop}px + 4px)`
  } else {
    noticeLayerStyle.top = bubbleFrame.baseTop + bubbleFrame.baseHeight + 4
  }

  if (bubbleFrame.baseLeft > 0) {
    noticeLayerStyle.right = `calc(100% - ${bubbleFrame.baseLeft + bubbleFrame.baseWidth}px)`
  } else {
    noticeLayerStyle.left = bubbleFrame.baseLeft
  }

  return (
    <div
      className="relative h-screen w-screen overflow-hidden"
      onContextMenu={(event) => {
        event.preventDefault()
        clearHoverState()
        window.electronAPI.pet.showContextMenu()
      }}
      onPointerEnter={() => {
        setIsPointerInside(true)
        triggerHoverFlair()
      }}
      onPointerLeave={clearHoverState}
      style={{ WebkitAppRegion: 'drag', background: 'transparent' } as React.CSSProperties}
    >
      {layerVisible && (
        <div style={noticeLayerStyle}>
          {chatOpen ? (
            <div
              className="pet-notice mb-1 flex w-70 flex-col gap-1.5 rounded-2xl px-2.5 py-2 text-left"
              style={{ WebkitAppRegion: 'no-drag', cursor: 'default' } as React.CSSProperties}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-[11px] font-medium text-white/95">
                  {personaBinding ? personaBinding.name : 'AI 助手'}
                </span>
                <button
                  aria-label="关闭对话"
                  className="shrink-0 rounded-full p-0.5 text-white/60 hover:text-white/90"
                  onClick={() => setChatOpen(false)}
                  type="button"
                >
                  <Xmark className="size-3" />
                </button>
              </div>
              {(chatBusy || chatReply || chatError) && (
                <div className="max-h-22 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-white/90">
                  {chatError
                    ? <span className="text-red-300">{chatError}</span>
                    : chatReply || '正在思考…'}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  className="h-7 min-w-0 flex-1 rounded-full border border-white/20 bg-white/10 px-2.5 text-[11px] text-white outline-none placeholder:text-white/40 focus:border-white/40"
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendChat()
                  }}
                  placeholder={personaBinding ? `和 ${personaBinding.name} 说点什么…` : '问问 AI 助手…'}
                  value={chatInput}
                />
                <button
                  aria-label="发送"
                  className="shrink-0 rounded-full p-1 text-white/70 hover:text-white disabled:opacity-40"
                  disabled={chatBusy || !chatInput.trim()}
                  onClick={() => void sendChat()}
                  type="button"
                >
                  {chatBusy ? <CircleDashed className="size-3.5 animate-spin" /> : <PaperPlane className="size-3.5" />}
                </button>
              </div>
            </div>
          ) : bubble ? (
            bubble.kind === 'notify'
              ? <PetNotice notice={bubble.notify} onClose={dismissBubble} />
              : <PetTextBubble onClose={dismissBubble} text={bubble.text} title={bubble.title} />
          ) : progress ? (
            <div
              className="pet-notice mb-1 flex max-w-70 items-center gap-1.5 rounded-2xl px-2.5 py-1.5"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <CircleDashed className="size-3 shrink-0 animate-spin text-white/70" />
              <span className="truncate text-[10px] text-white/85">
                {progress.title}
                {progress.detail ? `：${progress.detail}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      )}
      <div
        className="flex flex-col items-center justify-end overflow-hidden pb-1"
        onPointerCancel={() => {
          pointerDownRef.current = null
          window.electronAPI.pet.dragEnd()
        }}
        onPointerDown={handlePetPointerDown}
        onPointerMove={handlePetPointerMove}
        onPointerUp={handlePetPointerUp}
        style={petStageStyle}
      >
        <button
          aria-label="收起桌宠"
          className={`absolute top-1 right-1 rounded-full bg-black/30 p-1 text-white/80 transition-opacity hover:bg-black/50 ${isPointerInside ? 'opacity-100' : 'opacity-0'}`}
          onClick={() => void window.electronAPI.pet.toggleDesktopWindow(false)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          type="button"
        >
          <Xmark className="size-3.5" />
        </button>
        {pet ? (
          <>
            <PetSprite label={pet.displayName} scale={0.62} src={pet.spriteUrl} state={state} />
            <span className={`mt-0.5 rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white/90 transition-opacity ${isPointerInside ? 'opacity-100' : 'opacity-0'}`}>
              {personaBinding ? personaBinding.name : pet.displayName}
            </span>
          </>
        ) : (
          <span className="rounded-(--agent-radius,12px) bg-black/40 px-3 py-2 text-center text-white/90 text-xs">
            还没选宠物
            <br />
            去「AI 宠物」页挑一只吧
          </span>
        )}
      </div>
    </div>
  )
}
