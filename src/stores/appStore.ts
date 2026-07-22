import { create } from 'zustand'

export interface UserInfo {
  wxid: string
  nickName: string
  alias: string
  avatarUrl: string
}

export interface AppState {
  // 数据库状态
  isDbConnected: boolean
  dbPath: string | null
  myWxid: string | null

  // 用户信息（启动时预加载）
  userInfo: UserInfo | null
  userInfoLoaded: boolean

  // 加载状态
  isLoading: boolean
  loadingText: string

  // 解密进度
  isDecrypting: boolean
  decryptingDatabase: string
  decryptProgress: number
  decryptTotal: number

  // 操作
  setDbConnected: (connected: boolean, path?: string) => void
  setMyWxid: (wxid: string) => void
  setUserInfo: (info: UserInfo | null) => void
  setLoading: (loading: boolean, text?: string) => void
  setDecrypting: (decrypting: boolean, database?: string, progress?: number, total?: number) => void
  updateDecryptProgress: (progress: number, total?: number) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isDbConnected: false,
  dbPath: null,
  myWxid: null,
  userInfo: null,
  userInfoLoaded: false,
  isLoading: false,
  loadingText: '',
  isDecrypting: false,
  decryptingDatabase: '',
  decryptProgress: 0,
  decryptTotal: 0,

  setDbConnected: (connected, path) => set({
    isDbConnected: connected,
    dbPath: path ?? null
  }),

  setMyWxid: (wxid) => set({ myWxid: wxid }),

  setUserInfo: (info) => set({
    userInfo: info,
    userInfoLoaded: true
  }),

  setLoading: (loading, text) => set({
    isLoading: loading,
    loadingText: text ?? ''
  }),

  setDecrypting: (decrypting, database, progress, total) => set({
    isDecrypting: decrypting,
    decryptingDatabase: database ?? '',
    decryptProgress: progress ?? 0,
    decryptTotal: total ?? 0
  }),

  updateDecryptProgress: (progress, total) => set((state) => ({
    decryptProgress: progress,
    decryptTotal: total ?? state.decryptTotal
  })),

  reset: () => set({
    isDbConnected: false,
    dbPath: null,
    myWxid: null,
    userInfo: null,
    userInfoLoaded: false,
    isLoading: false,
    loadingText: '',
    isDecrypting: false,
    decryptingDatabase: '',
    decryptProgress: 0,
    decryptTotal: 0
  })
}))

