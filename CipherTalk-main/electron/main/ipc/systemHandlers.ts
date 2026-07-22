import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { getUserDataPath } from '../../services/runtimePaths'

const HOME_BACKGROUND_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const HOME_BACKGROUND_VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg'])
const MAX_HOME_BACKGROUND_BYTES = 100 * 1000 * 1000

function resolveHomeBackgroundMediaType(ext: string): 'image' | 'video' | null {
  if (HOME_BACKGROUND_IMAGE_EXTS.has(ext)) return 'image'
  if (HOME_BACKGROUND_VIDEO_EXTS.has(ext)) return 'video'
  return null
}

function clearPreviousHomeBackgrounds(dir: string, keepPath: string): void {
  if (!fs.existsSync(dir)) return
  const resolvedKeepPath = path.resolve(keepPath)
  for (const name of fs.readdirSync(dir)) {
    const itemPath = path.join(dir, name)
    if (name.startsWith('custom-background.') && path.resolve(itemPath) !== resolvedKeepPath) {
      fs.rmSync(itemPath, { force: true })
    }
  }
}

export function registerSystemHandlers(): void {
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  ipcMain.handle('file:delete', async (_, filePath: string) => {
    try {
      const fs = await import('fs')
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        return { success: true }
      }
      return { success: false, error: '文件不存在' }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:copy', async (_, sourcePath: string, destPath: string) => {
    try {
      const fs = await import('fs')
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: '源文件不存在' }
      }
      fs.copyFileSync(sourcePath, destPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:importHomeBackground', async (_, sourcePath: string) => {
    try {
      const source = String(sourcePath || '').trim()
      if (!source) {
        return { success: false, error: '未选择文件' }
      }
      if (!fs.existsSync(source)) {
        return { success: false, error: '文件不存在' }
      }
      const sourceStat = fs.statSync(source)
      if (sourceStat.size > MAX_HOME_BACKGROUND_BYTES) {
        return { success: false, error: '背景文件不能超过 100MB' }
      }

      const ext = path.extname(source).toLowerCase()
      const mediaType = resolveHomeBackgroundMediaType(ext)
      if (!mediaType) {
        return { success: false, error: '仅支持 JPG、PNG、WebP、GIF、MP4、WebM、OGG 文件' }
      }

      const targetDir = path.join(getUserDataPath(), 'home-background')
      fs.mkdirSync(targetDir, { recursive: true })
      const targetPath = path.join(targetDir, `custom-background${ext}`)

      if (path.resolve(source) !== path.resolve(targetPath)) {
        fs.copyFileSync(source, targetPath)
      }
      clearPreviousHomeBackgrounds(targetDir, targetPath)

      return {
        success: true,
        path: targetPath,
        url: `${pathToFileURL(targetPath).toString()}?v=${Date.now()}`,
        mediaType
      }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle('file:writeBase64', async (_, filePath: string, base64Data: string) => {
    try {
      const fs = await import('fs')
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    return shell.openExternal(url)
  })

  ipcMain.handle('shell:showItemInFolder', async (_, fullPath: string) => {
    const { shell } = await import('electron')
    const targetPath = String(fullPath || '').trim()
    if (!targetPath) {
      throw new Error('路径为空')
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`文件不存在: ${targetPath}`)
    }
    return shell.showItemInFolder(targetPath)
  })
}
