import type { Message } from '../../types/models'

export const MOMENT_TEXT_TYPE = 1
export const MOMENT_IMAGE_TYPE = 3
export const MOMENT_VOICE_TYPE = 34
export const MOMENT_EMOJI_TYPE = 47

export interface RandomMomentSnippet {
  displayName: string
  avatarUrl: string
  sessionId: string
  message: Message
}

/**
 * 与聊天会话列表/气泡一致：走 getContactAvatar，包含 URL + head_image.db → base64 回退
 */
export async function resolveRandomMomentSender(
  msg: Message,
  sessionId: string,
  sessionDisplayName: string | undefined
): Promise<{ displayName: string; avatarUrl: string }> {
  const sender = (msg.senderUsername || '').trim()

  async function lookup(username: string): Promise<{ displayName: string; avatarUrl: string } | null> {
    if (!username) return null
    try {
      const r = await window.electronAPI.chat.getContactAvatar(username)
      if (!r) return null
      return {
        displayName: (r.displayName || username).trim(),
        avatarUrl: (r.avatarUrl || '').trim()
      }
    } catch {
      return null
    }
  }

  if (sender) {
    const fromSender = await lookup(sender)
    if (fromSender) {
      return {
        displayName: fromSender.displayName || sessionDisplayName || sender,
        avatarUrl: fromSender.avatarUrl
      }
    }
  }

  if (!sessionId.includes('@chatroom')) {
    const fromSession = await lookup(sessionId)
    if (fromSession) {
      return {
        displayName: fromSession.displayName || sessionDisplayName || sessionId,
        avatarUrl: fromSession.avatarUrl
      }
    }
    return {
      displayName: sessionDisplayName || sessionId,
      avatarUrl: ''
    }
  }

  return {
    displayName: sender || sessionDisplayName || '群成员',
    avatarUrl: ''
  }
}

/**
 * 从主进程拉取一条「私聊、对方发来、文/图/语/表」并解析展示用发送者信息。
 */
export async function loadRandomMomentSnippet(): Promise<{
  snippet: RandomMomentSnippet | null
  hint: string | null
}> {
  const res = await window.electronAPI.chat.pickRandomMomentFromIndex()
  if (!res.success || !res.message || !res.sessionId) {
    return { snippet: null, hint: res.hint || res.error || '暂无可展示的回忆' }
  }

  const sender = await resolveRandomMomentSender(res.message, res.sessionId, undefined)
  return {
    snippet: {
      displayName: sender.displayName,
      avatarUrl: sender.avatarUrl,
      sessionId: res.sessionId,
      message: res.message
    },
    hint: null
  }
}
