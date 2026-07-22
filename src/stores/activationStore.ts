import { create } from 'zustand'
import type { ActivationStatus } from '../types/electron'

interface ActivationState {
  status: ActivationStatus | null
  loading: boolean
  initialized: boolean
  
  // Actions
  checkStatus: () => Promise<ActivationStatus | null>
  clearCache: () => Promise<void>
  setStatus: (status: ActivationStatus | null) => void
}

export const useActivationStore = create<ActivationState>((set, get) => ({
  status: null,
  loading: false,
  initialized: false,

  checkStatus: async () => {
    set({ loading: true })
    try {
      const status = await window.electronAPI.activation.checkStatus()
      set({ status, initialized: true })
      return status
    } catch (e) {
      console.error('检查激活状态失败:', e)
      set({ initialized: true })
      return null
    } finally {
      set({ loading: false })
    }
  },

  clearCache: async () => {
    await window.electronAPI.activation.clearCache()
    // 重新检查状态
    await get().checkStatus()
  },

  setStatus: (status) => {
    set({ status })
  }
}))
