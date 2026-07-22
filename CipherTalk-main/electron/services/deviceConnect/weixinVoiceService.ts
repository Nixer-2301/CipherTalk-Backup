/**
 * 微信语音发送辅助：TTS 合成 -> ffmpeg 转 WAV(24k/mono) -> silk-wasm 编码。
 */
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import { ConfigService } from '../config'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import { resolvePersonaVoiceTtsConfig, synthesizeSpeech } from '../ai/ttsService'
import type { PersonaTtsVoiceBinding } from '../agent/persona/personaTypes'

export interface WeixinVoiceFile {
  filePath: string
  durationMs: number
  sampleRate: number
}

const VOICE_SAMPLE_RATE = 24000
const MAX_VOICE_TEXT_CHARS = 900

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

function extensionFromMime(mimeType?: string): string {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return '.wav'
  if (normalized === 'audio/ogg') return '.ogg'
  if (normalized === 'audio/aac') return '.aac'
  if (normalized === 'audio/flac') return '.flac'
  return '.mp3'
}

function getVoiceOutputDir(): string {
  const cs = new ConfigService()
  try {
    const dir = join(cs.getCacheBasePath(), 'ai-voice')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  } finally {
    cs.close()
  }
}

function ensureSilkWasmAvailable(): void {
  let wasmPath: string
  if (isElectronPackaged()) {
    wasmPath = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
    if (!existsSync(wasmPath)) {
      wasmPath = join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
    }
  } else {
    wasmPath = join(getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
  }
  if (!existsSync(wasmPath)) throw new Error('silk-wasm 文件不存在')
}

function convertAudioToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', String(VOICE_SAMPLE_RATE),
      '-f', 'wav',
      outputPath,
    ], { windowsHide: true })

    let stderr = ''
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('音频转换超时'))
    }, 120000)

    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
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

export async function synthesizeWeixinVoice(
  text: string,
  options: { personaVoice?: PersonaTtsVoiceBinding | null; instructions?: string } = {},
): Promise<WeixinVoiceFile> {
  const input = String(text || '').trim().slice(0, MAX_VOICE_TEXT_CHARS)
  if (!input) throw new Error('语音内容为空')

  const configPatch = options.instructions ? { instructions: options.instructions } : undefined
  const config = options.personaVoice
    ? resolvePersonaVoiceTtsConfig(options.personaVoice, configPatch)
    : configPatch
  const speech = await synthesizeSpeech(input, config ? { config, useCache: true } : { useCache: true })
  if (!speech.success || !speech.audioBase64) {
    throw new Error(speech.error || 'TTS 合成失败')
  }

  ensureSilkWasmAvailable()
  const tempDir = await mkdtemp(join(tmpdir(), 'ciphertalk-wechat-voice-'))
  const inputPath = join(tempDir, `tts${extensionFromMime(speech.mimeType)}`)
  const wavPath = join(tempDir, 'voice.wav')

  try {
    writeFileSync(inputPath, Buffer.from(speech.audioBase64, 'base64'))
    await convertAudioToWav(inputPath, wavPath)

    const silkWasm = require('silk-wasm') as {
      encode(input: Buffer, sampleRate: number): Promise<{ data: Uint8Array; duration: number }>
    }
    const wavData = readFileSync(wavPath)
    const encoded = await silkWasm.encode(wavData, 0)
    const dir = getVoiceOutputDir()
    const filePath = join(dir, `voice-${Date.now()}-${Math.floor(Math.random() * 1e6)}.silk`)
    writeFileSync(filePath, Buffer.from(encoded.data))

    return {
      filePath,
      durationMs: Math.max(1, Math.round(encoded.duration)),
      sampleRate: VOICE_SAMPLE_RATE,
    }
  } finally {
    try { if (existsSync(inputPath)) unlinkSync(inputPath) } catch { /* ignore */ }
    try { if (existsSync(wavPath)) unlinkSync(wavPath) } catch { /* ignore */ }
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export function isLikelyAudioFile(filePath: string): boolean {
  return ['.silk', '.slk', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'].includes(extname(filePath).toLowerCase())
}
