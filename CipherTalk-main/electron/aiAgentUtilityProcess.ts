/**
 * AI Agent Utility Process —— 在 Electron 隔离子进程中跑 ToolLoopAgent。
 * 主进程通过 postMessage({ id, type, payload }) 下发请求，本进程回复 { id, result } / { id, error }，
 * UI 消息块以 { id: -1, type: 'chunk', payload: { runId, chunk } } 上行。
 *
 * 约定：id === 0 && type === 'ready' 为启动就绪信号。
 * 隔离收益：AI 崩溃（如 sqlite-vec 原生 fatal）只终止本子进程，主进程会重启，不拖垮 UI。
 */
import { generateConversationTitle, generateReplySuggestions, optimizeAgentPrompt, runAgent } from './services/agent/engine'
import { runPersonaChat } from './services/agent/persona/personaChatEngine'
import { extractPersona } from './services/agent/persona/personaLlm'
import {
  extractProfileChunk,
  mergeProfileParts,
  reflectConversation,
  revisePersona,
} from './services/agent/persona/personaProfileLlm'
import type { PersonaChatInput } from './services/agent/persona/personaTypes'
import type { AgentRunInput } from './services/agent/types'
import { formatAgentError } from './services/agent/errorFormat'
import { initAiTelemetry } from './services/ai/telemetry'

initAiTelemetry('ciphertalk-ai-utility')

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('aiAgentUtilityProcess 必须在 Electron utilityProcess 中运行')
}

const aborters = new Map<string, AbortController>()
const keepAliveTimer = setInterval(() => undefined, 60_000)

parentPort.on('message', (event: Electron.MessageEvent) => {
  void handleMessage(event.data)
})

process.once('exit', () => {
  clearInterval(keepAliveTimer)
})

async function handleMessage(msg: any): Promise<void> {
  const { id, type, payload } = msg || {}
  // 代理结果由对应 proxyClient 自己的监听处理，这里直接忽略，避免回 unknown type 噪声。
  if (
    type === 'wcdb:result' ||
    type === 'mcp:result' ||
    type === 'codeWorkspace:result' ||
    type === 'agentCapability:result' ||
    type === 'aiExport:result' ||
    type === 'aiExport:progress'
  ) return
  try {
    switch (type) {
      case 'ping':
        parentPort!.postMessage({ id, result: 'pong' })
        break

      case 'run': {
        const { runId, ...input } = payload as { runId: string } & AgentRunInput
        const aborter = new AbortController()
        aborters.set(runId, aborter)
        try {
          await runAgent(
            input,
            (chunk) => parentPort!.postMessage({ id: -1, type: 'chunk', payload: { runId, chunk } }),
            aborter.signal,
            (progress) => parentPort!.postMessage({ id: -2, type: 'progress', payload: { runId, progress } }),
          )
          parentPort!.postMessage({ id, result: { done: true } })
        } finally {
          aborters.delete(runId)
        }
        break
      }

      case 'abort':
        aborters.get(payload?.runId)?.abort()
        parentPort!.postMessage({ id, result: { aborted: true } })
        break

      case 'generateTitle': {
        const aborter = new AbortController()
        try {
          const title = await generateConversationTitle(payload, aborter.signal)
          parentPort!.postMessage({ id, result: { title } })
        } finally {
          aborter.abort()
        }
        break
      }

      case 'optimizePrompt': {
        const aborter = new AbortController()
        try {
          const text = await optimizeAgentPrompt(payload, aborter.signal)
          parentPort!.postMessage({ id, result: { text } })
        } finally {
          aborter.abort()
        }
        break
      }

      case 'replySuggest': {
        const aborter = new AbortController()
        try {
          const result = await generateReplySuggestions(payload, aborter.signal)
          parentPort!.postMessage({ id, result })
        } finally {
          aborter.abort()
        }
        break
      }

      case 'extractPersona': {
        const result = await extractPersona(payload)
        parentPort!.postMessage({ id, result })
        break
      }

      case 'extractProfileChunk': {
        const result = await extractProfileChunk(payload)
        parentPort!.postMessage({ id, result })
        break
      }

      case 'mergeProfile': {
        const result = await mergeProfileParts(payload)
        parentPort!.postMessage({ id, result })
        break
      }

      case 'revisePersona': {
        const result = await revisePersona(payload)
        parentPort!.postMessage({ id, result })
        break
      }

      case 'reflectPersona': {
        const result = await reflectConversation(payload)
        parentPort!.postMessage({ id, result })
        break
      }

      case 'personaChat': {
        const { runId, ...input } = payload as { runId: string } & PersonaChatInput
        const aborter = new AbortController()
        aborters.set(runId, aborter)
        try {
          await runPersonaChat(
            input,
            (chunk) => parentPort!.postMessage({ id: -1, type: 'chunk', payload: { runId, chunk } }),
            aborter.signal,
            (progress) => parentPort!.postMessage({ id: -2, type: 'progress', payload: { runId, progress } }),
          )
          parentPort!.postMessage({ id, result: { done: true } })
        } finally {
          aborters.delete(runId)
        }
        break
      }

      default:
        parentPort!.postMessage({ id, error: `unknown type: ${type}` })
    }
  } catch (e: any) {
    parentPort!.postMessage({ id, error: formatAgentError(e) })
  }
}

parentPort.postMessage({ id: 0, type: 'ready' })
