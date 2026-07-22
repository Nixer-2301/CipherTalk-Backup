/**
 * 基于 whisper.cpp 的语音转文字服务（支持 GPU 加速）
 * 使用 node-whisper 包装 whisper.cpp
 */
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync, writeFileSync, renameSync, type WriteStream } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import * as https from 'https'
import * as http from 'http'
import { getAppDataPath, getAppPath, getTempPath, isElectronPackaged } from './runtimePaths'

interface ModelConfig {
    name: string
    filename: string
    size: number
    sizeLabel: string
    quality: string
}

type DownloadCancelState = {
    cancelled: boolean
    request?: http.ClientRequest
    writer?: WriteStream
}

const DOWNLOAD_CANCELLED_MESSAGE = '下载已暂停'

const MODELS: Record<string, ModelConfig> = {
    tiny: {
        name: 'tiny',
        filename: 'ggml-tiny.bin',
        size: 75_000_000,
        sizeLabel: '75 MB',
        quality: '一般'
    },
    base: {
        name: 'base',
        filename: 'ggml-base.bin',
        size: 145_000_000,
        sizeLabel: '145 MB',
        quality: '良好'
    },
    small: {
        name: 'small',
        filename: 'ggml-small.bin',
        size: 488_000_000,
        sizeLabel: '488 MB',
        quality: '优秀'
    },
    medium: {
        name: 'medium',
        filename: 'ggml-medium.bin',
        size: 1_500_000_000,
        sizeLabel: '1.5 GB',
        quality: '很好'
    },
    'large-v3': {
        name: 'large-v3',
        filename: 'ggml-large-v3.bin',
        size: 3_100_000_000,
        sizeLabel: '3.1 GB',
        quality: '极好'
    },
    'large-v3-turbo': {
        name: 'large-v3-turbo',
        filename: 'ggml-large-v3-turbo.bin',
        size: 1_620_000_000,
        sizeLabel: '1.62 GB',
        quality: '极好（推荐）'
    },
    'large-v3-turbo-q5': {
        name: 'large-v3-turbo-q5',
        filename: 'ggml-large-v3-turbo-q5_0.bin',
        size: 540_000_000,
        sizeLabel: '540 MB',
        quality: '极好（量化版）'
    },
    'large-v3-turbo-q8': {
        name: 'large-v3-turbo-q8',
        filename: 'ggml-large-v3-turbo-q8_0.bin',
        size: 835_000_000,
        sizeLabel: '835 MB',
        quality: '极好（高质量量化）'
    }
}

type WavBufferInput = Buffer | ArrayBuffer | ArrayBufferView

function normalizeWavBuffer(wavData: WavBufferInput): Buffer {
    if (Buffer.isBuffer(wavData)) {
        return wavData
    }

    if (ArrayBuffer.isView(wavData)) {
        return Buffer.from(wavData.buffer, wavData.byteOffset, wavData.byteLength)
    }

    return Buffer.from(wavData)
}

export class VoiceTranscribeServiceWhisper {
    private modelsDir: string
    private whisperExe: string
    private whisperDir: string
    private useGPU: boolean = false
    private downloadCancels = new Map<string, DownloadCancelState>()

    constructor() {
        this.modelsDir = join(getAppDataPath(), 'ciphertalk', 'whisper-models')
        
        // whisper.cpp 的可执行文件路径
        let resourcesPath: string
        
        if (isElectronPackaged()) {
            resourcesPath = join(process.resourcesPath || getAppPath(), 'resources', 'whisper')
        } else {
            resourcesPath = join(getAppPath(), 'resources', 'whisper')
        }
        
        const cliExe = join(resourcesPath, 'whisper-cli.exe')
        const mainExe = join(resourcesPath, 'main.exe')
        
        this.whisperExe = existsSync(cliExe) ? cliExe : mainExe
        this.whisperDir = resourcesPath
        
        if (!existsSync(this.modelsDir)) {
            mkdirSync(this.modelsDir, { recursive: true })
        }
    }

    /**
     * 设置 GPU 组件目录（从用户配置的缓存目录）
     */
    setGPUComponentsDir(cachePath: string) {
        const gpuDir = join(cachePath, 'whisper-gpu')
        if (!existsSync(gpuDir)) {
            mkdirSync(gpuDir, { recursive: true })
        }
        
        // 检查用户缓存目录是否有完整的 GPU 组件
        const gpuExe = join(gpuDir, 'whisper-cli.exe')
        if (existsSync(gpuExe)) {
            this.whisperExe = gpuExe
            this.whisperDir = gpuDir
        }
    }

    /**
     * 检测 GPU 支持
     */
    async detectGPU(): Promise<{
        available: boolean
        provider: string
        info: string
    }> {
        try {
            if (!existsSync(this.whisperExe)) {
                return {
                    available: false,
                    provider: 'CPU',
                    info: 'Whisper 可执行文件不存在'
                }
            }

            // 检测 NVIDIA GPU
            const { execSync } = require('child_process')
            try {
                const output = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
                    encoding: 'utf-8',
                    timeout: 3000,
                    windowsHide: true
                })
                
                const gpuName = output.trim()
                
                if (gpuName) {
                    // 检查是否有 CUDA DLL
                    const cudaDll = join(this.whisperDir, 'ggml-cuda.dll')
                    
                    if (existsSync(cudaDll)) {
                        this.useGPU = true
                        return {
                            available: true,
                            provider: 'NVIDIA CUDA',
                            info: `GPU: ${gpuName} (支持 CUDA 加速)`
                        }
                    } else {
                        return {
                            available: false,
                            provider: 'CPU',
                            info: `检测到 ${gpuName}，但缺少 CUDA 支持文件`
                        }
                    }
                }
            } catch (e) {
                // nvidia-smi 命令失败，继续检查 CPU 模式
            }

            // 检查是否有 CPU DLL
            const cpuDll = join(this.whisperDir, 'ggml-cpu.dll')
            
            if (existsSync(cpuDll)) {
                this.useGPU = false
                return {
                    available: false,
                    provider: 'CPU',
                    info: '未检测到 NVIDIA GPU，将使用 CPU 模式（仍比 SenseVoice 快）'
                }
            }

            return {
                available: false,
                provider: 'CPU',
                info: 'GPU 不可用，将使用 CPU'
            }
        } catch (error) {
            console.error('[Whisper] GPU 检测失败:', error)
            return {
                available: false,
                provider: 'CPU',
                info: `GPU 检测失败: ${error}`
            }
        }
    }

    /**
     * 检查模型状态
     */
    async getModelStatus(modelType: keyof typeof MODELS = 'small'): Promise<{
        exists: boolean
        modelPath?: string
        sizeBytes?: number
    }> {
        const config = MODELS[modelType]
        const modelPath = join(this.modelsDir, config.filename)

        if (!existsSync(modelPath)) {
            return { exists: false }
        }

        const stats = statSync(modelPath)
        return {
            exists: true,
            modelPath,
            sizeBytes: stats.size
        }
    }

    /**
     * 清除指定模型
     */
    async clearModel(modelType: keyof typeof MODELS = 'small'): Promise<{ success: boolean; error?: string }> {
        try {
            const config = MODELS[modelType]
            const modelPath = join(this.modelsDir, config.filename)

            if (existsSync(modelPath)) {
                unlinkSync(modelPath)
            }

            return { success: true }
        } catch (error) {
            console.error('[Whisper] 清除模型失败:', error)
            return { success: false, error: String(error) }
        }
    }

    /**
     * 语音转文字
     */
    async transcribeWavBuffer(
        wavData: WavBufferInput,
        modelType: keyof typeof MODELS = 'small',
        language: string = 'auto'
    ): Promise<{ success: boolean; transcript?: string; error?: string }> {
        const config = MODELS[modelType]
        const modelPath = join(this.modelsDir, config.filename)

        if (!existsSync(modelPath)) {
            return { success: false, error: '模型文件不存在，请先下载模型' }
        }

        if (!existsSync(this.whisperExe)) {
            return { 
                success: false, 
                error: `Whisper 可执行文件不存在: ${this.whisperExe}\n请运行: node scripts/setup-whisper-gpu.js` 
            }
        }

        let tempWavPath: string | null = null
        let txtPath: string | null = null

        try {
            // 保存临时 WAV 文件
            tempWavPath = join(getTempPath(), `whisper_${Date.now()}.wav`)
            writeFileSync(tempWavPath, normalizeWavBuffer(wavData))
            txtPath = tempWavPath + '.txt'

            // 构建命令参数
            const args = [
                '-m', modelPath,
                '-f', tempWavPath,
                '-l', language,
                '-t', '4', // 线程数
                '-nt', // 不输出时间戳
                '-otxt' // 输出文本到 .txt 文件
            ]

            // 注意：-ng 是 "no-gpu"，我们不加这个参数就会自动使用 GPU
            // 如果不想用 GPU，才加 -ng

            // 执行 whisper
            const result = await this.runWhisper(args)

            if (result.success) {
                // 优先从 .txt 文件读取结果
                let transcript = ''
                
                if (existsSync(txtPath)) {
                    const { readFileSync } = require('fs')
                    transcript = readFileSync(txtPath, 'utf-8').trim()
                }
                
                // 如果 .txt 文件为空，尝试从 stdout 提取
                if (!transcript && result.text) {
                    transcript = result.text
                }
                
                if (transcript) {
                    return { success: true, transcript }
                } else {
                    console.error('[Whisper] 识别结果为空')
                    return { success: false, error: '识别结果为空' }
                }
            } else {
                console.error('[Whisper] 识别失败:', result.error)
                // 模型文件损坏（多为旧版下载中断/续传错位残留）：下载函数开头 existsSync 会把已存在的
                // .bin 当成"已下载"短路，不会自动重下，所以这里给出可操作提示，引导用户清除后重下。
                const corrupt = /unknown tensor|failed to initialize whisper|invalid model|not a valid/i.test(result.error || '')
                return {
                    success: false,
                    error: corrupt
                        ? '模型文件已损坏（多为下载中断或续传错位所致）。请在设置里清除该 Whisper 模型后重新下载。'
                        : result.error
                }
            }
        } catch (error) {
            console.error('[Whisper] 异常:', error)
            return { success: false, error: String(error) }
        } finally {
            // 清理临时文件
            try {
                if (tempWavPath && existsSync(tempWavPath)) {
                    unlinkSync(tempWavPath)
                }
                if (txtPath && existsSync(txtPath)) {
                    unlinkSync(txtPath)
                }
            } catch (e) {
                console.warn('[Whisper] 清理临时文件失败:', e)
            }
        }
    }

    /**
     * 运行 whisper 命令
     */
    private runWhisper(args: string[]): Promise<{ success: boolean; text?: string; error?: string }> {
        return new Promise((resolve) => {
            const process = spawn(this.whisperExe, args, {
                windowsHide: true
            })

            let stdout = ''
            let stderr = ''

            process.stdout?.on('data', (data) => {
                stdout += data.toString()
            })

            process.stderr?.on('data', (data) => {
                stderr += data.toString()
            })

            process.on('close', (code) => {
                if (code === 0) {
                    // 从输出中提取文本
                    const text = this.extractText(stdout)
                    resolve({ success: true, text })
                } else {
                    resolve({ success: false, error: stderr || '识别失败' })
                }
            })

            process.on('error', (error) => {
                resolve({ success: false, error: String(error) })
            })
        })
    }

    /**
     * 从输出中提取文本
     */
    private extractText(output: string): string {
        // whisper.cpp 的输出格式有多种可能：
        // 1. 带时间戳: [00:00:00.000 --> 00:00:05.000] 文本
        // 2. 不带时间戳(-nt): 直接输出文本
        const lines = output.split('\n')
        const textLines: string[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            
            // 跳过日志行
            if (trimmed.startsWith('[') && !trimmed.includes('-->')) {
                continue
            }
            
            // 匹配带时间戳的格式: [00:00:00.000 --> 00:00:05.000] 文本
            const timestampMatch = trimmed.match(/\[[\d:.]+\s+-->\s+[\d:.]+\]\s+(.+)/)
            if (timestampMatch) {
                textLines.push(timestampMatch[1].trim())
                continue
            }
            
            // 如果不是日志行且不为空，直接作为文本
            if (!trimmed.startsWith('whisper_') && 
                !trimmed.startsWith('system_info:') &&
                !trimmed.includes('processing') &&
                !trimmed.includes('load time') &&
                trimmed.length > 0) {
                textLines.push(trimmed)
            }
        }

        return textLines.join(' ').trim()
    }

    /**
     * 下载模型（使用 GGML 格式）
     */
    async downloadModel(
        modelType: keyof typeof MODELS,
        onProgress?: (progress: { downloadedBytes: number; totalBytes?: number; percent?: number }) => void
    ): Promise<{ success: boolean; error?: string }> {
        const existingCancel = this.downloadCancels.get(String(modelType))
        if (existingCancel) {
            return { success: false, error: '该 Whisper 模型正在下载' }
        }

        const cancelState: DownloadCancelState = { cancelled: false }
        this.downloadCancels.set(String(modelType), cancelState)

        try {
            const config = MODELS[modelType]
            const modelPath = join(this.modelsDir, config.filename)

            // 使用 ModelScope iceCream2025 仓库（已验证可用）
            const url = `https://modelscope.cn/models/iceCream2025/whisper.cpp/resolve/master/${config.filename}`

            await this.downloadFile(url, modelPath, (downloaded, total) => {
                const percent = total ? (downloaded / total) * 100 : undefined
                onProgress?.({
                    downloadedBytes: downloaded,
                    totalBytes: config.size,
                    percent
                })
            }, cancelState)
            return { success: true }
        } catch (error) {
            if (cancelState.cancelled) {
                return { success: false, error: DOWNLOAD_CANCELLED_MESSAGE }
            }
            console.error('[Whisper] 下载失败:', error)
            return { success: false, error: String(error) }
        } finally {
            this.downloadCancels.delete(String(modelType))
        }
    }

    cancelDownloadModel(modelType: keyof typeof MODELS): { success: boolean; cancelled: boolean; error?: string } {
        const cancelState = this.downloadCancels.get(String(modelType))
        if (!cancelState) {
            return { success: true, cancelled: false, error: '没有正在下载的 Whisper 模型' }
        }

        cancelState.cancelled = true
        try { cancelState.request?.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE)) } catch { }
        try { cancelState.writer?.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE)) } catch { }
        return { success: true, cancelled: true }
    }

    /**
     * 下载文件（支持重定向和超时重试）
     */
    private downloadFile(
        url: string,
        targetPath: string,
        onProgress?: (downloaded: number, total?: number) => void,
        cancelState?: DownloadCancelState,
        remainingRedirects = 5,
        timeout = 30000 // 30秒超时
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (cancelState?.cancelled) {
                reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                return
            }

            if (existsSync(targetPath)) {
                const downloaded = statSync(targetPath).size
                onProgress?.(downloaded, downloaded)
                resolve()
                return
            }

            const protocol = url.startsWith('https') ? https : http
            const tempPath = `${targetPath}.tmp`
            let downloadedBytes = existsSync(tempPath) ? statSync(tempPath).size : 0

            const request = protocol.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    ...(downloadedBytes > 0 ? { Range: `bytes=${downloadedBytes}-` } : {})
                },
                timeout
            }, (response) => {
                if (cancelState?.cancelled) {
                    response.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                    reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                    return
                }

                // 处理重定向
                if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
                    if (remainingRedirects <= 0) {
                        reject(new Error('重定向次数过多'))
                        return
                    }

                    this.downloadFile(response.headers.location, targetPath, onProgress, cancelState, remainingRedirects - 1, timeout)
                        .then(resolve)
                        .catch(reject)
                    return
                }

                const isResumeResponse = response.statusCode === 206

                // 断点续传健壮性：本地已有残片(.tmp)时，服务器响应必须是"从 downloadedBytes 处继续"。
                // 只要对不上——忽略 Range 直接回 200、206 的区间起点跟本地字节数不一致、或返回 416 等——
                // 都不能在旧残片后追加，否则会拼出"大小看着对、内容却错位"的损坏模型，whisper 加载时报
                // unknown tensor / failed to initialize（正是用户反馈的现象）。这些情况一律删残片从头重下。
                if (downloadedBytes > 0) {
                    const rangeStart = isResumeResponse
                        ? Number(String(response.headers['content-range'] || '').match(/bytes\s+(\d+)-/i)?.[1] ?? -1)
                        : -1
                    const canResume = isResumeResponse && rangeStart === downloadedBytes
                    if (!canResume) {
                        response.destroy()
                        try { unlinkSync(tempPath) } catch { }
                        // 从头重下（无 Range → 服务器回 200 全量），不减 redirect 预算（这是重下不是重定向）
                        this.downloadFile(url, targetPath, onProgress, cancelState, remainingRedirects, timeout)
                            .then(resolve)
                            .catch(reject)
                        return
                    }
                }

                if (response.statusCode !== 200 && response.statusCode !== 206) {
                    reject(new Error(`下载失败: HTTP ${response.statusCode}`))
                    return
                }

                const contentLength = Number(response.headers['content-length'] || 0) || 0
                const rangeTotal = isResumeResponse
                    ? Number(String(response.headers['content-range'] || '').match(/\/(\d+)$/)?.[1] || 0)
                    : 0
                const totalBytes = rangeTotal || (contentLength ? downloadedBytes + contentLength : undefined)

                const writer = createWriteStream(tempPath, { flags: downloadedBytes > 0 ? 'a' : 'w' })
                if (cancelState) {
                    cancelState.request = request
                    cancelState.writer = writer
                }

                response.on('data', (chunk) => {
                    if (cancelState?.cancelled) {
                        response.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                        writer.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                        return
                    }
                    downloadedBytes += chunk.length
                    onProgress?.(downloadedBytes, totalBytes)
                })

                response.on('error', (error) => {
                    reject(cancelState?.cancelled ? new Error(DOWNLOAD_CANCELLED_MESSAGE) : error)
                })
                writer.on('error', (error) => {
                    reject(cancelState?.cancelled ? new Error(DOWNLOAD_CANCELLED_MESSAGE) : error)
                })
                writer.on('finish', () => {
                    // fd 完全关闭后再改名：Windows 上文件句柄未释放时 renameSync 会失败。
                    writer.close(() => {
                        if (cancelState?.cancelled) {
                            reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                            return
                        }
                        try {
                            // 完整性校验：最终大小必须等于服务器声明的总大小，否则判为损坏，删掉让用户重下，
                            // 绝不把半截/错位文件改名成正式模型（否则 whisper 加载报 unknown tensor）。
                            const finalSize = existsSync(tempPath) ? statSync(tempPath).size : 0
                            if (totalBytes && finalSize !== totalBytes) {
                                try { unlinkSync(tempPath) } catch { }
                                reject(new Error(`下载不完整（${finalSize}/${totalBytes} 字节），请重新下载`))
                                return
                            }
                            renameSync(tempPath, targetPath)
                            resolve()
                        } catch (error) {
                            // rename/stat 抛错绝不能冒泡出 WriteStream 事件回调——那会成为主进程未捕获异常，
                            // 直接弹「A JavaScript error occurred in the main process」崩溃框（正是用户反馈的现象）。
                            try { unlinkSync(tempPath) } catch { }
                            reject(error instanceof Error ? error : new Error(String(error)))
                        }
                    })
                })

                response.pipe(writer)
            })

            request.on('error', (error) => {
                reject(cancelState?.cancelled ? new Error(DOWNLOAD_CANCELLED_MESSAGE) : error)
            })
            request.on('timeout', () => {
                request.destroy()
                reject(new Error('下载超时'))
            })
            if (cancelState) cancelState.request = request
        })
    }

    /**
     * 清理资源
     */
    dispose() {
        // 无需特殊清理
    }
}

export const voiceTranscribeServiceWhisper = new VoiceTranscribeServiceWhisper()
