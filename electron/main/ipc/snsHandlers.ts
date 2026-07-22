import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

/**
 * 朋友圈 IPC。
 * 媒体下载、导出写文件和代理图片保持原 channel，snsService 仍按需动态加载。
 */
export function registerSnsHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('sns:getTimeline', async (_, limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => {
    try {
      const { snsService } = await import('../../services/snsService')
      const result = await snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)

      if (!result.success) {
        // 如果是 WCDB 未初始化错误，返回更友好的提示
        if (result.error?.includes('未初始化')) {
          ctx.getLogService()?.warn('SNS', '朋友圈功能需要先连接数据库')
          return {
            success: false,
            error: '请先在首页配置并连接数据库后再使用朋友圈功能'
          }
        }
        ctx.getLogService()?.warn('SNS', '获取朋友圈时间线失败', { error: result.error })
      }
      return result
    } catch (e: any) {
      ctx.getLogService()?.error('SNS', '获取朋友圈时间线异常', { error: e.message })
      return { success: false, error: `加载失败: ${e.message}` }
    }
  })

  ipcMain.handle('sns:proxyImage', async (_, params: { url: string; key?: string | number }) => {
    const { snsService } = await import('../../services/snsService')
    const result = await snsService.proxyImage(params.url, params.key)
    if (!result.success) {
      ctx.getLogService()?.warn('SNS', '代理朋友圈图片失败', { url: params.url, error: result.error })
    }
    return result
  })

  ipcMain.handle('sns:downloadEmoji', async (_, params: { url: string; encryptUrl?: string; aesKey?: string }) => {
    const { snsService } = await import('../../services/snsService')
    return snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
  })

  ipcMain.handle('sns:downloadImage', async (_, params: { url: string; key?: string | number }) => {
    const { snsService } = await import('../../services/snsService')
    const { dialog } = await import('electron')

    try {
      const result = await snsService.downloadImage(params.url, params.key)

      if (!result.success) {
        return { success: false, error: result.error }
      }

      // 弹出保存对话框
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存图片',
        defaultPath: `sns_image_${Date.now()}.jpg`,
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (canceled || !filePath) {
        return { success: false, error: '用户已取消' }
      }

      // 保存文件
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, result.data!)

      return { success: true }
    } catch (e: any) {
      ctx.getLogService()?.error('SNS', '下载朋友圈图片失败', { error: e.message })
      return { success: false, error: e.message }
    }
  })

  // 朋友圈导出写入文件
  ipcMain.handle('sns:writeExportFile', async (_, filePath: string, content: string) => {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      // 确保目录存在
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 将朋友圈媒体保存到导出目录
  ipcMain.handle('sns:saveMediaToDir', async (_, params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) => {
    try {
      const { snsService } = await import('../../services/snsService')
      const fs = await import('fs/promises')
      const path = await import('path')
      const crypto = await import('crypto')

      // 确保导出目录和 media 子目录存在
      const mediaDir = path.join(params.outputDir, 'media')
      await fs.mkdir(mediaDir, { recursive: true })

      // 生成基于内容的唯一文件名
      let baseName: string
      if (params.isAvatar && params.username) {
        // 头像：用 avatar_username
        baseName = `avatar_${params.username.replace(/[^a-zA-Z0-9_]/g, '_')}`
      } else if (params.isEmoji) {
        // 表情包：用 MD5（或者 encryptUrl/url 的 hash）加上 emoji 前缀
        const hashTarget = params.md5 || params.encryptUrl || params.url
        baseName = `emoji_${params.md5 || crypto.createHash('md5').update(hashTarget).digest('hex')}`
      } else if (params.md5) {
        // 有 MD5 直接使用
        baseName = params.md5
      } else {
        // 没有 MD5，用 URL 的 hash
        baseName = crypto.createHash('md5').update(params.url).digest('hex')
      }

      // 如果是表情包，走单独的下载接口
      if (params.isEmoji) {
        const result = await snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
        if (!result.success || !result.localPath) {
          return { success: false, error: result.error || '表情包下载失败' }
        }

        const ext = path.extname(result.localPath) || '.gif'
        const fileName = `${baseName}${ext}`
        const filePath = path.join(mediaDir, fileName)

        // 如果文件已存在则跳过
        try {
          await fs.access(filePath)
          return { success: true, fileName }
        } catch { }

        await fs.copyFile(result.localPath, filePath)
        return { success: true, fileName }
      }

      // 默认走下载并解密媒体，传入 md5 提高缓存命中率
      const result = await snsService.downloadImage(params.url, params.key, params.md5)

      if (!result.success) {
        return { success: false, error: result.error || '下载失败' }
      }

      // 根据 contentType 确定文件后缀
      let ext = '.jpg'
      if (result.contentType?.includes('png')) ext = '.png'
      else if (result.contentType?.includes('gif')) ext = '.gif'
      else if (result.contentType?.includes('webp')) ext = '.webp'
      else if (result.contentType?.includes('video')) ext = '.mp4'

      const fileName = `${baseName}${ext}`
      const filePath = path.join(mediaDir, fileName)

      // 如果文件已存在则跳过（避免重复下载）
      try {
        await fs.access(filePath)
        return { success: true, fileName }
      } catch {
        // 文件不存在，继续下载
      }

      if (result.data) {
        // 有二进制数据，直接写入
        await fs.writeFile(filePath, result.data)
      } else if (result.cachePath) {
        // 没有 data 但有缓存路径（视频已缓存的情况），复制缓存文件
        await fs.copyFile(result.cachePath, filePath)
      } else {
        return { success: false, error: '无可用数据' }
      }

      return { success: true, fileName }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 导出相关

}
