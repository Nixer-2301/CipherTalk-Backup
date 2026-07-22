/**
 * WCDB Utility Process —— 在 Electron 隔离子进程中运行 WcdbCore。
 * 主进程通过 postMessage({ id, type, payload }) 下发请求；
 * 本进程按 type 路由到 WcdbCore 对应方法，并回复 { id, result } 或 { id, error }。
 *
 * 约定：
 * - id === 0 && type === 'ready' 为启动就绪信号
 * - id === -1 && type === 'monitor' 为 native pipe 的变更上行事件
 */
import { WcdbCore } from './services/wcdbCore'

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('wcdbUtilityProcess 必须在 Electron utilityProcess 中运行')
}

const core = new WcdbCore()
let monitorRegistered = false
const keepAliveTimer = setInterval(() => undefined, 60_000)
keepAliveTimer.ref?.()
try {
  process.stdin?.resume?.()
} catch {
  // stdin may be unavailable in some utilityProcess modes; the timer still keeps the process alive.
}

// 串行化所有请求：每个请求（含游标 open→fetch→close 全过程）跑完后下一个才开始。
// 防止 close/open/shutdown 在某个游标批次的 await 间隙插入，导致 native 句柄被释放后
// 仍被在飞的 fetch 使用（use-after-free → koffi napi_throw → utility process fatal）。
let queue: Promise<void> = Promise.resolve()

parentPort.on('message', (event: Electron.MessageEvent) => {
  const msg = event.data
  queue = queue.then(() => handleMessage(msg)).catch(() => undefined)
})

async function handleMessage(msg: any) {
  const { id, type, payload } = msg || {}
  let shouldExitAfterReply = false
  try {
    let result: any
    switch (type) {
      case 'setPaths':
        core.setPaths(payload.resourcesPath, payload.userDataPath)
        result = { success: true }
        break
      case 'testConnection':
        result = await core.testConnection(payload.dbPath, payload.hexKey, payload.wxid)
        break
      case 'open':
        result = await core.open(payload.dbPath, payload.hexKey, payload.wxid)
        break
      case 'close':
        core.close()
        result = { success: true }
        break
      case 'shutdown':
        core.shutdown()
        result = { success: true }
        shouldExitAfterReply = true
        break
      case 'isConnected':
        result = core.isConnected()
        break
      case 'execQuery':
        result = await core.execQuery(payload.kind, payload.path, payload.sql)
        break
      case 'execQueryWithParams':
        result = await core.execQueryWithParams(payload.kind, payload.path, payload.sql, payload.params)
        break
      case 'readMessageChunk':
        result = await core.readMessageChunk(payload.kind, payload.path, payload.tableName, payload.opts)
        break
      case 'getSnsTimeline':
        result = await core.getSnsTimeline(
          payload.limit,
          payload.offset,
          payload.usernames,
          payload.keyword,
          payload.startTime,
          payload.endTime
        )
        break
      case 'getNativeMessages':
        result = await core.getNativeMessages(payload.sessionId, payload.limit, payload.offset)
        break
      case 'setMonitor':
        if (!monitorRegistered) {
          monitorRegistered = core.setMonitor((t, j) => {
            parentPort.postMessage({ id: -1, type: 'monitor', payload: { type: t, json: j } })
          })
        }
        result = { success: monitorRegistered }
        break
      case 'stopMonitor':
        core.stopMonitor()
        monitorRegistered = false
        result = { success: true }
        break
      default:
        result = { success: false, error: `unknown type: ${type}` }
    }
    parentPort.postMessage({ id, result })
    if (shouldExitAfterReply) clearInterval(keepAliveTimer)
  } catch (e: any) {
    parentPort.postMessage({ id, error: e?.message || String(e) })
  }
}

parentPort.postMessage({ id: 0, type: 'ready' })
