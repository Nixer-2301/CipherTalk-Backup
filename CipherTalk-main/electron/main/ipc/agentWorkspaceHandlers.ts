import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { codeWorkspaceService } from '../../services/agent/codeWorkspaceService'

export function registerAgentWorkspaceHandlers(ctx: MainProcessContext): void {
  codeWorkspaceService.setContext(ctx)

  ipcMain.handle('agentWorkspace:selectWorkspace', async () => {
    return codeWorkspaceService.selectWorkspace()
  })

  ipcMain.handle('agentWorkspace:clearWorkspace', async () => {
    try {
      const state = await codeWorkspaceService.clearWorkspace()
      return { success: true, state }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:stopDevServer', async () => {
    try {
      await codeWorkspaceService.ensureWorkspaceInitialized()
      const result = await codeWorkspaceService.handleToolCall({ method: 'stop_dev_server' })
      return { success: true, result, state: codeWorkspaceService.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:getState', async () => {
    try {
      await codeWorkspaceService.ensureWorkspaceInitialized()
      return { success: true, state: codeWorkspaceService.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:setApprovalPolicy', async (_event, policy: unknown) => {
    try {
      const normalized = policy === 'risk-based' || policy === 'full-access' ? policy : 'on-request'
      const state = await codeWorkspaceService.setApprovalPolicy(normalized)
      return { success: true, state }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:listFiles', async (_event, payload: unknown) => {
    try {
      return await codeWorkspaceService.listFilesForUi(payload && typeof payload === 'object' ? payload as Record<string, unknown> : {})
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:approve', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.approve(String(requestId || '')) }
  })

  ipcMain.handle('agentWorkspace:reject', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.reject(String(requestId || '')) }
  })
}
