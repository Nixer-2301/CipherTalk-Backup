import { ipcMain, type WebContents } from 'electron'
import { getTtsConfig } from '../../services/ai/ttsService'
import { VolcengineRealtimeSession, type VolcengineRealtimeEvent } from '../../services/ai/volcengineRealtimeService'
import { personaStore } from '../../services/agent/persona/personaStore'

type RealtimeDialogContextItem = { role: 'user' | 'assistant'; text: string; timestamp?: number }
type RealtimeStartPayload = {
  callId: string
  sessionId: string
  dialogContext?: RealtimeDialogContextItem[]
}

type ActiveRealtimeSession = {
  ownerId: number
  owner: WebContents
  onOwnerDestroyed: () => void
  session: VolcengineRealtimeSession
}

const sessions = new Map<string, ActiveRealtimeSession>()

function detachOwnerListener(active: ActiveRealtimeSession): void {
  active.owner.removeListener('destroyed', active.onOwnerDestroyed)
}

function buildCharacterManifest(persona: ReturnType<typeof personaStore.get>): string {
  if (!persona) return ''
  const { card, profile, fewShots } = persona
  const lines = [
    `你就是${persona.displayName}本人，正在和熟悉的朋友打电话。不要承认或暗示自己是AI、模型或数字分身。`,
    `性格：${card.personalityTraits.join('、')}`,
    `语气：${card.tone}`,
    `标点和表达习惯：${card.punctuationStyle}`,
    card.addressing ? `对用户的称呼：${card.addressing}` : '',
    card.catchphrases.length ? `偶尔自然使用这些口头禅：${card.catchphrases.join('、')}` : '',
    card.topics.length ? `熟悉的话题：${card.topics.join('、')}` : '',
    card.ttsInstructions ? `声音表现：${card.ttsInstructions}` : '',
    profile?.relationship ? `你和用户的关系：${profile.relationship}` : '',
    ...(profile?.facts || []).slice(0, 12).map((fact) => `生活背景：${fact}`),
    ...(fewShots || []).slice(0, 6).map((sample) => `真实说话示例：对方说“${sample.user}”，你会说“${sample.replies.join(' ')}”`),
    '电话交流规则：用自然口语回答，句子不要太书面；根据对方内容正常接话，不要机械重复人设资料。',
  ]
  return lines.filter(Boolean).join('\n')
}

function sanitizeDialogContext(value: unknown): RealtimeDialogContextItem[] {
  if (!Array.isArray(value)) return []
  const items = value
    .map((item): RealtimeDialogContextItem | null => {
      if (!item || typeof item !== 'object') return null
      const role = (item as { role?: unknown }).role
      const text = String((item as { text?: unknown }).text || '').trim().slice(0, 2000)
      if ((role !== 'user' && role !== 'assistant') || !text) return null
      const timestamp = Number((item as { timestamp?: unknown }).timestamp || 0)
      return { role, text, ...(timestamp > 0 ? { timestamp } : {}) }
    })
    .filter((item): item is RealtimeDialogContextItem => Boolean(item))
    .slice(-40)

  const pairs: RealtimeDialogContextItem[] = []
  for (let i = 0; i + 1 < items.length; i += 1) {
    if (items[i].role === 'user' && items[i + 1].role === 'assistant') {
      pairs.push(items[i], items[i + 1])
      i += 1
    }
  }
  return pairs.slice(-40)
}

export function registerVoiceRealtimeHandlers(): void {
  ipcMain.handle('voice-realtime:start', async (event, payload: RealtimeStartPayload) => {
    const callId = String(payload?.callId || '').trim()
    const personaSessionId = String(payload?.sessionId || '').trim()
    if (!callId || !personaSessionId) return { success: false, error: '缺少实时通话标识或数字分身标识' }

    const previous = sessions.get(callId)
    if (previous) {
      detachOwnerListener(previous)
      await previous.session.close().catch(() => undefined)
      sessions.delete(callId)
    }

    const persona = personaStore.get(personaSessionId)
    if (!persona) return { success: false, error: '数字分身不存在，请先完成克隆' }

    const ttsConfig = getTtsConfig()
    const volcengine = ttsConfig.providers.volcengine
    const appId = String(volcengine.realtimeAppId || '').trim()
    const accessKey = String(volcengine.realtimeAccessKey || '').trim()
    if (!appId || !accessKey) {
      return { success: false, error: '请先在 TTS 设置的豆包服务中填写 Realtime App ID 和 Access Key' }
    }
    const personaSpeaker = persona.ttsVoice?.provider === 'volcengine' &&
      persona.ttsVoice.realtimeAppId === appId &&
      persona.ttsVoice.realtimeResourceId === 'seed-icl-2.0'
      ? String(persona.ttsVoice.voice || '').trim()
      : ''
    const configuredSpeaker = String(volcengine.voice || '').trim()
    const speaker = /^(S_|saturn_)/.test(personaSpeaker)
      ? personaSpeaker
      : configuredSpeaker
    if (!/^(S_|saturn_)/.test(speaker)) {
      return { success: false, error: '请在豆包 TTS 设置中选择兼容 SC2.0 的 S_ 或 saturn_ 音色' }
    }

    const ownerId = event.sender.id
    const emit = (realtimeEvent: VolcengineRealtimeEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('voice-realtime:event', { callId, event: realtimeEvent })
    }
    const session = new VolcengineRealtimeSession({
      appId,
      accessKey,
      speaker,
      botName: persona.displayName,
      model: '2.2.0.0',
      characterManifest: buildCharacterManifest(persona),
      dialogContext: sanitizeDialogContext(payload.dialogContext),
      onEvent: emit,
    })
    const onOwnerDestroyed = () => {
      const active = sessions.get(callId)
      if (active?.ownerId !== ownerId) return
      sessions.delete(callId)
      void active.session.close()
    }
    const active: ActiveRealtimeSession = { ownerId, owner: event.sender, onOwnerDestroyed, session }
    sessions.set(callId, active)
    event.sender.once('destroyed', onOwnerDestroyed)

    try {
      await session.connect()
      return { success: true, callId }
    } catch (error) {
      sessions.delete(callId)
      detachOwnerListener(active)
      await session.close().catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      if (/resource ID is mismatched with speaker related resource/i.test(message)) {
        return {
          success: false,
          error: '当前 Speaker 不属于这套 Realtime App ID 的 seed-icl-2.0 资源，请在数字分身页面点击“重新克隆声音”后再通话',
        }
      }
      return { success: false, error: message }
    }
  })

  ipcMain.on('voice-realtime:audio', (event, callIdValue: string, audio: ArrayBuffer | Uint8Array) => {
    const callId = String(callIdValue || '').trim()
    const active = sessions.get(callId)
    if (!active || active.ownerId !== event.sender.id) return
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
    try {
      active.session.sendAudio(bytes)
    } catch (error) {
      sessions.delete(callId)
      detachOwnerListener(active)
      if (!event.sender.isDestroyed()) {
        event.sender.send('voice-realtime:event', {
          callId,
          event: { type: 'error', error: error instanceof Error ? error.message : String(error) },
        })
      }
      void active.session.close()
    }
  })

  ipcMain.handle('voice-realtime:truncate', async (event, callIdValue: string, replyId: string, audioEndMs: number) => {
    const active = sessions.get(String(callIdValue || '').trim())
    if (!active || active.ownerId !== event.sender.id) return { success: false, error: '实时通话不存在' }
    active.session.truncate(replyId, audioEndMs)
    return { success: true }
  })

  ipcMain.handle('voice-realtime:stop', async (event, callIdValue: string) => {
    const callId = String(callIdValue || '').trim()
    const active = sessions.get(callId)
    if (!active || active.ownerId !== event.sender.id) return { success: true }
    sessions.delete(callId)
    detachOwnerListener(active)
    await active.session.close()
    return { success: true }
  })
}
