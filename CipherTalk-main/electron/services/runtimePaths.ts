import os from 'os'
import path from 'path'

function getElectronAppSafe(): any | null {
  try {
    const moduleName = 'electron'
    const requireFunc = eval('require') as NodeRequire
    const electronModule = requireFunc(moduleName)
    if (electronModule && typeof electronModule === 'object' && electronModule.app) {
      return electronModule.app
    }
  } catch {
    // ignore
  }
  return null
}

export function getUserDataPath(): string {
  const app = getElectronAppSafe()
  if (app?.getPath) {
    return app.getPath('userData')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CipherTalk')
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'ciphertalk')
}

export function getCipherTalkCodexHome(): string {
  const override = String(process.env.CIPHERTALK_CODEX_HOME || '').trim()
  return override || path.join(getUserDataPath(), 'codex-subscription')
}

export function getAppDataPath(): string {
  const app = getElectronAppSafe()
  if (app?.getPath) {
    return app.getPath('appData')
  }

  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

export function getDocumentsPath(): string {
  const app = getElectronAppSafe()
  if (app?.getPath) {
    return app.getPath('documents')
  }

  return path.join(os.homedir(), 'Documents')
}

export function getExePath(): string {
  const app = getElectronAppSafe()
  if (app?.getPath) {
    return app.getPath('exe')
  }

  return process.execPath
}

export function getTempPath(): string {
  const app = getElectronAppSafe()
  if (app?.getPath) {
    return app.getPath('temp')
  }

  return os.tmpdir()
}

export function getAppPath(): string {
  const app = getElectronAppSafe()
  if (app?.getAppPath) {
    return app.getAppPath()
  }

  return process.cwd()
}

export function isElectronPackaged(): boolean {
  const app = getElectronAppSafe()
  if (typeof app?.isPackaged === 'boolean') {
    return app.isPackaged
  }

  return !process.env.VITE_DEV_SERVER_URL
}

export function getAppVersion(): string {
  const app = getElectronAppSafe()
  if (app?.getVersion) {
    return app.getVersion()
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json')
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
