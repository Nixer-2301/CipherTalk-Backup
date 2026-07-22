import { create } from 'zustand'
import type { PluginInfo } from '../types/electron'

interface PluginState {
  plugins: PluginInfo[]
  devModeEnabled: boolean
  loaded: boolean
  refresh: () => Promise<void>
}

/** 插件列表全局状态：Sidebar / 设置页 / PluginHost 共用，plugin:changed 时刷新 */
export const usePluginStore = create<PluginState>((set) => ({
  plugins: [],
  devModeEnabled: false,
  loaded: false,
  refresh: async () => {
    try {
      const result = await window.electronAPI.plugin.list()
      set({ plugins: result.plugins, devModeEnabled: result.devModeEnabled, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
}))

let subscribed = false

/** 首次调用时拉取插件列表并订阅变更广播（幂等） */
export function ensurePluginStoreSubscribed(): void {
  if (subscribed) return
  subscribed = true
  const { refresh } = usePluginStore.getState()
  void refresh()
  window.electronAPI.plugin.onChanged(() => { void refresh() })
}

/** 已启用插件的某类贡献点（声明式数据，渲染不执行插件代码） */
export function selectEnabledPlugins(plugins: PluginInfo[]): PluginInfo[] {
  return plugins.filter((p) => p.enabled && !p.error)
}
