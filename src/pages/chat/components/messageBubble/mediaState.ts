import { LRUCache } from '../../../../utils/lruCache'

export const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

export const emojiDataUrlCache = new LRUCache<string, string>(200)
export const imageDataUrlCache = new LRUCache<string, string>(200)

// 图片更新/缓存解析事件的共享分发器。
// 之前每个 ImageBubble 各自调用 image.onUpdateAvailable/onCacheResolved，
// 数百条气泡 = 数百个 IPC 监听（触发 MaxListenersExceededWarning），
// 且 preload 退订用 removeAllListeners 会误删其他气泡的监听。
// 这里只在全局注册一次 IPC 监听，气泡仅向 Set 登记/注销回调（廉价）。
type ImageUpdatePayload = { cacheKey: string; imageMd5?: string; imageDatName?: string }
type ImageCacheResolvedPayload = ImageUpdatePayload & { localPath: string }

const imageUpdateSubscribers = new Set<(payload: ImageUpdatePayload) => void>()
const imageCacheResolvedSubscribers = new Set<(payload: ImageCacheResolvedPayload) => void>()
let imageEventsBound = false

function ensureImageEventsBound() {
  if (imageEventsBound) return
  imageEventsBound = true
  // 单一 IPC 监听，整个 app 生命周期内存在，不退订（避免 removeAllListeners 误删）
  window.electronAPI.image.onUpdateAvailable((payload) => {
    imageUpdateSubscribers.forEach((cb) => { try { cb(payload) } catch { /* ignore */ } })
  })
  window.electronAPI.image.onCacheResolved((payload) => {
    imageCacheResolvedSubscribers.forEach((cb) => { try { cb(payload) } catch { /* ignore */ } })
  })
}

export function subscribeImageUpdate(callback: (payload: ImageUpdatePayload) => void): () => void {
  ensureImageEventsBound()
  imageUpdateSubscribers.add(callback)
  return () => { imageUpdateSubscribers.delete(callback) }
}

export function subscribeImageCacheResolved(callback: (payload: ImageCacheResolvedPayload) => void): () => void {
  ensureImageEventsBound()
  imageCacheResolvedSubscribers.add(callback)
  return () => { imageCacheResolvedSubscribers.delete(callback) }
}

const imageDecryptQueue: Array<() => Promise<void>> = []
let isProcessingQueue = false
const MAX_CONCURRENT_DECRYPTS = 2

async function processDecryptQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true

  try {
    while (imageDecryptQueue.length > 0) {
      const batch = imageDecryptQueue.splice(0, MAX_CONCURRENT_DECRYPTS)
      await Promise.all(batch.map(fn => fn().catch(() => { })))
    }
  } finally {
    isProcessingQueue = false
  }
}

export function enqueueDecrypt(fn: () => Promise<void>) {
  imageDecryptQueue.push(fn)
  void processDecryptQueue()
}

export type VideoLookupDiagnostics = {
  requestedMd5?: string
  candidateMd5s?: string[]
  searchedFileKeys?: string[]
  matchedMd5?: string
  hardlinkMatchedMd5?: string
  hardlinkDbPath?: string
  accountDir?: string
  videoBaseDir?: string
  reason?: 'missing_input' | 'missing_config' | 'account_dir_not_found' | 'video_dir_missing' | 'local_file_missing'
  summary?: string
}

export type CachedVideoInfo = {
  videoUrl?: string
  coverUrl?: string
  thumbUrl?: string
  exists: boolean
  cachedAt: number
  diagnostics?: VideoLookupDiagnostics
}

export const videoInfoCache = new LRUCache<string, CachedVideoInfo>(200)

export let lastIncrementalUpdateTime = 0

export function setLastIncrementalUpdateTime(value: number) {
  lastIncrementalUpdateTime = value
}
