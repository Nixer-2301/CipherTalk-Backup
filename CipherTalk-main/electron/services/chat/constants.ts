import type { ContactInfo } from './types'

const SYSTEM_CONTACT_USERNAMES = new Set([
  'filehelper',
  'fmessage',
  'floatbottle',
  'medianote',
  'newsapp',
  'qmessage',
  'qqmail',
  'weixin',
  'brandsessionholder',
  'brandservicesessionholder',
  'notifymessage',
  'opencustomerservicemsg',
  'notification_messages',
  'userexperience_alarm'
])

export function isSystemContactUsername(username: string): boolean {
  const lower = username.trim().toLowerCase()
  const normalized = lower.replace(/^@+/, '')
  if (!lower) return true
  if (SYSTEM_CONTACT_USERNAMES.has(lower) || SYSTEM_CONTACT_USERNAMES.has(normalized)) return true
  return lower.startsWith('fake_') || normalized.startsWith('fake_') || lower.includes('@kefu.openim') || lower.includes('service_')
}

export function detectContactInfoType(username: string, row: Record<string, any>): ContactInfo['type'] | null {
  const lower = username.trim().toLowerCase()
  if (isSystemContactUsername(lower)) return null
  if (lower.includes('@chatroom')) return 'group'
  if (lower.startsWith('gh_')) return 'official'

  const rawType = row.local_type ?? row.type
  const numericType = rawType === null || rawType === undefined || rawType === '' ? Number.NaN : Number(rawType)
  if (Number.isFinite(numericType) && numericType === 3) return 'official'

  // 不同微信版本的 contact.local_type 含义不稳定；普通个人号在排除系统号后应作为好友保留。
  return 'friend'
}

// 表情包缓存
export const emojiCache: Map<string, string> = new Map()
export const emojiDownloading: Map<string, Promise<string | null>> = new Map()

// 缓存过期时间（毫秒）
export const SESSION_TABLE_CACHE_DURATION = 60 * 1000  // 60秒，与原项目一致
