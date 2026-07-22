import { ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { appUpdateService } from '../../services/appUpdateService'
import type { MainProcessContext } from '../context'

/**
 * 应用更新下载与安装 IPC。
 * 这里维护“是否正在安装”的共享状态，并把下载进度继续广播给所有窗口。
  */
export function registerAppUpdateHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('app:downloadAndInstall', async () => {
    if (ctx.getIsInstallingUpdate()) {
      ctx.getLogService()?.warn('AppUpdate', '下载更新请求被忽略，当前已有下载任务进行中', {
        targetVersion: appUpdateService.getCachedUpdateInfo()?.version
      })
      return
    }

    ctx.setIsInstallingUpdate(true)
    const cachedUpdateInfo = appUpdateService.getCachedUpdateInfo()
    const targetVersion = cachedUpdateInfo?.version

    appUpdateService.updateDiagnostics({
      phase: 'downloading',
      targetVersion,
      lastError: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: undefined,
      lastEvent: targetVersion ? `开始下载更新 ${targetVersion}` : '开始下载更新'
    })
    ctx.getLogService()?.info('AppUpdate', '开始下载更新', { targetVersion, differentialEnabled: !autoUpdater.disableDifferentialDownload })

    // 开发模式：模拟下载进度，便于本地测试更新进度 UI（不真实下载、不触发安装）
    if (process.env.VITE_DEV_SERVER_URL) {
      await simulateDownloadProgress(ctx, targetVersion)
      ctx.setIsInstallingUpdate(false)
      return
    }

    const onDownloadProgress = (progress: ProgressInfo) => {
      const payload = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      ctx.broadcastToWindows('app:downloadProgress', payload)
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: progress.percent,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
        lastEvent: `下载中 ${progress.percent.toFixed(1)}%`
      })
    }

    const onUpdateDownloaded = () => {
      appUpdateService.updateDiagnostics({
        phase: 'downloaded',
        progressPercent: 100,
        lastEvent: '更新包下载完成，准备安装'
      })
      ctx.getLogService()?.info('AppUpdate', '更新包下载完成，准备安装', {
        targetVersion,
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
      ctx.appWithQuitFlag.isQuitting = true
      appUpdateService.updateDiagnostics({
        phase: 'installing',
        lastEvent: '开始调用安装器'
      })
      autoUpdater.quitAndInstall(false, true)
    }

    const onUpdaterError = (error: Error) => {
      ctx.setIsInstallingUpdate(false)
      appUpdateService.updateDiagnostics({
        phase: 'failed',
        lastError: String(error),
        lastEvent: '下载或安装更新失败'
      })
      ctx.getLogService()?.error('AppUpdate', '下载或安装更新失败', {
        targetVersion,
        error: String(error),
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
    }

    autoUpdater.on('download-progress', onDownloadProgress)
    autoUpdater.once('update-downloaded', onUpdateDownloaded)
    autoUpdater.once('error', onUpdaterError)

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      ctx.setIsInstallingUpdate(false)
      onUpdaterError(error as Error)
      throw error
    } finally {
      autoUpdater.removeListener('download-progress', onDownloadProgress)
      autoUpdater.removeListener('update-downloaded', onUpdateDownloaded)
      autoUpdater.removeListener('error', onUpdaterError)
    }
  })

}

/**
 * 开发模式专用：模拟下载进度广播，用于本地测试更新进度 UI。
 * 不真实下载安装包，也不触发 quitAndInstall。
 */
async function simulateDownloadProgress(ctx: MainProcessContext, targetVersion?: string): Promise<void> {
  const totalBytes = Math.round(179.5 * 1024 * 1024)
  let percent = 0

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      percent = Math.min(100, percent + Math.random() * 5 + 1.5)
      const transferred = Math.round((percent / 100) * totalBytes)
      const bytesPerSecond = Math.round(220 * 1024 + Math.random() * 400 * 1024)

      ctx.broadcastToWindows('app:downloadProgress', {
        percent,
        transferred,
        total: totalBytes,
        bytesPerSecond
      })
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: percent,
        downloadedBytes: transferred,
        totalBytes,
        lastEvent: `模拟下载中 ${percent.toFixed(1)}%`
      })

      if (percent >= 100) {
        clearInterval(timer)
        appUpdateService.updateDiagnostics({
          phase: 'downloaded',
          progressPercent: 100,
          lastEvent: '模拟更新下载完成（开发模式不执行安装）'
        })
        ctx.getLogService()?.info('AppUpdate', '模拟更新完成（开发模式）', { targetVersion })
        resolve()
      }
    }, 450)
  })
}
