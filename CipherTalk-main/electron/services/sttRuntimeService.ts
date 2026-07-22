import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import { spawn } from 'child_process'
import { ConfigService } from './config'
import { voiceTranscribeService } from './voiceTranscribeService'
import { voiceTranscribeServiceOnline } from './voiceTranscribeServiceOnline'
import { voiceTranscribeServiceWhisper } from './voiceTranscribeServiceWhisper'

type SttMode = 'cpu' | 'gpu' | 'online'
type SttErrorCode = 'STT_NOT_READY' | 'INTERNAL_ERROR'

type TranscribeCacheOptions = {
  sessionId: string
  createTime: number
  localId?: number
  allowLegacyCache?: boolean
  force?: boolean
}

type RuntimeTranscribeOptions = {
  cache?: TranscribeCacheOptions
  onPartial?: (text: string) => void
}

export type RuntimeTranscribeResult = {
  success: boolean
  transcript?: string
  cached?: boolean
  sttMode: SttMode
  error?: string
  errorCode?: SttErrorCode
}

const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.amr'
])

function resolveFfmpegPath(): string {
  try {
    const ffmpegStatic = require('ffmpeg-static')
    if (typeof ffmpegStatic === 'string') {
      const unpackedPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(unpackedPath)) return unpackedPath
      if (existsSync(ffmpegStatic)) return ffmpegStatic
    }
  } catch {
    // fall back to PATH
  }
  return 'ffmpeg'
}

function isReadinessError(message?: string): boolean {
  const text = String(message || '')
  return (
    text.includes('模型文件不存在') ||
    text.includes('Tokens 文件不存在') ||
    text.includes('Whisper 可执行文件不存在') ||
    text.includes('请先配置在线转写') ||
    text.includes('在线转写接口 URL') ||
    text.includes('在线转写 API Key') ||
    text.includes('在线转写模型名称')
  )
}

class SttRuntimeService {
  private configService = new ConfigService()

  getCachedTranscript(sessionId: string, createTime: number, localId?: number, allowLegacy = localId === undefined): string | null {
    return voiceTranscribeService.getCachedTranscript(sessionId, createTime, localId, allowLegacy)
  }

  hasCachedTranscript(sessionId: string, createTime: number, localId?: number, allowLegacy = localId === undefined): boolean {
    return voiceTranscribeService.hasCachedTranscript(sessionId, createTime, localId, allowLegacy)
  }

  saveTranscriptCache(sessionId: string, createTime: number, transcript: string, allowEmpty = false, localId?: number): void {
    voiceTranscribeService.saveTranscriptCache(sessionId, createTime, transcript, allowEmpty, localId)
  }

  getCurrentSttMode(): SttMode {
    const mode = this.configService.get('sttMode')
    return mode === 'gpu' || mode === 'online' ? mode : 'cpu'
  }

  private async checkReady(sttMode: SttMode): Promise<{ ready: boolean; error?: string }> {
    if (sttMode === 'gpu') {
      const whisperModelType = this.configService.get('whisperModelType') || 'small'
      const status = await voiceTranscribeServiceWhisper.getModelStatus(whisperModelType as any)
      return status.exists
        ? { ready: true }
        : { ready: false, error: `Whisper ${whisperModelType} 模型未下载，请先在设置页下载模型` }
    }

    if (sttMode === 'online') {
      const validation = voiceTranscribeServiceOnline.validateConfig()
      return validation.valid
        ? { ready: true }
        : { ready: false, error: validation.error || '在线转写配置不完整' }
    }

    const status = await voiceTranscribeService.getModelStatus()
    if (!status.success) {
      return { ready: false, error: status.error || '语音识别模型状态检查失败' }
    }
    return status.exists
      ? { ready: true }
      : { ready: false, error: 'SenseVoice 模型未下载，请先在设置页下载模型' }
  }

  async transcribeWavBuffer(
    wavData: Buffer,
    options: RuntimeTranscribeOptions = {}
  ): Promise<RuntimeTranscribeResult> {
    const sttMode = this.getCurrentSttMode()
    const cache = options.cache

    if (cache && !cache.force) {
      // 必须用 hasCached：空串也是有效缓存命中，避免重复扣在线 STT 额度
      if (this.hasCachedTranscript(cache.sessionId, cache.createTime, cache.localId, cache.allowLegacyCache)) {
        const cached = this.getCachedTranscript(cache.sessionId, cache.createTime, cache.localId, cache.allowLegacyCache) ?? ''
        return { success: true, transcript: cached, cached: true, sttMode }
      }
    }

    const ready = await this.checkReady(sttMode)
    if (!ready.ready) {
      return { success: false, sttMode, error: ready.error, errorCode: 'STT_NOT_READY' }
    }

    let result: { success: boolean; transcript?: string; error?: string }
    try {
      if (sttMode === 'gpu') {
        const whisperModelType = this.configService.get('whisperModelType') || 'small'
        result = await voiceTranscribeServiceWhisper.transcribeWavBuffer(wavData, whisperModelType as any, 'auto')
      } else if (sttMode === 'online') {
        result = await voiceTranscribeServiceOnline.transcribeWavBuffer(wavData, options.onPartial)
      } else {
        result = await voiceTranscribeService.transcribeWavBuffer(wavData, options.onPartial)
      }
    } catch (error) {
      const message = String(error)
      return {
        success: false,
        sttMode,
        error: message,
        errorCode: isReadinessError(message) ? 'STT_NOT_READY' : 'INTERNAL_ERROR'
      }
    }

    if (!result.success) {
      return {
        success: false,
        sttMode,
        error: result.error || '语音转写失败',
        errorCode: isReadinessError(result.error) ? 'STT_NOT_READY' : 'INTERNAL_ERROR'
      }
    }

    const transcript = String(result.transcript || '').trim()
    if (cache) {
      // 空结果也落库，标记「已尝试」，重克隆时不再重复调用 STT
      this.saveTranscriptCache(cache.sessionId, cache.createTime, transcript, true, cache.localId)
    }

    if (!transcript) {
      return {
        success: false,
        sttMode,
        error: result.error || '语音转写结果为空',
        errorCode: 'INTERNAL_ERROR'
      }
    }

    return { success: true, transcript, cached: false, sttMode }
  }

  validateAudioFilePath(filePath: string): { valid: boolean; error?: string } {
    if (!filePath.trim()) return { valid: false, error: '缺少 filePath 参数' }
    if (!existsSync(filePath)) return { valid: false, error: '音频文件不存在' }
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(filePath)
    } catch (error) {
      return { valid: false, error: `无法读取音频文件: ${String(error)}` }
    }
    if (!stats.isFile()) return { valid: false, error: 'filePath 必须指向本地音频文件' }
    const ext = extname(filePath).toLowerCase()
    if (!AUDIO_EXTENSIONS.has(ext)) {
      return { valid: false, error: `不支持的音频格式: ${ext || 'unknown'}` }
    }
    return { valid: true }
  }

  async transcribeAudioFile(filePath: string): Promise<RuntimeTranscribeResult> {
    const sttMode = this.getCurrentSttMode()
    const validation = this.validateAudioFilePath(filePath)
    if (!validation.valid) {
      return { success: false, sttMode, error: validation.error, errorCode: 'INTERNAL_ERROR' }
    }

    const ready = await this.checkReady(sttMode)
    if (!ready.ready) {
      return { success: false, sttMode, error: ready.error, errorCode: 'STT_NOT_READY' }
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'ciphertalk-stt-'))
    const wavPath = join(tempDir, 'input.wav')

    try {
      await this.convertAudioToWav(filePath, wavPath)
      const wavData = readFileSync(wavPath)
      return await this.transcribeWavBuffer(wavData)
    } catch (error) {
      return {
        success: false,
        sttMode,
        error: String(error),
        errorCode: isReadinessError(String(error)) ? 'STT_NOT_READY' : 'INTERNAL_ERROR'
      }
    } finally {
      try { if (existsSync(wavPath)) unlinkSync(wavPath) } catch { }
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { }
    }
  }

  private convertAudioToWav(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = resolveFfmpegPath()
      const proc = spawn(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        outputPath
      ], {
        windowsHide: true
      })

      let stderr = ''
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('音频转换超时'))
      }, 120000)

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0 && existsSync(outputPath)) {
          resolve()
          return
        }
        reject(new Error(stderr.trim() || `ffmpeg 转换失败，退出码: ${code}`))
      })
    })
  }
}

export const sttRuntimeService = new SttRuntimeService()
