import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

export function registerDataHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('db:open', async (_, dbPath: string) => {
    return ctx.getDbService()?.open(dbPath)
  })

  ipcMain.handle('db:query', async (_, sql: string, params?: any[]) => {
    return ctx.getDbService()?.query(sql, params)
  })

  ipcMain.handle('db:close', async () => {
    return ctx.getDbService()?.close()
  })
}
