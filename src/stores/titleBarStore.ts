import { create } from 'zustand'
import { ReactNode } from 'react'

interface TitleBarState {
  title: string | null
  rightContent: ReactNode | null
  setTitle: (title: string | null) => void
  setRightContent: (content: ReactNode | null) => void
}

export const useTitleBarStore = create<TitleBarState>((set) => ({
  title: null,
  rightContent: null,
  setTitle: (title) => set({ title }),
  setRightContent: (content) => set({ rightContent: content })
}))
