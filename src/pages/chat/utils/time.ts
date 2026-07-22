import type { Message } from '../../../types/models'

export function formatSessionTime(timestamp: number): string {
  if (!timestamp) return ''

  const now = Date.now()
  const msgTime = timestamp * 1000
  const diff = now - msgTime

  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`

  const date = new Date(msgTime)
  const nowDate = new Date()

  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function shouldShowDateDivider(msg: Message, prevMsg?: Message): boolean {
  if (!prevMsg) return true
  const date = new Date(msg.createTime * 1000).toDateString()
  const prevDate = new Date(prevMsg.createTime * 1000).toDateString()
  return date !== prevDate
}

export function formatDateDivider(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) return '今天'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

export function formatBatchDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${y}年${m}月${d}日`
}
