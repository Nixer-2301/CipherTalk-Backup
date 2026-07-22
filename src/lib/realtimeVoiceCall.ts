const INPUT_SAMPLE_RATE = 16000
const INPUT_PACKET_SAMPLES = 320

export interface RealtimeMicrophone {
  setMuted: (muted: boolean) => void
  stop: () => void
}

export interface RealtimePcmPlayer {
  beginResponse: (replyId?: string) => void
  enqueue: (audioBase64: string, sampleRate?: number, channels?: number) => void
  interrupt: () => { replyId?: string; audioEndMs: number }
  close: () => void
}

class StreamingDownsampler {
  private buffered = new Float32Array(0)
  private position = 0

  constructor(private readonly inputRate: number, private readonly outputRate: number) {}

  process(input: Float32Array): Float32Array {
    const data = new Float32Array(this.buffered.length + input.length)
    data.set(this.buffered)
    data.set(input, this.buffered.length)
    const ratio = this.inputRate / this.outputRate
    const output: number[] = []

    while (this.position + ratio <= data.length) {
      const start = Math.floor(this.position)
      const end = Math.max(start + 1, Math.min(data.length, Math.floor(this.position + ratio)))
      let sum = 0
      for (let i = start; i < end; i += 1) sum += data[i]
      output.push(sum / (end - start))
      this.position += ratio
    }

    const consumed = Math.floor(this.position)
    this.buffered = data.slice(consumed)
    this.position -= consumed
    return Float32Array.from(output)
  }

  reset(): void {
    this.buffered = new Float32Array(0)
    this.position = 0
  }
}

function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return bytes
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

export async function startRealtimeMicrophone(options: {
  onPacket: (pcm16le: Uint8Array) => void
  onLevel?: (level: number) => void
  onError?: (error: Error) => void
}): Promise<RealtimeMicrophone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('当前环境不支持 AudioContext，无法实时通话')
  }

  const context = new AudioContextCtor() as AudioContext
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(1024, 1, 1)
  const downsampler = new StreamingDownsampler(context.sampleRate, INPUT_SAMPLE_RATE)
  let packetBuffer: number[] = []
  let packetOffset = 0
  let muted = false
  let stopped = false
  let lastLevelAt = 0

  processor.onaudioprocess = (event) => {
    if (stopped) return
    try {
      const input = new Float32Array(event.inputBuffer.getChannelData(0))
      const now = performance.now()
      if (now - lastLevelAt >= 80) {
        lastLevelAt = now
        options.onLevel?.(muted ? 0 : Math.min(1, rms(input) * 8))
      }
      if (muted) return

      const resampled = downsampler.process(input)
      for (let i = 0; i < resampled.length; i += 1) packetBuffer.push(resampled[i])
      while (packetBuffer.length - packetOffset >= INPUT_PACKET_SAMPLES) {
        const packet = Float32Array.from(packetBuffer.slice(packetOffset, packetOffset + INPUT_PACKET_SAMPLES))
        packetOffset += INPUT_PACKET_SAMPLES
        options.onPacket(floatToPcm16(packet))
      }
      if (packetOffset >= INPUT_PACKET_SAMPLES * 8) {
        packetBuffer = packetBuffer.slice(packetOffset)
        packetOffset = 0
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  source.connect(processor)
  processor.connect(context.destination)
  await context.resume()

  const stop = () => {
    if (stopped) return
    stopped = true
    processor.onaudioprocess = null
    try { processor.disconnect() } catch { /* ignore */ }
    try { source.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => undefined)
    packetBuffer = []
  }

  return {
    setMuted(nextMuted) {
      if (muted === nextMuted) return
      muted = nextMuted
      packetBuffer = []
      packetOffset = 0
      downsampler.reset()
    },
    stop,
  }
}

function decodePcm16Base64(audioBase64: string): Int16Array {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
}

export function createRealtimePcmPlayer(): RealtimePcmPlayer {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) throw new Error('当前环境不支持 AudioContext，无法播放实时语音')
  const context = new AudioContextCtor() as AudioContext
  const sources = new Set<AudioBufferSourceNode>()
  let nextTime = context.currentTime + 0.04
  let replyId: string | undefined
  let responseStartTime: number | null = null
  let scheduledDuration = 0
  let closed = false
  void context.resume()

  const stopSources = () => {
    for (const source of Array.from(sources)) {
      source.onended = null
      try { source.stop() } catch { /* ignore */ }
    }
    sources.clear()
    nextTime = context.currentTime + 0.04
  }

  return {
    beginResponse(nextReplyId) {
      if (nextReplyId && replyId === nextReplyId) return
      if (replyId && nextReplyId !== replyId) stopSources()
      replyId = nextReplyId
      responseStartTime = null
      scheduledDuration = 0
    },
    enqueue(audioBase64, sampleRate = 24000, channels = 1) {
      if (closed) return
      const pcm = decodePcm16Base64(audioBase64)
      const frames = Math.floor(pcm.length / channels)
      if (frames <= 0) return

      const buffer = context.createBuffer(channels, frames, sampleRate)
      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let i = 0; i < frames; i += 1) data[i] = pcm[i * channels + channel] / 32768
      }
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = () => sources.delete(source)
      sources.add(source)
      const startAt = Math.max(context.currentTime + 0.02, nextTime)
      if (responseStartTime === null) responseStartTime = startAt
      source.start(startAt)
      nextTime = startAt + buffer.duration
      scheduledDuration += buffer.duration
      void context.resume()
    },
    interrupt() {
      const elapsed = responseStartTime === null
        ? 0
        : Math.max(0, Math.min(scheduledDuration, context.currentTime - responseStartTime))
      const result = { replyId, audioEndMs: Math.round(elapsed * 1000) }
      stopSources()
      responseStartTime = null
      scheduledDuration = 0
      return result
    },
    close() {
      if (closed) return
      closed = true
      stopSources()
      void context.close().catch(() => undefined)
    },
  }
}
