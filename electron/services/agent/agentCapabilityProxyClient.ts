/**
 * Agent capability proxy client.
 *
 * Runs inside the AI utility process. Heavy/local-machine capabilities are
 * executed by the main process so they share one safety/audit boundary.
 */
const parentPort = process.parentPort

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
}

const pending = new Map<number, Pending>()
let seq = 0
let listenerInstalled = false

function ensureListener(): void {
  if (listenerInstalled || !parentPort) return
  listenerInstalled = true
  parentPort.on('message', (event: Electron.MessageEvent) => {
    const msg: any = event.data
    if (!msg || msg.type !== 'agentCapability:result') return
    const { reqId, result, error } = msg.payload || {}
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    if (error) entry.reject(new Error(error))
    else entry.resolve(result)
  })
}

export function proxyAgentCapabilityCall<T = any>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!parentPort) {
    return Promise.reject(new Error('agentCapabilityProxyClient can only run inside utilityProcess'))
  }
  ensureListener()
  const reqId = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try {
      parentPort!.postMessage({ type: 'agentCapability:call', payload: { reqId, method, args } })
    } catch (e: any) {
      pending.delete(reqId)
      reject(new Error(`Agent capability proxy failed: ${e?.message || String(e)}`))
    }
  })
}
