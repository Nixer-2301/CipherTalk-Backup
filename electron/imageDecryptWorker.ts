/**
 * 图片 dat 解密 worker（worker_threads）。
 *
 * 每个 worker 串行处理请求：读 dat → native 插件尝试 → TS V3/V4 解密，
 * 把读盘 + AES + XOR 从主线程挪到独立线程真并行。
 * 由 imageDecryptWorkerPool 管理，消息协议：
 *   池→worker  { id, datPath, xorKey, aesKeyText, aesKeyB64 }
 *   worker→池  { id, ok: true, data, source, fallbackReason } / { id, ok: false, error }
 */
import { parentPort } from 'worker_threads'
import { decryptDatViaNative } from './services/nativeImageDecrypt'
import { decryptDatLegacy, looksLikeNativeImagePayload, type DatDecryptOutcome } from './services/datDecryptCore'

if (!parentPort) {
  throw new Error('imageDecryptWorker 必须在 worker_threads 中运行')
}

type DecryptRequest = {
  id: number
  datPath: string
  xorKey: number
  aesKeyText: string
  aesKeyB64: string | null
}

parentPort.on('message', (req: DecryptRequest) => {
  const { id, datPath, xorKey, aesKeyText, aesKeyB64 } = req
  try {
    let outcome: DatDecryptOutcome
    // native 插件不可用/加载失败时 decryptDatViaNative 返回 null，静默走 TS
    const native = decryptDatViaNative(datPath, xorKey, aesKeyText || undefined)
    if (native && looksLikeNativeImagePayload(native.data)) {
      outcome = { data: native.data, source: 'native' }
    } else {
      const fallbackReason = native ? 'invalid_native_payload' : 'native_unavailable'
      const aesKey = aesKeyB64 ? Buffer.from(aesKeyB64, 'base64') : null
      outcome = decryptDatLegacy(datPath, xorKey, aesKey, fallbackReason)
    }
    parentPort!.postMessage({
      id,
      ok: true,
      data: outcome.data,
      source: outcome.source,
      fallbackReason: outcome.fallbackReason
    })
  } catch (e: any) {
    parentPort!.postMessage({ id, ok: false, error: e?.message || String(e) })
  }
})
