import { useEffect, useState } from 'react'
import { normalizeWindowPlatform, type WindowPlatform } from '../utils/windowChrome'

const getInitialPlatform = (): WindowPlatform => {
  if (typeof document === 'undefined') {
    return 'win32'
  }

  return normalizeWindowPlatform(document.documentElement.dataset.windowPlatform)
}

export function usePlatformInfo() {
  const [platform, setPlatform] = useState<WindowPlatform>(getInitialPlatform)

  useEffect(() => {
    let cancelled = false

    void window.electronAPI.app.getPlatformInfo().then((info) => {
      if (cancelled) return
      setPlatform(normalizeWindowPlatform(info.platform))
    }).catch(() => {
      // ignore
    })

    return () => {
      cancelled = true
    }
  }, [])

  return {
    platform,
    isMac: platform === 'darwin',
    isWindows: platform === 'win32',
    isLinux: platform === 'linux'
  }
}
