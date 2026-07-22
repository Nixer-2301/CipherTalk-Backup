import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type NavLayout = 'sidebar' | 'dock'
export type HomeBackgroundSource = 'preset' | 'custom'
export type HomeBackgroundMediaType = 'image' | 'video' | ''

const publicAsset = (fileName: string): string => `${import.meta.env.BASE_URL}${fileName}`
const cacheThemeMode = (mode: ThemeMode): void => {
  try {
    window.localStorage.setItem('themeMode', mode)
  } catch {
    // localStorage may be unavailable in restricted contexts.
  }
}

export const HOME_BACKGROUND_PRESETS = [
  { id: 'beijing', label: '默认背景', description: '原始预设视频', src: publicAsset('beijing.mp4'), poster: publicAsset('beijing.jpg') },
  { id: 'beijing2', label: '备用背景', description: '新增预设视频', src: publicAsset('beijing2.mp4'), poster: publicAsset('beijing2.jpg') }
] as const
export type HomeBackgroundPreset = typeof HOME_BACKGROUND_PRESETS[number]['id']

export interface HomeBackgroundSettings {
  source: HomeBackgroundSource
  preset: HomeBackgroundPreset
  customType: HomeBackgroundMediaType
  customPath: string
  customUrl: string
  blur: number
}

interface ThemeState {
  themeMode: ThemeMode
  navLayout: NavLayout
  dockAutoHide: boolean
  homeGlassBall: boolean
  homeBackground: HomeBackgroundSettings
  isLoaded: boolean
  setThemeMode: (mode: ThemeMode) => void
  setNavLayout: (layout: NavLayout) => void
  setDockAutoHide: (v: boolean) => void
  setHomeGlassBall: (v: boolean) => void
  setHomeBackgroundSource: (source: HomeBackgroundSource) => void
  setHomeBackgroundPreset: (preset: HomeBackgroundPreset) => void
  setHomeBackgroundCustom: (payload: {
    type: Exclude<HomeBackgroundMediaType, ''>
    path: string
    url: string
  }) => void
  setHomeBackgroundBlur: (blur: number) => void
  toggleThemeMode: () => void
  loadTheme: () => Promise<void>
}

const DEFAULT_HOME_BACKGROUND: HomeBackgroundSettings = {
  source: 'preset',
  preset: 'beijing',
  customType: '',
  customPath: '',
  customUrl: '',
  blur: 0
}

export const normalizeHomeBackgroundPreset = (value: unknown): HomeBackgroundPreset => {
  return HOME_BACKGROUND_PRESETS.some((preset) => preset.id === value)
    ? value as HomeBackgroundPreset
    : 'beijing'
}

export const getHomeBackgroundPresetSrc = (value: unknown): string => {
  const preset = normalizeHomeBackgroundPreset(value)
  return HOME_BACKGROUND_PRESETS.find((item) => item.id === preset)?.src || publicAsset('beijing.mp4')
}

export const getHomeBackgroundPresetPoster = (value: unknown): string => {
  const preset = normalizeHomeBackgroundPreset(value)
  return HOME_BACKGROUND_PRESETS.find((item) => item.id === preset)?.poster || publicAsset('beijing.jpg')
}

const clampHomeBackgroundBlur = (value: unknown): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(30, Math.round(n)))
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  themeMode: 'system',
  navLayout: 'sidebar',
  dockAutoHide: true,
  homeGlassBall: true,
  homeBackground: DEFAULT_HOME_BACKGROUND,
  isLoaded: false,

  setThemeMode: async (mode) => {
    set({ themeMode: mode })
    cacheThemeMode(mode)
    try {
      await window.electronAPI.config.set('themeMode', mode)
    } catch (e) {
      console.error('保存主题模式失败:', e)
    }
  },

  setNavLayout: async (layout) => {
    set({ navLayout: layout })
    try {
      await window.electronAPI.config.set('navLayout', layout)
    } catch (e) {
      console.error('保存导航布局失败:', e)
    }
  },

  setDockAutoHide: async (v) => {
    set({ dockAutoHide: v })
    try {
      await window.electronAPI.config.set('dockAutoHide', v)
    } catch (e) {
      console.error('保存 Dock 自动收起失败:', e)
    }
  },

  setHomeGlassBall: async (v) => {
    set({ homeGlassBall: v })
    try {
      await window.electronAPI.config.set('homeGlassBall', v)
    } catch (e) {
      console.error('保存首页玻璃球开关失败:', e)
    }
  },

  setHomeBackgroundSource: async (source) => {
    set((state) => ({
      homeBackground: { ...state.homeBackground, source }
    }))
    try {
      await window.electronAPI.config.set('homeBackgroundSource', source)
    } catch (e) {
      console.error('保存首页背景来源失败:', e)
    }
  },

  setHomeBackgroundPreset: async (value) => {
    const preset = normalizeHomeBackgroundPreset(value)
    set((state) => ({
      homeBackground: { ...state.homeBackground, source: 'preset', preset }
    }))
    try {
      await Promise.all([
        window.electronAPI.config.set('homeBackgroundSource', 'preset'),
        window.electronAPI.config.set('homeBackgroundPreset', preset)
      ])
    } catch (e) {
      console.error('保存首页预设背景失败:', e)
    }
  },

  setHomeBackgroundCustom: async ({ type, path, url }) => {
    set((state) => ({
      homeBackground: {
        ...state.homeBackground,
        source: 'custom',
        customType: type,
        customPath: path,
        customUrl: url
      }
    }))
    try {
      await Promise.all([
        window.electronAPI.config.set('homeBackgroundSource', 'custom'),
        window.electronAPI.config.set('homeBackgroundCustomType', type),
        window.electronAPI.config.set('homeBackgroundCustomPath', path),
        window.electronAPI.config.set('homeBackgroundCustomUrl', url)
      ])
    } catch (e) {
      console.error('保存首页自定义背景失败:', e)
    }
  },

  setHomeBackgroundBlur: async (value) => {
    const blur = clampHomeBackgroundBlur(value)
    set((state) => ({
      homeBackground: { ...state.homeBackground, blur }
    }))
    try {
      await window.electronAPI.config.set('homeBackgroundBlur', blur)
    } catch (e) {
      console.error('保存首页背景模糊度失败:', e)
    }
  },

  toggleThemeMode: () => {
    const newMode = get().themeMode === 'light' ? 'dark' : 'light'
    get().setThemeMode(newMode)
  },

  loadTheme: async () => {
    try {
      const themeMode = await window.electronAPI.config.get('themeMode') as ThemeMode | undefined
      let navLayout = await window.electronAPI.config.get('navLayout') as NavLayout | undefined
      const dockAutoHide = await window.electronAPI.config.get('dockAutoHide') as boolean | undefined
      const homeGlassBall = await window.electronAPI.config.get('homeGlassBall') as boolean | undefined
      const homeBackgroundSource = await window.electronAPI.config.get('homeBackgroundSource') as HomeBackgroundSource | undefined
      const homeBackgroundCustomType = await window.electronAPI.config.get('homeBackgroundCustomType') as HomeBackgroundMediaType | undefined
      const homeBackgroundCustomPath = await window.electronAPI.config.get('homeBackgroundCustomPath') as string | undefined
      const homeBackgroundCustomUrl = await window.electronAPI.config.get('homeBackgroundCustomUrl') as string | undefined
      const homeBackgroundPreset = await window.electronAPI.config.get('homeBackgroundPreset') as HomeBackgroundPreset | undefined
      const homeBackgroundBlur = await window.electronAPI.config.get('homeBackgroundBlur') as number | undefined
      const nextThemeMode: ThemeMode = themeMode === 'dark' || themeMode === 'light' ? themeMode : 'system'
      const nextHomeBackground: HomeBackgroundSettings = {
        source: homeBackgroundSource === 'custom' ? 'custom' : 'preset',
        preset: normalizeHomeBackgroundPreset(homeBackgroundPreset),
        customType: homeBackgroundCustomType === 'image' || homeBackgroundCustomType === 'video' ? homeBackgroundCustomType : '',
        customPath: typeof homeBackgroundCustomPath === 'string' ? homeBackgroundCustomPath : '',
        customUrl: typeof homeBackgroundCustomUrl === 'string' ? homeBackgroundCustomUrl : '',
        blur: clampHomeBackgroundBlur(homeBackgroundBlur)
      }

      // 一次性迁移：统一切换到左侧边栏布局（与窗口标题栏融为一体的微信式布局）
      const migrated = await window.electronAPI.config.get('navLayoutMigratedV7') as boolean | undefined
      if (!migrated) {
        navLayout = 'sidebar'
        try {
          await window.electronAPI.config.set('navLayout', 'sidebar')
          await window.electronAPI.config.set('navLayoutMigratedV7', true)
        } catch (e) {
          console.error('迁移导航布局失败:', e)
        }
      }

      set({
        themeMode: nextThemeMode,
        navLayout: navLayout || 'sidebar',
        dockAutoHide: dockAutoHide ?? true,
        homeGlassBall: homeGlassBall ?? true,
        homeBackground: nextHomeBackground,
        isLoaded: true
      })
      cacheThemeMode(nextThemeMode)
    } catch (e) {
      console.error('加载主题失败:', e)
      set({ isLoaded: true })
    }
  }
}))
