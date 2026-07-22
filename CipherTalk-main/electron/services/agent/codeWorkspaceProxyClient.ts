/**
 * CodeWorkspace 代理客户端 —— 运行在 AI agent utilityProcess 内。
 *
 * AI 子进程不直接读写文件或执行命令；所有 code_* 工具调用经 parentPort 转发给主进程
 * CodeWorkspaceService，主进程统一做 workspace 边界校验、敏感文件拦截、审批、命令执行和 dev server 管理。
 */
import type { CodeWorkspaceRef } from './codeWorkspaceTypes'

const parentPort = process.parentPort

type Pending = { resolve: (value: any) => void; reject: (reason: any) => void }

const pending = new Map<number, Pending>()
let seq = 0
let listenerInstalled = false

function ensureListener(): void {
  if (listenerInstalled || !parentPort) return
  listenerInstalled = true
  parentPort.on('message', (event: Electron.MessageEvent) => {
    const msg: any = event.data
    if (!msg || msg.type !== 'codeWorkspace:result') return
    const { reqId, result, error } = msg.payload || {}
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    if (error) entry.reject(new Error(error))
    else entry.resolve(result)
  })
}

export function proxyCodeWorkspaceCall<T = any>(
  method: string,
  args: Record<string, unknown>,
  workspace?: CodeWorkspaceRef | null,
): Promise<T> {
  if (!parentPort) {
    return Promise.reject(new Error('codeWorkspaceProxyClient 只能在 utilityProcess 子进程中运行'))
  }
  ensureListener()
  const reqId = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try {
      parentPort!.postMessage({ type: 'codeWorkspace:call', payload: { reqId, method, args, workspace } })
    } catch (e: any) {
      pending.delete(reqId)
      reject(new Error(`代码工作区代理转发失败: ${e?.message || String(e)}`))
    }
  })
}
