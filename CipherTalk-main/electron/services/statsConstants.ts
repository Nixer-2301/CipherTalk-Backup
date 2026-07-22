export interface StatsPartialError {
  dbName?: string
  dbPath?: string
  tableName?: string
  message: string
}

export const EXCLUDED_LOCAL_TYPES = [10000, 10002, 266287972401] as const

export const TEXT_LOCAL_TYPES = [1, 244813135921] as const

export const MAIN_MEDIA_TYPE_NAMES: Record<number, string> = {
  1: '文本',
  3: '图片',
  34: '语音',
  43: '视频',
  47: '表情包',
  49: '链接/文件',
}

export const SYSTEM_USERNAME_EXACT = new Set([
  'weixin',
  'qqmail',
  'fmessage',
  'medianote',
  'floatbottle',
  'newsapp',
  'brandsessionholder',
  'brandservicesessionholder',
  'notifymessage',
  'opencustomerservicemsg',
  'notification_messages',
  'weixinreminder',
  'masssendapp',
  'qqsync',
  'facebookapp',
  'feedsapp',
  'voip',
  'blogapp',
  'gmailapp',
  'linkedinplugin',
  'appbrand_notify_message',
  'appbrandcustomerservicemsg',
  'helper_folders',
  'placeholder_foldgroup',
  '@helper_folders',
  '@placeholder_foldgroup',
  'filehelper',
  'tmessage',
  'qmessage',
])

export const SYSTEM_USERNAME_PREFIXES = [
  'gh_',
  'service_',
]

export const SYSTEM_USERNAME_CONTAINS = [
  '@kefu.openim',
  '@app',
]

export const CHINESE_STOP_WORDS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '就是', '还是', '然后', '因为', '所以',
  '可以', '不是', '没有', '已经', '现在', '感觉', '觉得', '一下', '哈哈', '哈哈哈',
  '我们', '你们', '他们', '自己', '这样', '那样', '今天', '明天', '昨天', '时候',
  '真的', '可能', '应该', '不用', '不要', '不能', '知道', '看看', '起来', '出来',
])
