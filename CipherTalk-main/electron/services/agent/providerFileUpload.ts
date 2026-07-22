import { createHash } from 'crypto'
import { uploadFile, type ProviderReference, type UIMessage } from 'ai'
import type { AgentProviderConfig } from './types'
import { createProviderFilesApi } from './provider'

const PROVIDER_FILE_UPLOAD_TIMEOUT_MS = 60_000
const PROVIDER_FILE_UPLOAD_CACHE_MAX = 200

type ProviderFileUploadLogger = {
  warn?(category: string, message: string, data?: any): void
  debug?(category: string, message: string, data?: any): void
}

type CachedProviderFile = {
  providerReference: ProviderReference
  mediaType?: string
  filename?: string
}

export type ProviderFileUploadStats = {
  supported: boolean
  attempted: number
  uploaded: number
  reused: number
  failed: number
  skipped: number
}

const uploadCache = new Map<string, CachedProviderFile>()
const inFlightUploads = new Map<string, Promise<CachedProviderFile>>()

function rememberUpload(key: string, value: CachedProviderFile): void {
  uploadCache.set(key, value)
  if (uploadCache.size <= PROVIDER_FILE_UPLOAD_CACHE_MAX) return
  const oldest = uploadCache.keys().next().value
  if (oldest) uploadCache.delete(oldest)
}

function shortHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function providerCacheKey(config: AgentProviderConfig, mediaHash: string): string {
  const authHash = shortHash(JSON.stringify({
    apiKey: config.apiKey,
    headers: config.headers || {},
  })).slice(0, 16)
  return [
    config.providerKind,
    config.name,
    config.baseURL,
    authHash,
    mediaHash,
  ].join('|')
}

function parseDataUrl(dataUrl: string): { mediaType: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:([^;,]+)?((?:;[^,]*)?),([\s\S]*)$/)
  if (!match) return null
  const mediaType = (match[1] || 'application/octet-stream').trim() || 'application/octet-stream'
  const flags = match[2] || ''
  const body = match[3] || ''
  try {
    const buffer = flags.includes(';base64')
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodeURIComponent(body), 'utf8')
    return buffer.length > 0 ? { mediaType, buffer } : null
  } catch {
    return null
  }
}

function isFilePart(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'file'
}

function cloneMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return message
    return {
      ...message,
      parts: parts.map((part) => isFilePart(part) ? { ...part } : part),
    } as UIMessage
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`provider file upload timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || 'unknown error')
}

export async function prepareProviderFileUploads(
  messages: UIMessage[] = [],
  providerConfig: AgentProviderConfig,
  logger?: ProviderFileUploadLogger | null,
): Promise<{ messages: UIMessage[]; stats: ProviderFileUploadStats }> {
  const api = createProviderFilesApi(providerConfig)
  const stats: ProviderFileUploadStats = {
    supported: Boolean(api),
    attempted: 0,
    uploaded: 0,
    reused: 0,
    failed: 0,
    skipped: 0,
  }
  if (!api) return { messages, stats }

  const nextMessages = cloneMessages(messages)
  for (const message of nextMessages) {
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!isFilePart(part)) continue
      const url = typeof part.url === 'string' ? part.url : ''
      if (!url.startsWith('data:')) {
        stats.skipped += 1
        continue
      }

      const parsed = parseDataUrl(url)
      if (!parsed) {
        stats.skipped += 1
        continue
      }

      const mediaType = typeof part.mediaType === 'string' && part.mediaType
        ? part.mediaType
        : parsed.mediaType
      const filename = typeof part.filename === 'string' && part.filename ? part.filename : undefined
      const mediaHash = shortHash(parsed.buffer)
      const cacheKey = providerCacheKey(providerConfig, mediaHash)
      const cached = uploadCache.get(cacheKey)
      if (cached) {
        part.providerReference = cached.providerReference
        if (cached.mediaType) part.mediaType = cached.mediaType
        if (cached.filename && !filename) part.filename = cached.filename
        stats.reused += 1
        continue
      }

      stats.attempted += 1
      try {
        const uploadPromise = inFlightUploads.get(cacheKey) ?? withTimeout(uploadFile({
          api,
          data: parsed.buffer,
          mediaType,
          filename,
        }), PROVIDER_FILE_UPLOAD_TIMEOUT_MS).then((result) => ({
          providerReference: result.providerReference,
          mediaType: result.mediaType || mediaType,
          filename: result.filename || filename,
        }))
        inFlightUploads.set(cacheKey, uploadPromise)
        const uploaded = await uploadPromise
        inFlightUploads.delete(cacheKey)
        rememberUpload(cacheKey, uploaded)
        part.providerReference = uploaded.providerReference
        if (uploaded.mediaType) part.mediaType = uploaded.mediaType
        if (uploaded.filename && !filename) part.filename = uploaded.filename
        stats.uploaded += 1
      } catch (error) {
        inFlightUploads.delete(cacheKey)
        stats.failed += 1
        logger?.warn?.('AIAgent', 'provider file upload 失败，回退 inline data URL', {
          provider: providerConfig.name,
          protocol: providerConfig.providerKind,
          model: providerConfig.model,
          mediaType,
          filename,
          sizeBytes: parsed.buffer.length,
          error: uploadErrorMessage(error),
        })
      }
    }
  }

  if (stats.attempted > 0 || stats.reused > 0 || stats.failed > 0) {
    logger?.debug?.('AIAgent', 'provider file upload 处理完成', stats)
  }
  return { messages: nextMessages, stats }
}
