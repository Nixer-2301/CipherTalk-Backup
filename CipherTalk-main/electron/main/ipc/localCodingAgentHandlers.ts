import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { localCodingAgentService } from '../../services/localCodingAgent/localCodingAgentService'
import type { LocalCodingAgentRunInput } from '../../services/localCodingAgent/types'

export function registerLocalCodingAgentHandlers(ctx: MainProcessContext): void {
  localCodingAgentService.setContext(ctx)

  ipcMain.handle('localCodingAgent:getConfig', async () => {
    try {
      return { success: true, config: localCodingAgentService.getConfig() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:setConfig', async (_event, payload: unknown) => {
    try {
      return { success: true, config: localCodingAgentService.setConfig(payload) }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:detect', async () => {
    try {
      return { success: true, results: await localCodingAgentService.detect() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:run', async (_event, payload: LocalCodingAgentRunInput) => {
    try {
      return await localCodingAgentService.run(payload)
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:cancel', async (_event, jobId: string) => {
    try {
      return localCodingAgentService.cancel(String(jobId || ''))
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:applyPatch', async (_event, jobId: string) => {
    try {
      return await localCodingAgentService.applyPatch(String(jobId || ''))
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('localCodingAgent:discardPatch', async (_event, jobId: string) => {
    try {
      return await localCodingAgentService.discardPatch(String(jobId || ''))
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })
}

