/**
 * 语音转文字工作线程
 * 使用 Sherpa-ONNX 和 SenseVoiceSmall 模型进行本地离线识别
 * 使用完整音频转写以保证最高精度
 */
import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'
import * as os from 'os'

// 定义 Sherpa-ONNX 类型接口
interface SherpaRecognizerConfig {
    modelConfig: {
        senseVoice: {
            model: string
            language: string
            useInverseTextNormalization: number
        }
        tokens: string
        numThreads: number
        debug: number
        provider: string
    }
}

interface OfflineStream {
    acceptWaveform(params: { sampleRate: number; samples: Float32Array }): void
    free(): void
}

interface OfflineRecognizer {
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): { text: string }
    free(): void
}

interface InitParams {
    modelPath: string
    tokensPath: string
    sampleRate: number
    language?: string
    allowedLanguages?: string[]
}

// 模块动态加载
let sherpaDisplay: any = null
let recognizer: OfflineRecognizer | null = null
let initParams: InitParams | null = null
let isInitialized = false

/**
 * 解析 WAV 音频数据，动态查找数据块
 */
function parseWav(buffer: Buffer): { pcmData: Buffer; error?: string } {
    if (buffer.length < 44) {
        return { pcmData: Buffer.alloc(0), error: '无效的 WAV 数据：长度不足' }
    }

    // 检查 RIFF 头
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return { pcmData: Buffer.alloc(0), error: '无效的 WAV 格式：缺少 RIFF/WAVE 头' }
    }

    // 查找 data 块
    let offset = 12
    while (offset < buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4)
        const chunkSize = buffer.readUInt32LE(offset + 4)

        if (chunkId === 'data') {
            const pcmData = buffer.slice(offset + 8, offset + 8 + chunkSize)
            return { pcmData }
        }

        offset += 8 + chunkSize
    }

    return { pcmData: Buffer.alloc(0), error: '无效的 WAV 数据：未找到 data 块' }
}

async function initRecognizer(params: InitParams): Promise<{ success: boolean; error?: string }> {
    if (isInitialized && recognizer) {
        return { success: true }
    }

    try {
        sherpaDisplay = require('sherpa-onnx-node')

        let { modelPath, tokensPath } = params

        // 将 Windows 路径转换为正斜杠格式
        modelPath = modelPath.replace(/\\/g, '/')
        tokensPath = tokensPath.replace(/\\/g, '/')

        // 检查文件是否存在
        if (!fs.existsSync(modelPath)) {
            return { success: false, error: '模型文件不存在: ' + modelPath }
        }
        if (!fs.existsSync(tokensPath)) {
            return { success: false, error: 'Tokens 文件不存在: ' + tokensPath }
        }

        // 动态计算线程数，保留一半核心给系统，最少 1 个
        // 适配高配机器（如 16 核 CPU），移除 4 线程硬限制，让其能利用更多算力
        const cpuCount = os.cpus().length
        const numThreads = Math.max(1, Math.floor(cpuCount / 2))

        const recognizerConfig: SherpaRecognizerConfig = {
            modelConfig: {
                senseVoice: {
                    model: modelPath,
                    language: params.language ?? 'zh', // 使用指定语言或默认中文
                    useInverseTextNormalization: 1
                },
                tokens: tokensPath,
                numThreads: numThreads,
                debug: 0,
                provider: 'cpu'
            }
        }

        recognizer = new sherpaDisplay.OfflineRecognizer(recognizerConfig)
        initParams = { ...params, modelPath, tokensPath }
        isInitialized = true

        return { success: true }
    } catch (error) {
        console.error('[TranscribeWorker] 初始化失败:', error)
        return { success: false, error: String(error) }
    }
}

/**
 * 过滤不允许的语言字符
 */
function filterText(text: string): string {
    if (!text || !initParams?.allowedLanguages || initParams.allowedLanguages.length === 0) return text

    let result = text
    const allowed = initParams.allowedLanguages

    // Japanese (Kana)
    if (!allowed.includes('ja')) {
        result = result.replace(/[\u3040-\u30ff]/g, '')
    }

    // Korean (Hangul)
    if (!allowed.includes('ko')) {
        result = result.replace(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, '')
    }

    // Hanzi (ZH/YUE) - Only filter if neither ZH, YUE, nor JA is allowed (JA uses Kanji)
    if (!allowed.includes('zh') && !allowed.includes('yue') && !allowed.includes('ja')) {
        result = result.replace(/[\u4e00-\u9fff]/g, '')
    }

    return result
}


/**
 * 主转写函数
 */
async function transcribe(
    wavData: Buffer,
    sampleRate: number,
    onPartial: (text: string) => void
): Promise<{ success: boolean; text?: string; error?: string }> {
    if (!recognizer) {
        return { success: false, error: '识别器未初始化' }
    }

    try {
        // 使用解析函数获取 PCM 数据
        const { pcmData, error } = parseWav(wavData)
        if (error || !pcmData) {
            return { success: false, error: error || 'WAV 解析失败' }
        }

        const samples = new Float32Array(pcmData.length / 2)
        for (let i = 0; i < samples.length; i++) {
            samples[i] = pcmData.readInt16LE(i * 2) / 32768.0
        }

        // 直接使用完整音频进行转写（不分段，保留完整上下文以提高精度）
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate, samples })
        recognizer.decode(stream)
        const result = recognizer.getResult(stream)
        const text = filterText(result.text?.trim() || '')

        // 释放流资源（如果支持）
        if (stream.free) stream.free()

        return { success: true, text }
    } catch (error) {
        console.error('[TranscribeWorker] 识别失败:', error)
        return { success: false, error: String(error) }
    }
}

// 启动时初始化
if (parentPort) {
    if (workerData && workerData.modelPath) {
        const params = workerData as InitParams & { wavData?: Buffer }

        initRecognizer(params).then(async initResult => {
            if (!initResult.success) {
                parentPort!.postMessage({ type: 'error', error: initResult.error })
                return
            }

            if (params.wavData) {
                const wavData = Buffer.from(params.wavData)

                const result = await transcribe(
                    wavData,
                    params.sampleRate,
                    (text) => {
                        parentPort!.postMessage({ type: 'partial', text })
                    }
                )

                if (result.success) {
                    parentPort!.postMessage({ type: 'final', text: result.text })
                } else {
                    parentPort!.postMessage({ type: 'error', error: result.error })
                }
            }
        })
    }

    parentPort.on('message', async (msg: any) => {
        if (msg.type === 'init') {
            const result = await initRecognizer(msg as InitParams)
            parentPort!.postMessage({ type: 'initResult', ...result })
        } else if (msg.type === 'transcribe') {
            const wavData = Buffer.from(msg.wavData)

            const result = await transcribe(
                wavData,
                initParams?.sampleRate || 16000,
                (text) => {
                    parentPort!.postMessage({
                        type: 'partial',
                        text,
                        requestId: msg.requestId
                    })
                }
            )

            parentPort!.postMessage({
                type: result.success ? 'final' : 'error',
                requestId: msg.requestId,
                text: result.text,
                error: result.error
            })
        }
    })
}
