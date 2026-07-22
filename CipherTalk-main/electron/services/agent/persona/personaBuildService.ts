import type { PersonaBuildProgress, PersonaProfile, PersonaRecord, PersonaRole, PersonaStats } from './personaTypes'

type PersonaBuildLogger = {
  warn?(category: string, message: string, data?: unknown): void
  error?(category: string, message: string, data?: unknown): void
}

export interface PersonaBuildInput {
  sessionId: string
  displayName?: string
  /** 克隆角色：'friend'（默认，克隆联系人）| 'self'（克隆"我"自己，按会话存为 self: 前缀） */
  role?: PersonaRole
  logger?: PersonaBuildLogger | null
  onProgress?: (progress: PersonaBuildProgress) => void
}

export type PersonaBuildResult =
  | { success: true; persona: PersonaRecord }
  | { success: false; error: string }

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

// 超大会话的语音补转上限：防止克隆卡在转写上太久（超出的语音可后续在聊天界面手动转写）
const MAX_VOICE_TRANSCRIBE = 400

/**
 * 克隆前把会话里「还没转写过」的语音批量补转并写入转写缓存，
 * 让后续 buildPersonaCorpus 能把语音内容纳入文风/few-shot 语料（否则未转写语音会被直接丢弃）。
 *
 * 已转写的语音一律走 stt-cache，不会重复调用 STT（在线额度/本地算力都不重复花）。
 * 重新克隆时若聊天记录只是多了新语音，只会补转「未缓存」的那部分。
 * STT 未就绪（模型没下/在线转写没配）时整体跳过、不阻断克隆；单条失败静默继续。
 */
async function pretranscribeSessionVoices(
  sessionId: string,
  messages: { localId: number; localType: number; createTime: number }[],
  sendProgress: (stage: PersonaBuildProgress['stage'], title: string, percent: number, detail?: string) => void,
  logger: PersonaBuildLogger | null,
): Promise<void> {
  const { sttRuntimeService } = await import('../../sttRuntimeService')
  const { chatService } = await import('../../chatService')

  const voiceMessages = messages.filter((m) => m.localType === 34)
  if (voiceMessages.length === 0) {
    sendProgress('indexing', '无语音消息，跳过转写', 36)
    return
  }

  const voiceCountByTime = new Map<number, number>()
  for (const message of voiceMessages) {
    voiceCountByTime.set(message.createTime, (voiceCountByTime.get(message.createTime) || 0) + 1)
  }
  const canUseLegacyCache = (message: { createTime: number }) => voiceCountByTime.get(message.createTime) === 1

  // 只有时间戳唯一时才迁移旧缓存；同一秒多条语音必须按 localId 重新识别，避免串用文本。
  const pending = voiceMessages.filter(
    (m) => !sttRuntimeService.hasCachedTranscript(sessionId, m.createTime, m.localId, canUseLegacyCache(m)),
  )
  const cachedCount = voiceMessages.length - pending.length

  if (pending.length === 0) {
    sendProgress(
      'indexing',
      '语音已全部缓存，跳过转写',
      36,
      `已复用 ${cachedCount} 条历史转写，不重复消耗识别额度`,
    )
    logger?.warn?.('Persona', '语音补转跳过：全部命中缓存', { sessionId, cachedCount })
    return
  }

  // 最近的新语音优先：重新克隆通常是为了吃进新聊天记录
  pending.sort((a, b) => b.createTime - a.createTime)

  const total = Math.min(pending.length, MAX_VOICE_TRANSCRIBE)
  if (pending.length > total) {
    logger?.warn?.('Persona', '未转写语音过多，仅补转最近一部分', {
      sessionId,
      pending: pending.length,
      limit: total,
      cachedCount,
    })
  }

  sendProgress(
    'indexing',
    '正在转写新语音补全语料',
    12,
    `已缓存 ${cachedCount} 条可跳过，待转写 ${total} 条${pending.length > total ? `（共 ${pending.length} 条未缓存）` : ''}`,
  )

  let processed = 0
  let transcribed = 0
  let cacheHitsDuringRun = 0
  for (let i = 0; i < total; i += 1) {
    const m = pending[i]
    try {
      // 双保险：循环中再次查缓存（并发/边转边写时不重复打 STT）
      if (sttRuntimeService.hasCachedTranscript(sessionId, m.createTime, m.localId, canUseLegacyCache(m))) {
        cacheHitsDuringRun += 1
      } else {
        const voice = await chatService.getVoiceData(sessionId, String(m.localId), m.createTime)
        if (voice.success && voice.data) {
          const result = await sttRuntimeService.transcribeWavBuffer(Buffer.from(voice.data, 'base64'), {
            cache: {
              sessionId,
              createTime: m.createTime,
              localId: m.localId,
              allowLegacyCache: canUseLegacyCache(m),
            },
          })
          if (result.errorCode === 'STT_NOT_READY') {
            logger?.warn?.('Persona', '语音转写未就绪，跳过补转（不影响克隆）', { sessionId, error: result.error })
            return
          }
          if (result.cached) cacheHitsDuringRun += 1
          else if (result.success && result.transcript) transcribed += 1
        }
      }
    } catch {
      // 单条语音补转失败静默跳过，继续下一条
    }
    processed += 1
    if (processed % 5 === 0 || processed === total) {
      sendProgress(
        'indexing',
        '正在转写新语音补全语料',
        12 + Math.round((processed / total) * 24),
        `新转写 ${transcribed}，缓存命中 ${cachedCount + cacheHitsDuringRun}，进度 ${processed}/${total}`,
      )
    }
  }
  logger?.warn?.('Persona', '语音补转完成', {
    sessionId,
    transcribed,
    processed,
    cachedCount,
    cacheHitsDuringRun,
    pending: pending.length,
  })
}

export async function buildPersonaFromSession(input: PersonaBuildInput): Promise<PersonaBuildResult> {
  const sessionId = String(input.sessionId || '').trim()
  const displayName = String(input.displayName || '').trim() || sessionId
  const logger = input.logger || null
  const startedAt = Date.now()
  const role: PersonaRole = input.role === 'self' ? 'self' : 'friend'
  // 自克隆：被侧写者是"我"（isSend===1），对话方是联系人；存储键加 self: 前缀按会话隔离
  const subjectIsSend = role === 'self'
  const subjectName = role === 'self' ? '我' : displayName
  const otherName = role === 'self' ? displayName : '我'
  const storageSessionId = role === 'self' ? `self:${sessionId}` : sessionId
  const sendProgress = (
    stage: PersonaBuildProgress['stage'],
    title: string,
    percent: number,
    detail?: string,
  ) => {
    input.onProgress?.({ sessionId: storageSessionId, stage, title, percent, detail })
  }

  try {
    if (!sessionId) return { success: false, error: '缺少 sessionId' }

    const { resolveProviderConfig } = await import('../resolveProviderConfig')
    const { refreshResolvedProxyUrl } = await import('../../ai/proxyFetch')
    const providerConfig = resolveProviderConfig()
    await refreshResolvedProxyUrl()

    sendProgress('indexing', role === 'self' ? '正在读取聊天记录' : '正在读取聊天记录', 5)
    const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
    const { buildPersonaCorpus, MIN_FRIEND_MESSAGES, PROFILE_MAX_CHUNKS, mergeTurns, renderProfileChunks, extractPersonaPairs } =
      await import('./personaCorpus')
    let messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, (p) => {
      sendProgress('indexing', '正在读取聊天记录', 10, p.message)
    }, 6000)

    // 最近 6000 条里被侧写者发言太少（如长期单方面发消息），扩大到全量历史再读一次
    if (buildPersonaCorpus(messages, displayName, subjectIsSend).stats.friendMessageCount < MIN_FRIEND_MESSAGES) {
      sendProgress('indexing', '近期发言不足，正在读取更早的聊天记录', 11)
      messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, (p) => {
        sendProgress('indexing', '近期发言不足，正在读取更早的聊天记录', 11, p.message)
      })
    }

    sendProgress('indexing', '正在检查语音转写缓存', 12)
    await pretranscribeSessionVoices(sessionId, messages, sendProgress, logger)

    sendProgress('corpus', role === 'self' ? '正在分析"我"的说话风格' : '正在分析说话风格', 40)
    const corpus = buildPersonaCorpus(messages, displayName, subjectIsSend)

    let groupCorpus: import('./personaGroupCorpus').PersonaGroupCorpus | null = null
    // 自克隆不收集群聊补充语料：群里"我"的发言是对群友说的，会污染私聊自画像
    if (role !== 'self' && corpus.stats.friendMessageCount < MIN_FRIEND_MESSAGES) {
      sendProgress('corpus', '私聊语料不足，正在收集群聊发言', 42)
      try {
        const { collectGroupCorpus } = await import('./personaGroupCorpus')
        groupCorpus = await collectGroupCorpus(sessionId, displayName, (detail) => {
          sendProgress('corpus', '私聊语料不足，正在收集群聊发言', 44, detail)
        })
      } catch (e) {
        logger?.warn?.('Persona', '群聊语料收集失败，仅用私聊语料', { sessionId, ...errorToLogData(e) })
      }
      const totalFriendMessages = corpus.stats.friendMessageCount + (groupCorpus?.friendMessageCount || 0)
      if (totalFriendMessages < MIN_FRIEND_MESSAGES) {
        const groupNote = groupCorpus?.friendMessageCount
          ? `私聊 ${corpus.stats.friendMessageCount} 条 + 群聊 ${groupCorpus.friendMessageCount} 条`
          : `${corpus.stats.friendMessageCount} 条`
        const error = `与「${displayName}」的可用文本消息太少（${groupNote}，至少需要 ${MIN_FRIEND_MESSAGES} 条），不足以克隆`
        sendProgress('error', '克隆失败', 100, error)
        return { success: false, error }
      }
    }
    if (role === 'self' && corpus.stats.friendMessageCount < MIN_FRIEND_MESSAGES) {
      const error = `你发给「${displayName}」的文本消息太少（${corpus.stats.friendMessageCount} 条，至少需要 ${MIN_FRIEND_MESSAGES} 条），不足以克隆`
      sendProgress('error', '克隆失败', 100, error)
      return { success: false, error }
    }

    const stats: PersonaStats = {
      ...corpus.stats,
      ...(groupCorpus?.friendMessageCount
        ? { groupMessageCount: groupCorpus.friendMessageCount, groupSessionCount: groupCorpus.groupCount }
        : {}),
    }
    const turns = mergeTurns(messages, subjectIsSend)

    sendProgress('extracting', '正在提炼说话风格（调用 AI）', 48)
    const { agentProcessService } = await import('../agentProcessService')
    agentProcessService.setLogger(logger as never)
    const extracted = await agentProcessService.extractPersona({
      providerConfig,
      friendName: displayName,
      role,
      subjectName,
      otherName,
      corpusText: corpus.corpusText,
      groupCorpusText: groupCorpus?.friendMessageCount ? groupCorpus.corpusText : undefined,
      stats,
    })

    const profileChunks = [...renderProfileChunks(turns, displayName, subjectIsSend), ...(groupCorpus?.profileChunks || [])]
      .slice(0, PROFILE_MAX_CHUNKS)
    const parts: Array<PersonaProfile | undefined> = new Array(profileChunks.length)
    let nextChunk = 0
    let doneChunks = 0
    await Promise.all(
      Array.from({ length: Math.min(3, profileChunks.length) }, async () => {
        while (nextChunk < profileChunks.length) {
          const myIndex = nextChunk++
          try {
            parts[myIndex] = await agentProcessService.extractProfileChunk({
              providerConfig,
              friendName: displayName,
              role,
              subjectName,
              otherName,
              chunkText: profileChunks[myIndex],
            })
          } catch {
            // 单块失败跳过
          }
          doneChunks += 1
          sendProgress(
            'extracting',
            `正在提炼深层画像（${doneChunks}/${profileChunks.length}）`,
            55 + Math.round((doneChunks / profileChunks.length) * 25),
          )
        }
      }),
    )

    const validParts = parts.filter((p): p is PersonaProfile => !!p)
    let profile: PersonaProfile | null = null
    if (validParts.length > 0) {
      sendProgress('extracting', '正在合并深层画像', 82)
      try {
        profile = await agentProcessService.mergeProfile({
          providerConfig,
          friendName: displayName,
          role,
          subjectName,
          otherName,
          parts: validParts,
        })
      } catch (e) {
        logger?.warn?.('Persona', '深层画像合并失败，降级为无深层画像', { sessionId, ...errorToLogData(e) })
      }
    }

    // 自克隆不收集表情包（自画像不发表情包气泡）；好友克隆收集私聊+群聊表情包
    const stickers = role === 'self' ? [] : await (async () => {
      const { collectStickers, mergeStickers } = await import('./personaStickers')
      return mergeStickers(
        collectStickers(messages, (m) => m.isSend !== 1),
        groupCorpus?.stickers || [],
      )
    })()

    sendProgress('saving', '正在保存画像', 88)
    const { personaStore } = await import('./personaStore')
    const corpusUntil = messages.reduce((max, m) => Math.max(max, m.createTime), 0)
    const persona = personaStore.upsert({
      sessionId: storageSessionId,
      displayName: role === 'self' ? '我' : displayName,
      card: extracted.card,
      fewShots: extracted.fewShots,
      stats,
      profile,
      stickers,
      corpusUntil,
      modelProvider: providerConfig.name,
      modelId: providerConfig.model,
    })

    try {
      const { personaPairStore } = await import('./personaPairStore')
      personaPairStore.replaceAll(storageSessionId, extractPersonaPairs(turns))
      sendProgress('saving', '正在为真实问答建索引', 92)
      await personaPairStore.embedPending(storageSessionId, (current, total) => {
        sendProgress('saving', `正在为真实问答建索引（${current}/${total}）`, 92 + Math.round((current / total) * 6))
      })
    } catch (e) {
      logger?.warn?.('Persona', '问答对索引构建失败（聊天时退回静态样本）', { sessionId: storageSessionId, ...errorToLogData(e) })
    }

    sendProgress('done', '克隆完成', 100)
    logger?.warn?.('Persona', '画像构建完成', {
      sessionId: storageSessionId,
      role,
      elapsedMs: Date.now() - startedAt,
      friendMessageCount: corpus.stats.friendMessageCount,
      groupMessageCount: groupCorpus?.friendMessageCount || 0,
      stickerCount: stickers.length,
      fewShotCount: persona.fewShots.length,
      profileChunkCount: profileChunks.length,
      hasProfile: !!profile,
      provider: providerConfig.name,
      model: providerConfig.model,
    })
    return { success: true, persona }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger?.error?.('Persona', '画像构建失败', { sessionId: storageSessionId, role, elapsedMs: Date.now() - startedAt, ...errorToLogData(e) })
    sendProgress('error', '克隆失败', 100, message)
    return { success: false, error: message }
  }
}
