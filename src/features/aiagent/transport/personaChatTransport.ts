/**
 * PersonaChatTransport —— 克隆好友聊天的 useChat 传输层。
 * 与 IpcChatTransport 同构，但走 electronAPI.persona（persona:chat → 子进程完整生成后按气泡回推）。
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { AgentProgressEvent, AgentReasoningEffort } from './ipcChatTransport'

interface PersonaBridge {
  chat: (runId: string, sessionId: string, messages: unknown[], reasoningEffort?: AgentReasoningEffort) => Promise<{ success: boolean; error?: string }>
  abort: (runId: string) => Promise<{ success: boolean }>
  onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
  onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
}

function getPersonaBridge(): PersonaBridge {
  const bridge = (window as any)?.electronAPI?.persona as PersonaBridge | undefined
  if (!bridge) throw new Error('electronAPI.persona 未就绪（preload 未加载？）')
  return bridge
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `persona-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export class PersonaChatTransport<UI_MESSAGE extends UIMessage = UIMessage> implements ChatTransport<UI_MESSAGE> {
  constructor(
    private readonly getSessionId: () => string,
    private readonly getReasoningEffort?: () => AgentReasoningEffort,
    private readonly onProgress?: (progress: AgentProgressEvent) => void,
  ) {}

  async sendMessages(options: {
    messages: UI_MESSAGE[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    const bridge = getPersonaBridge()
    const runId = randomRunId()
    const sessionId = this.getSessionId()
    const messages = options.messages as unknown[]
    const reasoningEffort = this.getReasoningEffort?.()
    const progressHandler = this.onProgress

    options.abortSignal?.addEventListener('abort', () => { void bridge.abort(runId) })

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const off = bridge.onChunk(runId, (chunk) => {
          if (chunk === '[DONE]') {
            controller.close()
            off()
            return
          }
          controller.enqueue(chunk as UIMessageChunk)
        })
        const offProgress = bridge.onProgress(runId, (progress) => {
          if (progress && typeof progress === 'object') {
            progressHandler?.(progress as AgentProgressEvent)
          }
        })
        void bridge.chat(runId, sessionId, messages, reasoningEffort).catch((error: unknown) => {
          try {
            controller.enqueue({ type: 'error', errorText: error instanceof Error ? error.message : String(error) } as UIMessageChunk)
            controller.close()
          } catch { /* 已关闭 */ }
          off()
          offProgress()
        }).finally(() => {
          offProgress()
        })
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // 本地进程，无断线重连场景
    return null
  }
}
