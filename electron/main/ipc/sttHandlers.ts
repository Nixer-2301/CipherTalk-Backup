import { BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { voiceTranscribeService } from '../../services/voiceTranscribeService'
import { voiceTranscribeServiceOnline } from '../../services/voiceTranscribeServiceOnline'
import { voiceTranscribeServiceWhisper } from '../../services/voiceTranscribeServiceWhisper'
import { sttRuntimeService } from '../../services/sttRuntimeService'
import type { MainProcessContext } from '../context'

type GpuDownloadCancelState = {
  cancelled: boolean
  request?: any
  fileStream?: any
}

const GPU_DOWNLOAD_CANCELLED_MESSAGE = '下载已暂停'
let gpuComponentsDownloadCancelState: GpuDownloadCancelState | null = null

/**
 * 语音转文字 IPC。
 * 下载、转写、GPU 组件安装进度事件都绑定原 channel，避免前端进度条失联。
 */
export function registerSttHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('stt:getModelStatus', async () => {
    try {
      return await voiceTranscribeService.getModelStatus()
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 下载模型
  ipcMain.handle('stt:downloadModel', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return await voiceTranscribeService.downloadModel((progress) => {
        win?.webContents.send('stt:downloadProgress', progress)
      })
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('stt:cancelDownloadModel', async () => {
    try {
      return voiceTranscribeService.cancelDownloadModel()
    } catch (e) {
      return { success: false, cancelled: false, error: String(e) }
    }
  })

  // 转写音频
  ipcMain.handle('stt:transcribe', async (event, wavBase64: string, sessionId: string, createTime: number, force?: boolean, localId?: number) => {
    try {
      const wavData = Buffer.from(wavBase64, 'base64')
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await sttRuntimeService.transcribeWavBuffer(wavData, {
        cache: { sessionId, createTime, localId, force },
        onPartial: (text) => {
          win?.webContents.send('stt:partialResult', text)
        }
      })

      return result
    } catch (e) {
      console.error('[Main] stt:transcribe 异常:', e)
      return { success: false, error: String(e) }
    }
  })

  // 转写临时录音（不走缓存，给语音对话「按住说话」用）
  ipcMain.handle('stt:transcribeBuffer', async (_, wavBase64: string) => {
    try {
      const wavData = Buffer.from(wavBase64 || '', 'base64')
      if (wavData.length === 0) return { success: false, error: '音频数据为空' }
      return await sttRuntimeService.transcribeWavBuffer(wavData, {})
    } catch (e) {
      console.error('[Main] stt:transcribeBuffer 异常:', e)
      return { success: false, error: String(e) }
    }
  })

  // 获取缓存的转写结果
  ipcMain.handle('stt:getCachedTranscript', async (_, sessionId: string, createTime: number, localId?: number) => {
    try {
      const transcript = voiceTranscribeService.getCachedTranscript(sessionId, createTime, localId)
      return { success: true, transcript }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 更新转写缓存
  ipcMain.handle('stt:updateTranscript', async (_, sessionId: string, createTime: number, transcript: string, localId?: number) => {
    try {
      voiceTranscribeService.saveTranscriptCache(sessionId, createTime, transcript, false, localId)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('stt-online:test-config', async (_, overrides?: {
    provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'qianwen-cloud' | 'volcano-doubao' | 'custom'
    apiKey?: string
    baseURL?: string
    model?: string
    language?: string
    timeoutMs?: number
  }) => {
    try {
      return await voiceTranscribeServiceOnline.testConfig(overrides)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // ========== Whisper GPU 加速 ==========

  // 清除模型
  ipcMain.handle('stt:clearModel', async () => {
    return await voiceTranscribeService.clearModel()
  })

  // ========== Whisper GPU 加速 (新方案) ==========

  // 检测 GPU
  ipcMain.handle('stt-whisper:detect-gpu', async () => {
    try {
      return await voiceTranscribeServiceWhisper.detectGPU()
    } catch (e) {
      return { available: false, provider: 'CPU', info: String(e) }
    }
  })

  // 检查模型状态
  ipcMain.handle('stt-whisper:check-model', async (_, modelType: string) => {
    try {
      return await voiceTranscribeServiceWhisper.getModelStatus(modelType as any)
    } catch (e) {
      return { exists: false, error: String(e) }
    }
  })

  // 下载模型
  ipcMain.handle('stt-whisper:download-model', async (event, modelType: string) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return await voiceTranscribeServiceWhisper.downloadModel(
        modelType as any,
        (progress) => {
          win?.webContents.send('stt-whisper:download-progress', progress)
        }
      )
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('stt-whisper:cancel-download-model', async (_, modelType: string) => {
    try {
      return voiceTranscribeServiceWhisper.cancelDownloadModel(modelType as any)
    } catch (e) {
      return { success: false, cancelled: false, error: String(e) }
    }
  })

  // 清除模型
  ipcMain.handle('stt-whisper:clear-model', async (_, modelType: string) => {
    try {
      return await voiceTranscribeServiceWhisper.clearModel(modelType as any)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 语音识别
  ipcMain.handle('stt-whisper:transcribe', async (_, wavData: Buffer | ArrayBuffer | Uint8Array, options: {
    modelType?: string
    language?: string
  }) => {
    try {
      const wavBuffer = Buffer.isBuffer(wavData)
        ? wavData
        : wavData instanceof ArrayBuffer
          ? Buffer.from(wavData)
          : Buffer.from(wavData)

      return await voiceTranscribeServiceWhisper.transcribeWavBuffer(
        wavBuffer,
        (options.modelType || 'small') as any,
        options.language || 'auto'
      )
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 下载 GPU 组件
  ipcMain.handle('stt-whisper:download-gpu-components', async (event) => {
    try {
      if (gpuComponentsDownloadCancelState) {
        return { success: false, error: 'GPU 组件正在下载' }
      }

      const cancelState: GpuDownloadCancelState = { cancelled: false }
      gpuComponentsDownloadCancelState = cancelState

      if (!ctx.getConfigService()) {
        return { success: false, error: '配置服务未初始化' }
      }

      const cachePath = ctx.getConfigService()?.get('cachePath')
      if (!cachePath) {
        return { success: false, error: '请先设置缓存目录' }
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      const gpuDir = join(cachePath, 'whisper-gpu')

      // 确保目录存在
      if (!existsSync(gpuDir)) {
        mkdirSync(gpuDir, { recursive: true })
      }

      const zipUrl = 'https://miyuapp.aiqji.com/whisper.zip'
      const zipPath = join(gpuDir, 'whisper.zip')
      const tempPath = zipPath + '.tmp'

      console.log('[Whisper GPU] 开始下载:', zipUrl)
      console.log('[Whisper GPU] 保存到:', zipPath)

      const fs = require('fs')
      const https = require('https')

      // 格式化速度
      const formatSpeed = (bytesPerSecond: number): string => {
        if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`
        if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
        return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
      }

      // 格式化大小
      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
      }

      // 检查是否有未完成的下载
      let downloadedBytes = 0
      if (existsSync(tempPath)) {
        const stats = fs.statSync(tempPath)
        downloadedBytes = stats.size
        console.log('[Whisper GPU] 发现未完成的下载，已下载:', formatSize(downloadedBytes))
      }

      // 分块下载函数（更可靠）
      const downloadInChunks = async (): Promise<void> => {
        if (cancelState.cancelled) throw new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE)

        // 先获取文件总大小
        const getFileSize = (): Promise<number> => {
          return new Promise((resolve, reject) => {
            const request = https.get(zipUrl, { method: 'HEAD' }, (res: any) => {
              if (res.statusCode === 200) {
                const size = parseInt(res.headers['content-length'] || '0')
                resolve(size)
              } else {
                reject(new Error(`获取文件大小失败: ${res.statusCode}`))
              }
            }).on('error', reject)
            cancelState.request = request
          })
        }

        const totalBytes = await getFileSize()
        console.log('[Whisper GPU] 文件总大小:', formatSize(totalBytes))

        // 如果已经下载完成
        if (downloadedBytes >= totalBytes) {
          console.log('[Whisper GPU] 文件已下载完成')
          if (existsSync(tempPath)) {
            fs.renameSync(tempPath, zipPath)
          }
          return
        }

        // 分块大小：10MB
        const chunkSize = 10 * 1024 * 1024
        let currentBytes = downloadedBytes

        // 打开文件流（追加模式）
        const fileStream = fs.createWriteStream(tempPath, { flags: 'a' })
        cancelState.fileStream = fileStream

        let lastProgressTime = Date.now()
        let lastCurrentBytes = currentBytes

        while (currentBytes < totalBytes) {
          if (cancelState.cancelled) throw new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE)

          const start = currentBytes
          const end = Math.min(currentBytes + chunkSize - 1, totalBytes - 1)

          console.log(`[Whisper GPU] 下载块: ${formatSize(start)} - ${formatSize(end)}`)

          // 下载单个块（带重试）
          const downloadChunk = async (retries = 5): Promise<void> => {
            for (let attempt = 1; attempt <= retries; attempt++) {
              if (cancelState.cancelled) throw new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE)

              try {
                await new Promise<void>((resolve, reject) => {
                  const options = {
                    headers: {
                      'Range': `bytes=${start}-${end}`
                    }
                  }

                  const request = https.get(zipUrl, options, (res: any) => {
                    if (cancelState.cancelled) {
                      res.destroy(new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE))
                      reject(new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE))
                      return
                    }

                    if (res.statusCode !== 206 && res.statusCode !== 200) {
                      reject(new Error(`HTTP ${res.statusCode}`))
                      return
                    }

                    let chunkBytes = 0

                    res.on('data', (chunk: Buffer) => {
                      if (cancelState.cancelled) {
                        res.destroy(new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE))
                        reject(new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE))
                        return
                      }

                      fileStream.write(chunk)
                      chunkBytes += chunk.length
                      currentBytes += chunk.length

                      // 更新进度（每500ms）
                      const now = Date.now()
                      if (now - lastProgressTime > 500) {
                        const percent = (currentBytes / totalBytes) * 100
                        const speed = (currentBytes - lastCurrentBytes) / ((now - lastProgressTime) / 1000)

                        win?.webContents.send('stt-whisper:gpu-download-progress', {
                          currentFile: `下载中 (${formatSpeed(speed)}) - ${formatSize(currentBytes)}/${formatSize(totalBytes)}`,
                          fileProgress: percent,
                          overallProgress: percent * 0.9, // 留10%给解压
                          completedFiles: 0,
                          totalFiles: 1
                        })

                        lastProgressTime = now
                        lastCurrentBytes = currentBytes
                      }
                    })

                    res.on('end', () => {
                      console.log(`[Whisper GPU] 块下载完成: ${formatSize(chunkBytes)}`)
                      resolve()
                    })

                    res.on('error', (error: Error) => {
                      reject(cancelState.cancelled ? new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE) : error)
                    })
                  })

                  cancelState.request = request
                  request.on('error', (error: Error) => {
                    reject(cancelState.cancelled ? new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE) : error)
                  })
                  request.setTimeout(30000, () => {
                    request.destroy()
                    reject(new Error('请求超时'))
                  })
                })

                // 下载成功，跳出重试循环
                break
              } catch (error) {
                if (cancelState.cancelled) {
                  fileStream.close()
                  throw new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE)
                }

                console.error(`[Whisper GPU] 块下载失败 (尝试 ${attempt}/${retries}):`, error)

                // 回退到块开始位置
                currentBytes = start

                if (attempt < retries) {
                  const waitTime = Math.min(attempt * 1000, 5000) // 最多等5秒
                  console.log(`[Whisper GPU] ${waitTime / 1000} 秒后重试...`)
                  await new Promise(r => setTimeout(r, waitTime))
                } else {
                  fileStream.close()
                  throw new Error(`块下载失败: ${error}`)
                }
              }
            }
          }

          await downloadChunk()
        }

        // 关闭文件流
        await new Promise<void>((resolve, reject) => {
          fileStream.end(() => {
            console.log('[Whisper GPU] 文件流已关闭')
            resolve()
          })
          fileStream.on('error', reject)
        })

        // 重命名临时文件
        if (existsSync(tempPath)) {
          fs.renameSync(tempPath, zipPath)
          console.log('[Whisper GPU] 下载完成')
        }
      }

      // 执行下载
      await downloadInChunks()

      console.log('[Whisper GPU] 下载完成，开始解压...')

      // 解压 ZIP 文件
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(zipPath)
      const zipEntries = zip.getEntries()

      // 遍历所有文件，直接解压到 gpuDir（跳过文件夹结构）
      for (const entry of zipEntries) {
        if (!entry.isDirectory) {
          // 获取文件名（不包含路径）
          const fileName = entry.entryName.split('/').pop() || entry.entryName.split('\\').pop()
          if (fileName) {
            const targetPath = join(gpuDir, fileName)
            console.log('[Whisper GPU] 解压文件:', fileName)
            fs.writeFileSync(targetPath, entry.getData())
          }
        }
      }

      console.log('[Whisper GPU] 解压完成')

      // 删除 ZIP 文件
      fs.unlinkSync(zipPath)

      // 发送完成进度
      win?.webContents.send('stt-whisper:gpu-download-progress', {
        currentFile: '完成',
        fileProgress: 100,
        overallProgress: 100,
        completedFiles: 1,
        totalFiles: 1
      })

      // 重新设置 GPU 组件目录
      voiceTranscribeServiceWhisper.setGPUComponentsDir(cachePath)

      console.log('[Whisper GPU] GPU 组件安装完成')
      return { success: true }
    } catch (e) {
      if (gpuComponentsDownloadCancelState?.cancelled) {
        return { success: false, error: GPU_DOWNLOAD_CANCELLED_MESSAGE }
      }
      console.error('[Whisper GPU] 下载失败:', e)
      return { success: false, error: String(e) }
    } finally {
      gpuComponentsDownloadCancelState = null
    }
  })

  ipcMain.handle('stt-whisper:cancel-download-gpu-components', async () => {
    const cancelState = gpuComponentsDownloadCancelState
    if (!cancelState) {
      return { success: true, cancelled: false, error: '没有正在下载的 GPU 组件' }
    }

    cancelState.cancelled = true
    try { cancelState.request?.destroy(new Error(GPU_DOWNLOAD_CANCELLED_MESSAGE)) } catch { }
    try { cancelState.fileStream?.close() } catch { }
    return { success: true, cancelled: true }
  })

  // 检查 GPU 组件状态
  ipcMain.handle('stt-whisper:check-gpu-components', async () => {
    try {
      if (!ctx.getConfigService()) {
        return { installed: false, reason: '配置服务未初始化' }
      }

      const cachePath = ctx.getConfigService()?.get('cachePath')
      if (!cachePath) {
        return { installed: false, reason: '未设置缓存目录' }
      }

      const gpuDir = join(cachePath, 'whisper-gpu')
      const requiredFiles = [
        'whisper-cli.exe',
        'whisper.dll',
        'ggml.dll',
        'ggml-base.dll',
        'ggml-cpu.dll',
        'ggml-cuda.dll',
        'SDL2.dll',
        'cudart64_12.dll',
        'cublas64_12.dll',
        'cublasLt64_12.dll'
      ]

      const missingFiles = requiredFiles.filter(f => !existsSync(join(gpuDir, f)))

      return {
        installed: missingFiles.length === 0,
        missingFiles,
        gpuDir
      }
    } catch (e) {
      return { installed: false, error: String(e) }
    }
  })
}
