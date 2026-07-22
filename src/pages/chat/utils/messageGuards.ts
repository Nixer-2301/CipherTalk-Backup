import type { Message } from '../../../types/models'

export function isGroupChat(username: string): boolean {
  return username.includes('@chatroom')
}

export function isPatAppMessage(message: Message): boolean {
  const content = message.rawContent || message.parsedContent || ''
  if (!content) return false
  return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
}

export function isSystemMessage(message: Message): boolean {
  return message.localType === 10000 || isPatAppMessage(message)
}
