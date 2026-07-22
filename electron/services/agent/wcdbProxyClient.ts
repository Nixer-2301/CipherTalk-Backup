/**
 * wcdb 代理客户端 —— 运行在 AI agent 子进程内。
 *
 * 子进程不直连原微信库（那库由主进程的 wcdb utilityProcess 持有）。当子进程里的数据层
 * 走到 wcdbService.callWithAutoOpen 时，会被短路到这里，把 (method, payload) 经 parentPort
 * 转发给主进程，主进程用已打开的 wcdbService 执行后回传结果。见 wcdbService.ts 的 CT_AGENT_WCDB_PROXY
 * 分支与 agentProcessService.ts 的 'wcdb:call' 处理。
 *
 * 协议：
 *   子→主  { type: 'wcdb:call',   payload: { reqId, method, payload } }
 *   主→子  { type: 'wcdb:result', payload: { reqId, result } | { reqId, error } }
 */
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
    if (!msg || msg.type !== 'wcdb:result') return
    const { reqId, result, error } = msg.payload || {}
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    if (error) entry.reject(new Error(error))
    else entry.resolve(result)
  })
}

/** 把一次 wcdb 调用转发给主进程，等待结果。method/payload 与 wcdbService.callWithAutoOpen 一致。 */
export function proxyWcdbCall<T = any>(method: string, payload: any): Promise<T> {
  if (!parentPort) {
    return Promise.reject(new Error('wcdbProxyClient 只能在 utilityProcess 子进程中运行'))
  }
  ensureListener()
  const reqId = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try {
      parentPort!.postMessage({ type: 'wcdb:call', payload: { reqId, method, payload } })
    } catch (e: any) {
      pending.delete(reqId)
      reject(new Error(`wcdb 代理转发失败: ${e?.message || String(e)}`))
    }
  })
}
