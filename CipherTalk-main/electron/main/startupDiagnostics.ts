import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import type { App, BrowserWindow } from 'electron'

const LOG_DIR_NAME = 'ciphertalk'
const LOG_FILE_NAME = 'startup.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024

let processHandlersInstalled = false
let electronHandlersInstalled = false
let sequence = 0

function getLogDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, LOG_DIR_NAME)
}

export function getStartupDiagnosticsLogPath(): string {
  return path.join(getLogDir(), LOG_FILE_NAME)
}

function ensureLogFileReady(): void {
  const dir = getLogDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const logPath = getStartupDiagnosticsLogPath()
  if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
    const rotatedPath = `${logPath}.old`
    try {
      if (existsSync(rotatedPath)) {
        // Windows does not allow rename over an existing file.
        renameSync(rotatedPath, `${rotatedPath}.${Date.now()}`)
      }
      renameSync(logPath, rotatedPath)
    } catch {
      // If rotation fails, keep appending. Diagnostics must never block startup.
    }
  }
}

function toPlainError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }

  return {
    message: String(error)
  }
}

function serializeDetails(details: unknown): string {
  const seen = new WeakSet<object>()

  try {
    return JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) return toPlainError(value)
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    })
  } catch {
    return String(details)
  }
}

function writeStartupLine(level: 'info' | 'warn' | 'error', event: string, details?: unknown): void {
  try {
    ensureLogFileReady()
    sequence += 1

    const record = {
      ts: new Date().toISOString(),
      seq: sequence,
      pid: process.pid,
      level,
      event,
      details
    }
    appendFileSync(getStartupDiagnosticsLogPath(), `${serializeDetails(record)}\n`, 'utf8')
  } catch {
    // Startup diagnostics are best-effort only.
  }
}

export function markStartupMilestone(event: string, details?: unknown): void {
  writeStartupLine('info', event, details)
}

export function warnStartupMilestone(event: string, details?: unknown): void {
  writeStartupLine('warn', event, details)
}

export function logStartupError(event: string, error: unknown, details?: unknown): void {
  writeStartupLine('error', event, {
    ...(
      details && typeof details === 'object' && !Array.isArray(details)
        ? details as Record<string, unknown>
        : { details }
    ),
    error: toPlainError(error)
  })
}

function installProcessStartupDiagnostics(): void {
  if (processHandlersInstalled) return
  processHandlersInstalled = true

  process.on('uncaughtExceptionMonitor', (error) => {
    logStartupError('process:uncaughtException', error)
  })

  process.on('unhandledRejection', (reason) => {
    logStartupError('process:unhandledRejection', reason)
  })

  process.on('warning', (warning) => {
    warnStartupMilestone('process:warning', toPlainError(warning))
  })

  process.on('exit', (code) => {
    markStartupMilestone('process:exit', { code })
  })
}

export function installElectronStartupDiagnostics(app: App): void {
  if (electronHandlersInstalled) return
  electronHandlersInstalled = true

  app.on('render-process-gone', (_event, webContents, details) => {
    warnStartupMilestone('electron:render-process-gone', {
      id: webContents.id,
      url: webContents.getURL(),
      details
    })
  })

  app.on('child-process-gone', (_event, details) => {
    warnStartupMilestone('electron:child-process-gone', details)
  })

  app.on('gpu-info-update', () => {
    markStartupMilestone('electron:gpu-info-update')
  })
}

export function attachWindowStartupDiagnostics(win: BrowserWindow, label: string): void {
  try {
    markStartupMilestone('window:created', {
      label,
      id: win.id
    })

    win.once('closed', () => {
      markStartupMilestone('window:closed', {
        label,
        id: win.id
      })
    })

    win.webContents.once('did-finish-load', () => {
      markStartupMilestone('window:did-finish-load', {
        label,
        id: win.id,
        url: win.webContents.getURL()
      })
    })

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      warnStartupMilestone('window:did-fail-load', {
        label,
        id: win.id,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      })
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      warnStartupMilestone('window:render-process-gone', {
        label,
        id: win.id,
        url: win.webContents.getURL(),
        details
      })
    })

    win.on('unresponsive', () => {
      warnStartupMilestone('window:unresponsive', {
        label,
        id: win.id
      })
    })

    win.on('responsive', () => {
      markStartupMilestone('window:responsive', {
        label,
        id: win.id
      })
    })
  } catch (error) {
    logStartupError('window:diagnostics-install-failed', error, { label })
  }
}

installProcessStartupDiagnostics()
markStartupMilestone('startup-diagnostics:loaded', {
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  execPath: process.execPath
})
