import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Electron Worker 文件路径解析。
 * 开发态和打包态的 dist-electron 位置不同，所有主进程 Worker 都从这里统一查找，
 * 避免各个 IPC handler 自己拼路径导致 asar / asar.unpacked 场景不一致。
 */
export function findElectronWorkerPath(fileName: string): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app.asar', 'dist-electron', fileName),
        join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', fileName),
        join(process.resourcesPath, 'dist-electron', fileName),
        join(__dirname, '..', fileName),
        join(__dirname, fileName)
      ]
    : [
        join(__dirname, '..', fileName),
        join(__dirname, fileName),
        join(app.getAppPath(), 'dist-electron', fileName)
      ]

  return candidates.find((candidate) => existsSync(candidate)) || null
}
