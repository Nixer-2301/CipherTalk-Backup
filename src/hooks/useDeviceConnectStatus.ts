import { useEffect, useState } from 'react'

export type DeviceConnectStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * 订阅设备连接（当前为微信 bot 通道）的连接状态，供侧边栏/底部 Dock 常驻展示。
 * 复用 deviceConnect.wechat 的 getStatus + onStatus 广播，不额外开后端。
 */
export function useDeviceConnectStatus(): DeviceConnectStatus {
  const [status, setStatus] = useState<DeviceConnectStatus>('disconnected')

  useEffect(() => {
    const api = window.electronAPI?.deviceConnect?.wechat
    if (!api) return
    api.getStatus().then((s) => setStatus(s.status)).catch(() => undefined)
    return api.onStatus((s) => setStatus(s.status))
  }, [])

  return status
}
