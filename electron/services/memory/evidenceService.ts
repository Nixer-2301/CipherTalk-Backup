import { chatService } from '../chatService'
import type { Message } from '../chatService'
import type { MemoryEvidenceRef, MemoryItem } from './memorySchema'
import type { RetrievalExpandedEvidence } from '../retrieval/retrievalTypes'

function compareRefAsc(a: MemoryEvidenceRef, b: MemoryEvidenceRef): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function messageKey(message: Pick<Message, 'localId' | 'createTime' | 'sortSeq'>): string {
  return `${Number(message.localId || 0)}:${Number(message.createTime || 0)}:${Number(message.sortSeq || 0)}`
}

function uniqueMessages(messages: Message[]): Message[] {
  const seen = new Set<string>()
  const result: Message[] = []
  for (const message of messages) {
    const key = messageKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }
  return result
}

async function loadAnchor(ref: MemoryEvidenceRef): Promise<Message | null> {
  try {
    const result = await chatService.getMessageByLocalId(ref.sessionId, ref.localId)
    if (!result.success || !result.message) return null
    if (Number(ref.createTime || 0) > 0 && Number(result.message.createTime || 0) !== Number(ref.createTime)) {
      return {
        ...result.message,
        createTime: ref.createTime,
        sortSeq: ref.sortSeq
      }
    }
    return result.message
  } catch {
    return null
  }
}

async function expandAroundRef(ref: MemoryEvidenceRef, radius: number): Promise<RetrievalExpandedEvidence> {
  const [beforeResult, anchor, afterResult] = await Promise.all([
    chatService.getMessagesBefore(ref.sessionId, ref.sortSeq, radius, ref.createTime, ref.localId),
    loadAnchor(ref),
    chatService.getMessagesAfter(ref.sessionId, ref.sortSeq, radius, ref.createTime, ref.localId)
  ])

  return {
    ref,
    before: uniqueMessages(beforeResult.success ? beforeResult.messages || [] : []),
    anchor,
    after: uniqueMessages(afterResult.success ? afterResult.messages || [] : [])
  }
}

export class EvidenceService {
  async expandMemoryEvidence(memory: MemoryItem): Promise<RetrievalExpandedEvidence[]> {
    const refs = [...memory.sourceRefs].sort(compareRefAsc)
    if (refs.length === 0) return []

    if (memory.sourceType === 'conversation_block') {
      const first = refs[0]
      const last = refs[refs.length - 1]
      if (messageKey(first) === messageKey(last)) {
        return [await expandAroundRef(first, 3)]
      }

      const [before, after] = await Promise.all([
        chatService.getMessagesBefore(first.sessionId, first.sortSeq, 3, first.createTime, first.localId),
        chatService.getMessagesAfter(last.sessionId, last.sortSeq, 3, last.createTime, last.localId)
      ])
      return [{
        ref: first,
        before: uniqueMessages(before.success ? before.messages || [] : []),
        anchor: null,
        after: uniqueMessages(after.success ? after.messages || [] : [])
      }]
    }

    const radius = memory.sourceType === 'message' ? 6 : 3
    const limitedRefs = refs.slice(0, memory.sourceType === 'fact' ? 3 : 1)
    return Promise.all(limitedRefs.map((ref) => expandAroundRef(ref, radius)))
  }
}

export const evidenceService = new EvidenceService()
