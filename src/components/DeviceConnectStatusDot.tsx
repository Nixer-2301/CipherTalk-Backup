import { cn } from '../lib/utils'
import type { DeviceConnectStatus } from '../hooks/useDeviceConnectStatus'

const DOT_COLOR: Record<Exclude<DeviceConnectStatus, 'disconnected'>, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  error: 'bg-red-500',
}

/**
 * 设备连接状态小圆点：未连接时不渲染。位置/尺寸/描边由调用方用 className 决定
 * （侧边栏配 ring-background，Dock 因图标本身是绿色配 ring-white 以保证对比）。
 */
export function DeviceConnectStatusDot({ status, className }: { status: DeviceConnectStatus; className?: string }) {
  if (status === 'disconnected') return null
  return <span className={cn('block rounded-full', DOT_COLOR[status], className)} />
}
