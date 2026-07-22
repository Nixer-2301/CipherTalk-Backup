/**
 * MCP 代理客户端 —— 运行在 AI agent utilityProcess 内。
 * 已连接的 MCP client 保存在主进程，所以子进程通过 postMessage 请求主进程代为调用。
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
    if (!msg || msg.type !== 'mcp:result') return
    const { reqId, result, error } = msg.payload || {}
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    if (error) entry.reject(new Error(error))
    else entry.resolve(result)
  })
}

export function proxyMcpCallTool<T = any>(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!parentPort) {
    return Promise.reject(new Error('mcpProxyClient 只能在 utilityProcess 子进程中运行'))
  }
  ensureListener()
  const reqId = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try {
      parentPort!.postMessage({ type: 'mcp:callTool', payload: { reqId, serverName, toolName, args } })
    } catch (e: any) {
      pending.delete(reqId)
      reject(new Error(`MCP 代理转发失败: ${e?.message || String(e)}`))
    }
  })
}
