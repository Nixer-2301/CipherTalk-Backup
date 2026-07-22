import type { Message } from '../../../types/models'

export function getMessageDomKey(message: Message): string {
  return [
    message.serverId ?? '',
    message.localId ?? '',
    message.createTime ?? '',
    message.sortSeq ?? ''
  ].join('-')
}

export function getMessageDedupKey(message: Message): string {
  return `${message.serverId}-${message.localId}-${message.createTime}-${message.sortSeq}`
}
