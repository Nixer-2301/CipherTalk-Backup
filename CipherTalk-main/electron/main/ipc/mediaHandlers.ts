import { ipcMain } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { imageDecryptService } from '../../services/imageDecryptService'
import { imageKeyService } from '../../services/imageKeyService'
import { videoService } from '../../services/videoService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import type { MainProcessContext } from '../context'

function normalizeAccountId(value?: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

function isIgnoredAccountName(value: string): boolean {
  const lowered = value.trim().toLowerCase()
  return !lowered ||
    lowered === 'xwechat_files' ||
    lowered === 'wechat files' ||
    lowered === 'all_users' ||
    lowered === 'backup' ||
    lowered === 'wmpf' ||
    lowered === 'app_data' ||
    lowered === 'filestorage' ||
    lowered === 'image' ||
    lowered === 'image2' ||
    lowered === 'msg' ||
    lowered === 'db_storage'
}

function isReasonableAccountId(value?: string): boolean {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  return !isIgnoredAccountName(trimmed)
}

function pushAccountIdCandidate(candidates: string[], value?: string): void {
  const raw = String(value || '').trim()
  if (!isReasonableAccountId(raw)) return

  const pushUnique = (item: string) => {
    const trimmed = item.trim()
    if (!trimmed || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }

  pushUnique(raw)
  const normalized = normalizeAccountId(raw)
  if (normalized && normalized !== raw && isReasonableAccountId(normalized)) {
    pushUnique(normalized)
  }
}

function collectTargetWxids(userDir: string): string[] {
  const candidates: string[] = []
  let cursor = String(userDir || '').replace(/[\\/]+$/, '')

  for (let i = 0; cursor && i < 5; i++) {
    pushAccountIdCandidate(candidates, basename(cursor))
    const next = dirname(cursor)
    if (!next || next === cursor) break
    cursor = next
  }

  return candidates
}

function isImageKeyAccountDirPath(dirPath: string): boolean {
  return existsSync(join(dirPath, 'FileStorage', 'Image')) ||
    existsSync(join(dirPath, 'FileStorage', 'Image2')) ||
    existsSync(join(dirPath, 'msg', 'attach')) ||
    existsSync(join(dirPath, 'db_storage'))
}

function resolveImageKeyUserDir(userDir: string): string {
  const normalized = String(userDir || '').trim().replace(/[\\/]+$/, '')
  if (!normalized) return userDir
  if (existsSync(normalized)) return normalized

  const targetWxids = collectTargetWxids(normalized)
  const targetLower = targetWxids.map(wxid => normalizeAccountId(wxid).toLowerCase()).filter(Boolean)
  const parent = dirname(normalized)
  if (!parent || parent === normalized || !existsSync(parent)) return normalized

  const parentName = normalizeAccountId(basename(parent)).toLowerCase()
  if (targetLower.includes(parentName) && isImageKeyAccountDirPath(parent)) {
    return parent
  }

  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const normalizedEntry = normalizeAccountId(entry.name).toLowerCase()
      if (!targetLower.includes(normalizedEntry)) continue
      const candidate = join(parent, entry.name)
      if (isImageKeyAccountDirPath(candidate)) return candidate
    }
  } catch {
    // ignore
  }

  return normalized
}

/**
 * 图片、图片密钥和视频 IPC。
 * imageKey:progress 与 video:downloadProgress 是前端进度条依赖的事件边界。
 */
export function registerMediaHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('imageDecrypt:batchDetectXorKey', async (_, dirPath: string) => {
    try {
      const key = await imageDecryptService.batchDetectXorKey(dirPath)
      return { success: true, key }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('imageDecrypt:decryptImage', async (_, inputPath: string, outputPath: string, xorKey: number, aesKey?: string) => {
    try {
      ctx.getLogService()?.info('ImageDecrypt', '开始解密图片', { inputPath, outputPath })
      await imageDecryptService.decryptToFile(inputPath, outputPath, xorKey, aesKey)
      ctx.getLogService()?.info('ImageDecrypt', '图片解密成功', { outputPath })
      return { success: true }
    } catch (e) {
      ctx.getLogService()?.error('ImageDecrypt', '图片解密失败', { inputPath, error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 新的图片解密 API（来自 WeFlow）
  ipcMain.handle('image:decrypt', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; force?: boolean; quick?: boolean }) => {
    const result = await imageDecryptService.decryptImage(payload)
    if (!result.success) {
      ctx.getLogService()?.error('ImageDecrypt', '图片解密失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:resolveCache', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }) => {
    const result = await imageDecryptService.resolveCachedImage(payload)
    if (!result.success) {
      ctx.getLogService()?.warn('ImageDecrypt', '图片缓存解析失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:prewarm', async (_, payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) => {
    return imageDecryptService.prewarmImages(payloads, { limit: 40, concurrency: 2 })
  })

  ipcMain.handle('image:batchDecrypt', async (event, payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) => {
    return imageDecryptService.batchDecryptImages(payloads, {
      concurrency: 2,
      onProgress: (progress) => {
        event.sender.send('image:batchDecryptProgress', progress)
      }
    })
  })

  ipcMain.handle('image:countThumbnails', async () => {
    return imageDecryptService.countThumbnails()
  })

  ipcMain.handle('image:deleteThumbnails', async () => {
    return imageDecryptService.deleteThumbnails()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, rawContent?: string) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5, rawContent)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:readFile', async (_, videoPath: string) => {
    try {
      if (!existsSync(videoPath)) {
        return { success: false, error: '视频文件不存在' }
      }
      // 视频文件可能很大，必须异步读取，避免阻塞主进程事件循环。
      const buffer = await readFile(videoPath)
      const base64 = buffer.toString('base64')
      return { success: true, data: `data:video/mp4;base64,${base64}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 视频号相关
  ipcMain.handle('video:parseChannelVideo', async (_, content: string) => {
    try {
      const videoInfo = videoService.parseChannelVideoFromXml(content)
      return { success: true, videoInfo }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:downloadChannelVideo', async (event, videoInfo: any, key?: string) => {
    try {
      const result = await videoService.downloadChannelVideo(
        videoInfo,
        key,
        (progress) => {
          // 发送进度更新到渲染进程
          event.sender.send('video:downloadProgress', {
            objectId: videoInfo.objectId,
            ...progress
          })
        }
      )
      return result
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  })

  // 图片密钥获取：Windows 使用 Rust native 内存扫描，macOS 保留 kvcomm / 内存扫描链路。
  ipcMain.handle('imageKey:getImageKeys', async (event, userDir: string) => {
    const resolvedUserDir = resolveImageKeyUserDir(userDir)
    ctx.getLogService()?.info('ImageKey', '开始获取图片密钥', { userDir, resolvedUserDir })
    if (process.platform === 'darwin') {
      try {
        const kvcommResult = await wxKeyServiceMac.autoGetImageKey(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (kvcommResult.success) {
          ctx.getLogService()?.info('ImageKey', 'macOS kvcomm 图片密钥获取成功', {
            xorKey: kvcommResult.xorKey,
            aesKey: kvcommResult.aesKey
          })
          return kvcommResult
        }

        ctx.getLogService()?.warn('ImageKey', 'macOS kvcomm 方案失败，切换内存扫描', { error: kvcommResult.error })
        event.sender.send('imageKey:progress', 'kvcomm 方案失败，正在尝试内存扫描...')

        const scanResult = await wxKeyServiceMac.autoGetImageKeyByMemoryScan(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (scanResult.success) {
          ctx.getLogService()?.info('ImageKey', 'macOS 内存扫描图片密钥获取成功', {
            xorKey: scanResult.xorKey,
            aesKey: scanResult.aesKey
          })
        } else {
          ctx.getLogService()?.error('ImageKey', 'macOS 图片密钥获取失败', { error: scanResult.error })
        }

        return scanResult
      } catch (e) {
        ctx.getLogService()?.error('ImageKey', 'macOS 图片密钥获取异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      const wechatPid = wxKeyService.getWeChatPid()
      if (!wechatPid) {
        ctx.getLogService()?.info('ImageKey', '未检测到微信进程，无法执行 Rust 内存扫描')
        return {
          success: false,
          error: '获取图片密钥失败：未检测到微信进程。请登录微信并打开几张图片后重试。'
        }
      }

      event.sender.send('imageKey:progress', '正在通过 Rust 内存扫描获取图片密钥...')
      const memResult = await imageKeyService.getImageKeys(
        resolvedUserDir,
        (msg) => event.sender.send('imageKey:progress', msg)
      )
      if (memResult.success) {
        ctx.getLogService()?.info('ImageKey', '图片密钥获取成功（Rust 内存扫描）', {
          xorKey: memResult.xorKey,
          aesKey: memResult.aesKey
        })
        return memResult
      }

      ctx.getLogService()?.warn('ImageKey', 'Rust 内存扫描图片密钥失败', { error: memResult.error })

      return {
        success: false,
        error: memResult.error || '获取图片密钥失败：Rust 内存扫描未命中。请确保微信已登录并查看过图片后重试。'
      }
    } catch (e) {
      ctx.getLogService()?.error('ImageKey', '图片密钥获取异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 聊天相关

}
