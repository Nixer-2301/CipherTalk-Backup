// Electron IPC 通信封装

// 配置
export const config = {
  get: (key: string) => window.electronAPI.config.get(key),
  set: (key: string, value: unknown) => window.electronAPI.config.set(key, value)
}

export const accounts = {
  list: () => window.electronAPI.accounts.list(),
  getActive: () => window.electronAPI.accounts.getActive(),
  setActive: (accountId: string) => window.electronAPI.accounts.setActive(accountId),
  save: (profile: Parameters<typeof window.electronAPI.accounts.save>[0]) => window.electronAPI.accounts.save(profile),
  update: (accountId: string, patch: Parameters<typeof window.electronAPI.accounts.update>[1]) => window.electronAPI.accounts.update(accountId, patch),
  delete: (accountId: string, deleteLocalData?: boolean) => window.electronAPI.accounts.delete(accountId, deleteLocalData)
}

// 数据库
export const db = {
  open: (dbPath: string, key?: string) => window.electronAPI.db.open(dbPath, key),
  query: <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> =>
    window.electronAPI.db.query(sql, params),
  close: () => window.electronAPI.db.close()
}

// 对话框
export const dialog = {
  openFile: (options?: Electron.OpenDialogOptions) => 
    window.electronAPI.dialog.openFile(options),
  saveFile: (options?: Electron.SaveDialogOptions) => 
    window.electronAPI.dialog.saveFile(options)
}

// 窗口控制
export const windowControl = {
  minimize: () => window.electronAPI.window.minimize(),
  maximize: () => window.electronAPI.window.maximize(),
  close: () => window.electronAPI.window.close()
}
