export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  displayName?: string
  avatarUrl?: string
  isWeCom?: boolean
  weComCorp?: string
  isPinned?: boolean      // 置顶: contact.flag 第 11 位 (0x800)
  isCollapsed?: boolean   // 折叠的群聊: contact.flag 第 28 位 (0x10000000)
  isFoldGroup?: boolean   // 折叠的聊天聚合虚拟会话 (@placeholder_foldgroup)
  isOfficialFolder?: boolean  // 公众号聚合虚拟会话 (brandsessionholder)
  isOfficialAccount?: boolean // 单个公众号 (gh_ 开头)
}

export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
  isWeCom?: boolean
  weComCorp?: string
  lastContactTime?: number
}

export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  // 表情包相关
  emojiCdnUrl?: string
  emojiMd5?: string
  emojiLocalPath?: string  // 本地缓存路径
  // 引用消息相关
  quotedContent?: string
  quotedSender?: string
  quotedImageMd5?: string
  quotedEmojiMd5?: string
  quotedEmojiCdnUrl?: string
  // 图片相关
  imageMd5?: string
  imageDatName?: string
  isLivePhoto?: boolean  // 是否为实况照片
  // 视频相关
  videoMd5?: string
  videoDuration?: number  // 视频时长（秒）
  voiceDuration?: number  // 语音时长（秒）
  // 商店表情相关
  productId?: string
  // 文件消息相关
  fileName?: string       // 文件名
  fileSize?: number       // 文件大小（字节）
  fileExt?: string        // 文件扩展名
  fileMd5?: string        // 文件 MD5
  chatRecordList?: ChatRecordItem[] // 聊天记录列表 (Type 19)
  // 转账消息相关
  transferPayerUsername?: string    // 转账付款方 wxid
  transferReceiverUsername?: string // 转账收款方 wxid
}

export interface ChatLabSourceMessage {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  chatRecordList?: ChatRecordItem[]
}

export interface ChatRecordItem {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  // 媒体信息
  dataurl?: string
  datathumburl?: string
  datacdnurl?: string
  qaeskey?: string
  aeskey?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  thumbheadurl?: string
  duration?: number
}

export interface Contact {
  username: string
  alias: string
  remark: string
  nickName: string
}

export function compareMessageCursorAsc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  const aSortSeq = Number(a.sortSeq || 0)
  const bSortSeq = Number(b.sortSeq || 0)
  if (aSortSeq > 0 && bSortSeq > 0 && aSortSeq !== bSortSeq) {
    return aSortSeq - bSortSeq
  }
  return Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
    || aSortSeq - bSortSeq
}

export function compareMessageCursorDesc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return compareMessageCursorAsc(b, a)
}

export function messageIdentityKey(msg: Pick<Message, 'serverId' | 'localId' | 'createTime' | 'sortSeq'>): string {
  return `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
}
