/**
 * 麦克风录音 → 16k 单声道 PCM16 WAV(base64)。
 * 给数字分身「按住说话」语音对话用：录一段 → 交给 stt.transcribeBuffer 转文本。
 *
 * ponytail: 用 ScriptProcessorNode（已弃用但 Chromium 全支持、零额外文件/依赖）采集 PCM；
 * 若以后要更低延迟/主线程零阻塞，再换 AudioWorklet（需单独 worklet 模块文件）。
 */

const TARGET_SAMPLE_RATE = 16000

export interface VoiceRecording {
  wavBase64: string
  durationSec: number
}

export interface ActiveRecorder {
  /** 停止录音并返回 16k WAV（base64）。 */
  stop: () => Promise<VoiceRecording>
  /** 放弃本次录音，不产出音频。 */
  cancel: () => void
}

/** 平均降采样到 16k，够语音识别用（不追求高保真）。 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate <= TARGET_SAMPLE_RATE) return input
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0
    let count = 0
    for (let j = start; j < end; j += 1) {
      sum += input[j]
      count += 1
    }
    out[i] = count > 0 ? sum / count : 0
  }
  return out
}

/** Float32 PCM → 44 字节头的 PCM16 单声道 WAV。 */
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byteRate
  view.setUint16(32, 2, true) // blockAlign
  view.setUint16(34, 16, true) // 位深
  writeStr(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let offset = 44
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000 // 分块避免 String.fromCharCode 参数过多爆栈
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** 任意采样率的单声道 Float32 PCM → 16k 单声道 PCM16 WAV(base64)。供录音/通话共用。 */
export function pcmToWav16Base64(pcm: Float32Array, inputRate: number): string {
  const pcm16k = downsampleTo16k(pcm, inputRate)
  return arrayBufferToBase64(encodeWav(pcm16k, TARGET_SAMPLE_RATE))
}

/**
 * 开始录音。调用方拿到 ActiveRecorder 后，按需 stop()/cancel()。
 * 会申请麦克风权限；被拒或不支持时抛错。
 */
export async function startVoiceRecording(): Promise<ActiveRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const AudioCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioCtor) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('当前环境不支持 AudioContext，无法录音')
  }

  const ctx: AudioContext = new AudioCtor()
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  const inputRate = ctx.sampleRate

  processor.onaudioprocess = (e) => {
    // 必须复制：inputBuffer 底层缓冲会被复用
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(ctx.destination)

  let torn = false
  const teardown = () => {
    if (torn) return
    torn = true
    processor.onaudioprocess = null
    try { processor.disconnect() } catch { /* ignore */ }
    try { source.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => { /* ignore */ })
  }

  return {
    async stop(): Promise<VoiceRecording> {
      teardown()
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const merged = new Float32Array(total)
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.length
      }
      const durationSec = inputRate > 0 ? total / inputRate : 0
      return { wavBase64: pcmToWav16Base64(merged, inputRate), durationSec }
    },
    cancel(): void {
      teardown()
      chunks.length = 0
    },
  }
}
