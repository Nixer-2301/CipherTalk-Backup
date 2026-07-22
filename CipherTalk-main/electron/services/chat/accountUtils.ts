import * as fs from 'fs'
import * as path from 'path'

/**
 * 清理账号目录名（支持 wxid_ 格式和自定义微信号格式）
 * 保留以兼容原来内部对 cleanedMyWxid 的使用语义
 */
export function cleanAccountDirName(dirName: string): string {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  // wxid_ 开头的标准格式: wxid_xxx_yyyy -> wxid_xxx
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
    if (match) return match[1]
    return trimmed
  }

  // 自定义微信号格式: xxx_yyyy (4位后缀) -> xxx
  // 例如: xiangchao1985_b29d -> xiangchao1985
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) return suffixMatch[1]

  return trimmed
}

/**
 * 查找账号对应的实际目录名（仅用于表情包/文件路径解析等非数据库场景）
 */
export function findAccountDir(baseDir: string, wxid: string): string | null {
  if (!fs.existsSync(baseDir)) return null

  const cleanedWxid = cleanAccountDirName(wxid)

  const directPath = path.join(baseDir, wxid)
  if (fs.existsSync(directPath)) {
    return wxid
  }

  if (cleanedWxid !== wxid) {
    const cleanedPath = path.join(baseDir, cleanedWxid)
    if (fs.existsSync(cleanedPath)) {
      return cleanedWxid
    }
  }

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dirName = entry.name
      const dirNameLower = dirName.toLowerCase()
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()

      if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) {
        return dirName
      }

      if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) {
        return dirName
      }

      if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) {
        return dirName
      }

      const cleanedDirName = cleanAccountDirName(dirName)
      if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) {
        return dirName
      }
    }
  } catch (e) {
    console.error('查找账号目录失败:', e)
  }

  return null
}

export function isOfficialFolderUsername(username: string): boolean {
  const lower = username.toLowerCase()
  return lower === 'brandsessionholder' || lower === '@brandsessionholder'
}

export function isOfficialAccountUsername(username: string): boolean {
  return username.startsWith('gh_')
}

export function shouldKeepSession(username: string): boolean {
  if (!username) return false
  if (isOfficialFolderUsername(username)) return true
  if (isOfficialAccountUsername(username)) return true

  // @placeholder_foldgroup 是微信"折叠的聊天"聚合虚拟会话，保留并由前端渲染

  const excludeList = [
    'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
    'newsapp', 'brandservicesessionholder',
    'notifymessage', 'opencustomerservicemsg', 'notification_messages',
    'userexperience_alarm'
  ]

  for (const prefix of excludeList) {
    if (username.startsWith(prefix) || username === prefix) return false
  }

  // 仅过滤微信客服（@kefu.openim），保留企业微信用户（@openim）以便在聊天列表显示并加标识
  if (username.includes('@kefu.openim')) return false
  if (username.includes('service_')) return false

  return true
}
