import { ipcMain } from 'electron'
import { mcpClientService } from '../../services/mcpClientService'

export function registerMcpHandlers(): void {
  ipcMain.handle('mcpClient:listConfigs', async () => {
    return mcpClientService.listClientConfigs()
  })

  ipcMain.handle('mcpClient:saveConfig', async (_, name: string, config: any, overwrite?: boolean) => {
    return mcpClientService.saveClientConfig(name, config, Boolean(overwrite))
  })

  ipcMain.handle('mcpClient:deleteConfig', async (_, name: string) => {
    return mcpClientService.deleteClientConfig(name)
  })

  ipcMain.handle('mcpClient:connect', async (_, name: string) => {
    return mcpClientService.connectToServer(name)
  })

  ipcMain.handle('mcpClient:disconnect', async (_, name: string) => {
    return mcpClientService.disconnectFromServer(name)
  })

  ipcMain.handle('mcpClient:listTools', async (_, name: string) => {
    return mcpClientService.listToolsFromServer(name)
  })

  ipcMain.handle('mcpClient:callTool', async (_, name: string, toolName: string, args: any) => {
    return mcpClientService.callTool(name, toolName, args)
  })

  ipcMain.handle('mcpClient:listStatuses', async () => {
    return mcpClientService.listAllServerStatuses()
  })
}
