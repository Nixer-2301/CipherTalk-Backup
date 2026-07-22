import type { BrowserWindow as BrowserWindowT } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import crypto from 'crypto'
import { Worker } from 'worker_threads'
import { dbAdapter } from './dbAdapter'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ConfigService } from './config'
import { getDefaultCachePath as getPlatformDefaultCachePath } from './platformService'
import { getDocumentsPath, getUserDataPath } from './runtimePaths'
import { decryptDatViaNative, nativeAddonLocation, nativeAddonMetadata, nativeDecryptEnabled } from './nativeImageDecrypt'
import {
  asciiKey16 as asciiKey16Core,
  decryptDatLegacy as decryptDatLegacyCore,
  detectImageExtension as detectImageExtensionCore,
  getDatVersion as getDatVersionCore,
  looksLikeNativeImagePayload as looksLikeNativeImagePayloadCore
} from './datDecryptCore'
import { imageDecryptWorkerPool } from './imageDecryptWorkerPool'

const execFileAsync = promisify(execFile)

// 获取 ffmpeg-static 的路径
function getStaticFfmpegPath(): string | null {
  try {
    // ffmpeg-static 导出的是路径字符串
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static')
    if (typeof ffmpegStatic === 'string') {
      return ffmpegStatic
    }
    return null
  } catch {
    return null
  }
}

type DecryptResult = {
  success: boolean
  localPath?: string
  error?: string
  isThumb?: boolean  // 是否是缩略图（没有高清图时返回缩略图）
  liveVideoPath?: string  // 实况照片的视频路径
}

type HardlinkState = {
  imageTable?: string
  dirTable?: string
}

type DatDecryptOutcome = {
  data: Buffer
  source: 'native' | 'ts'
  fallbackReason?: string
}

type ResolveDatDiagnostics = {
  source?: string
}

type ImageLookupPayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
  force?: boolean
  quick?: boolean
}

type ImagePrewarmResult = {
  success: boolean
  requested: number
  enqueued: number
  cacheHits: number
  decrypted: number
  failed: number
  skipped: number
  error?: string
}

type ImageBatchDecryptProgress = {
  current: number
  total: number
  successCount: number
  failCount: number
  cacheHits: number
  decrypted: number
  skipped: number
}

type ImageBatchDecryptResult = ImageBatchDecryptProgress & {
  success: boolean
  requested: number
  error?: string
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private hardlinkCache = new Map<string, HardlinkState>()
  private resolvedCache = new Map<string, string>()
  private sessionDatDirCache = new Map<string, string>()
  private sessionDatRootCache = new Map<string, string>()
  private pending = new Map<string, Promise<DecryptResult>>()
  private noLiveSet = new Set<string>()
  private cacheIndexed = false
  private cacheIndexing: Promise<void> | null = null
  private updateFlags = new Map<string, boolean>()
  private notFoundCache = new Set<string>()  // 失败缓存，避免重复查询
  private hdNotFoundCache = new Set<string>()  // 高清图失败缓存
  private nativeLogged = false
  private datPathIndex = new Map<string, string>()
  private datPathIndexLoaded = false
  private datPathIndexWriteTimer: ReturnType<typeof setTimeout> | null = null
  private prewarmKeys = new Set<string>()
  private readonly datPathIndexMaxEntries = 20_000
  // msg/attach 全量 dat 索引（normalizeDatBase → 路径列表）：
  // 兜底搜索从"每次未命中全盘 BFS(~10s)"改为"首次建索引一次，之后 O(1)"
  private fullDatIndex: Map<string, string[]> | null = null
  private fullDatIndexPromise: Promise<Map<string, string[]>> | null = null
  private fullDatIndexRoot = ''
  private fullDatIndexBuiltAt = 0

  async resolveCachedImage(payload: ImageLookupPayload): Promise<DecryptResult & { hasUpdate?: boolean }> {
    // 不再等待缓存索引，直接查找
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }

    // 1. 先检查内存缓存（最快）
    for (const key of cacheKeys) {
      const cached = this.resolvedCache.get(key)
      if (cached && this.validateCachedImageFile(cached)) {
        const localPath = this.filePathToUrl(cached)
        const isThumb = this.isThumbnailPath(cached)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, cached)
        } else {
          this.updateFlags.delete(key)
        }
        const liveVideoPath = isThumb ? undefined : this.checkLiveVideoCache(cached)
        this.emitCacheResolved(payload, key, localPath)
        return { success: true, localPath, hasUpdate, liveVideoPath }
      }
      if (cached && !this.validateCachedImageFile(cached)) {
        this.resolvedCache.delete(key)
      }
    }

    // 2. 快速查找缓存文件（优先查找当前 sessionId 的最新日期目录）
    for (const key of cacheKeys) {
      const existing = this.findCachedOutputFast(key, payload.sessionId, false, payload.createTime)
      if (existing) {
        this.cacheResolvedPaths(key, payload.imageMd5, payload.imageDatName, existing)
        const localPath = this.filePathToUrl(existing)
        const isThumb = this.isThumbnailPath(existing)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, existing)
        } else {
          this.updateFlags.delete(key)
        }
        const liveVideoPath = isThumb ? undefined : this.checkLiveVideoCache(existing)
        this.emitCacheResolved(payload, key, localPath)
        return { success: true, localPath, hasUpdate, liveVideoPath }
      }
    }

    const datCached = await this.resolveCachedOutputByDatPathHint(payload, cacheKey)
    if (datCached) {
      const { existing, key } = datCached
      this.cacheResolvedPaths(key, payload.imageMd5, payload.imageDatName, existing)
      const localPath = this.filePathToUrl(existing)
      const isThumb = this.isThumbnailPath(existing)
      const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
      if (isThumb) {
        this.triggerUpdateCheck(payload, key, existing)
      } else {
        this.updateFlags.delete(key)
      }
      const liveVideoPath = isThumb ? undefined : this.checkLiveVideoCache(existing)
      this.emitCacheResolved(payload, key, localPath)
      return { success: true, localPath, hasUpdate, liveVideoPath }
    }

    // 3. 后台启动完整索引（不阻塞当前请求）
    if (!this.cacheIndexed && !this.cacheIndexing) {
      void this.ensureCacheIndexed()
    }

    return { success: false, error: '未找到缓存图片' }
  }

  async decryptImage(payload: ImageLookupPayload): Promise<DecryptResult> {
    const cacheKey = payload.imageMd5 || payload.imageDatName
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }
    const lookupCacheKey = this.buildLookupCacheKey(payload, cacheKey)

    // 失败缓存：跳过已知找不到的图片（force 时忽略，允许重试）
    if (!payload.force && this.notFoundCache.has(lookupCacheKey)) {
      return { success: false, error: '未找到图片文件' }
    }

    // 即使 force=true，也先检查是否有高清图缓存
    if (payload.force) {
      if (this.hdNotFoundCache.has(lookupCacheKey)) {
        return { success: false, error: '未找到高清图，请在微信中点开该图片查看后重试' }
      }
      // 快速查找高清图缓存
      const hdCached = this.findCachedOutputFast(cacheKey, payload.sessionId, true, payload.createTime) ||
        this.findCachedOutput(cacheKey, payload.sessionId, true)
      if (hdCached && this.validateCachedImageFile(hdCached)) {
        const localPath = this.filePathToUrl(hdCached)
        const liveVideoPath = this.checkLiveVideoCache(hdCached)
        return { success: true, localPath, isThumb: false, liveVideoPath }
      }
    } else {
      // 常规缓存检查（可能返回缩略图）
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && this.validateCachedImageFile(cached)) {
        const localPath = this.filePathToUrl(cached)
        const liveVideoPath = this.checkLiveVideoCache(cached)
        return { success: true, localPath, liveVideoPath }
      }
      if (cached && !this.validateCachedImageFile(cached)) {
        this.resolvedCache.delete(cacheKey)
      }
    }

    const pending = this.pending.get(cacheKey)
    if (pending) {
      return pending
    }

    const task = this.decryptImageInternal(payload, cacheKey)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  async prewarmImages(
    payloads: ImageLookupPayload[],
    options: { limit?: number; concurrency?: number } = {}
  ): Promise<ImagePrewarmResult> {
    const requested = Array.isArray(payloads) ? payloads.length : 0
    const result: ImagePrewarmResult = {
      success: true,
      requested,
      enqueued: 0,
      cacheHits: 0,
      decrypted: 0,
      failed: 0,
      skipped: 0
    }

    if (!Array.isArray(payloads) || payloads.length === 0) return result

    const limit = Math.max(1, Math.min(options.limit ?? 40, 120))
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4))
    const seen = new Set<string>()
    const queue: Array<{ payload: ImageLookupPayload; lookupKey: string }> = []

    for (const payload of payloads) {
      if (queue.length >= limit) break
      const cacheKey = payload?.imageMd5 || payload?.imageDatName
      if (!cacheKey) {
        result.skipped += 1
        continue
      }
      const lookupKey = this.buildLookupCacheKey(payload, cacheKey)
      if (seen.has(lookupKey) || this.prewarmKeys.has(lookupKey)) {
        result.skipped += 1
        continue
      }
      seen.add(lookupKey)
      this.prewarmKeys.add(lookupKey)
      queue.push({
        lookupKey,
        payload: {
          sessionId: payload.sessionId,
          imageMd5: payload.imageMd5,
          imageDatName: payload.imageDatName,
          createTime: payload.createTime,
          force: false,
          quick: true
        }
      })
    }

    result.enqueued = queue.length
    let cursor = 0
    const workerCount = Math.min(concurrency, queue.length)

    const runNext = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor]
        cursor += 1
        try {
          const cached = await this.resolveCachedImage(item.payload)
          if (cached.success && cached.localPath) {
            result.cacheHits += 1
            continue
          }

          const decrypted = await this.decryptImage(item.payload)
          if (decrypted.success && decrypted.localPath) {
            result.decrypted += 1
          } else {
            result.failed += 1
          }
        } catch {
          result.failed += 1
        } finally {
          this.prewarmKeys.delete(item.lookupKey)
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, runNext))
    return result
  }

  async batchDecryptImages(
    payloads: ImageLookupPayload[],
    options: { concurrency?: number; onProgress?: (progress: ImageBatchDecryptProgress) => void } = {}
  ): Promise<ImageBatchDecryptResult> {
    const requested = Array.isArray(payloads) ? payloads.length : 0
    const result: ImageBatchDecryptResult = {
      success: true,
      requested,
      current: 0,
      total: 0,
      successCount: 0,
      failCount: 0,
      cacheHits: 0,
      decrypted: 0,
      skipped: 0
    }

    if (!Array.isArray(payloads) || payloads.length === 0) return result

    const seen = new Set<string>()
    const queue: ImageLookupPayload[] = []
    for (const payload of payloads) {
      const cacheKey = payload?.imageMd5 || payload?.imageDatName
      if (!cacheKey) {
        result.skipped += 1
        continue
      }
      const lookupKey = this.buildLookupCacheKey(payload, cacheKey)
      if (seen.has(lookupKey)) {
        result.skipped += 1
        continue
      }
      seen.add(lookupKey)
      queue.push({
        sessionId: payload.sessionId,
        imageMd5: payload.imageMd5,
        imageDatName: payload.imageDatName,
        createTime: payload.createTime,
        force: false,
        quick: true
      })
    }

    result.total = queue.length
    options.onProgress?.({ ...result })
    if (queue.length === 0) return result

    const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4))
    let cursor = 0

    const completeOne = (kind: 'cache' | 'decrypt' | 'fail') => {
      if (kind === 'cache') {
        result.cacheHits += 1
        result.successCount += 1
      } else if (kind === 'decrypt') {
        result.decrypted += 1
        result.successCount += 1
      } else {
        result.failCount += 1
      }
      result.current += 1
      options.onProgress?.({ ...result })
    }

    const runNext = async () => {
      while (cursor < queue.length) {
        const payload = queue[cursor]
        cursor += 1

        try {
          const cached = await this.resolveCachedImage(payload)
          if (cached.success && cached.localPath) {
            completeOne('cache')
            continue
          }

          const decrypted = await this.decryptImage(payload)
          completeOne(decrypted.success && decrypted.localPath ? 'decrypt' : 'fail')
        } catch {
          completeOne('fail')
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, runNext))
    return result
  }

  private async resolveCachedOutputByDatPathHint(
    payload: ImageLookupPayload,
    cacheKey: string
  ): Promise<{ existing: string; key: string } | null> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return null

    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return null

    const diagnostics: ResolveDatDiagnostics = {}
    const datPath = await this.resolveDatPath(
      accountDir,
      payload.imageMd5,
      payload.imageDatName,
      payload.sessionId,
      payload.createTime,
      { allowThumbnail: true, skipSearchFallback: true },
      diagnostics
    )
    if (!datPath) return null

    const existing = this.findCachedOutputByDatPath(datPath, payload.sessionId, false)
    if (!existing) return null

    const key = payload.imageDatName || basename(datPath) || cacheKey
    return { existing, key }
  }

  private async decryptImageInternal(
    payload: ImageLookupPayload,
    cacheKey: string
  ): Promise<DecryptResult> {
    const lookupCacheKey = this.buildLookupCacheKey(payload, cacheKey)
    const totalStartedAt = Date.now()
    let resolveDatMs = 0
    let cacheLookupMs = 0
    let decryptMs = 0
    let wxgfMs = 0
    let writeMs = 0
    let motionVideoMs = 0
    let thumbnailCleanupMs = 0
    let datPath: string | null = null
    const datDiagnostics: ResolveDatDiagnostics = {}
    let decryptSource: 'native' | 'ts' | 'none' = 'none'
    let fallbackReason: string | undefined
    let finalExtForLog: string | undefined
    let nativeFallbackUsed = false
    let usedCachedOutput = false
    let wxgfDetected = false

    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        console.error(`[ImageDecrypt] 未找到账号目录 wxid=${wxid} dbPath=${dbPath}`)
        return { success: false, error: '未找到账号目录' }
      }

      const resolveDatStartedAt = Date.now()
      datPath = await this.resolveDatPath(
        accountDir,
        payload.imageMd5,
        payload.imageDatName,
        payload.sessionId,
        payload.createTime,
        { allowThumbnail: !payload.force, skipResolvedCache: Boolean(payload.force), skipSearchFallback: Boolean(payload.quick) },
        datDiagnostics
      )
      resolveDatMs = Date.now() - resolveDatStartedAt

      // 如果要求高清图但没找到，直接返回提示
      if (!datPath && payload.force) {
        this.hdNotFoundCache.add(lookupCacheKey)
        console.warn(`[ImageDecrypt] 未找到高清图: ${payload.imageDatName || payload.imageMd5}`)
        this.logDecryptTiming({
          cacheKey,
          payload,
          datPath,
          resolveSource: datDiagnostics.source,
          resolveDatMs,
          cacheLookupMs,
          decryptMs,
          wxgfMs,
          writeMs,
          motionVideoMs,
          thumbnailCleanupMs,
          decryptSource,
          fallbackReason,
          finalExt: finalExtForLog,
          usedCachedOutput,
          nativeFallbackUsed,
          wxgfDetected,
          status: 'missing_hd',
          totalMs: Date.now() - totalStartedAt
        })
        return { success: false, error: '未找到高清图，请在微信中点开该图片查看后重试' }
      }
      if (!datPath) {
        const cacheLookupStartedAt = Date.now()
        const existing = this.findCachedOutputFast(cacheKey, payload.sessionId, payload.force, payload.createTime) ||
          (payload.quick ? null : this.findCachedOutput(cacheKey, payload.sessionId, payload.force))
        cacheLookupMs = Date.now() - cacheLookupStartedAt
        if (existing) {
          usedCachedOutput = true
          const isHd = this.isHdPath(existing)
          if (!(payload.force && !isHd)) {
            this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
            const localPath = this.filePathToUrl(existing)
            const isThumb = this.isThumbnailPath(existing)
            this.emitCacheResolved(payload, cacheKey, localPath)
            this.logDecryptTiming({
              cacheKey,
              payload,
              datPath,
              resolveSource: datDiagnostics.source,
              resolveDatMs,
              cacheLookupMs,
              decryptMs,
              wxgfMs,
              writeMs,
              motionVideoMs,
              thumbnailCleanupMs,
              decryptSource,
              fallbackReason,
              finalExt: extname(existing).toLowerCase(),
              usedCachedOutput,
              nativeFallbackUsed,
              wxgfDetected,
              status: 'cache_hit',
              totalMs: Date.now() - totalStartedAt
            })
            return { success: true, localPath, isThumb, liveVideoPath: !isThumb ? this.checkLiveVideoCache(existing) : undefined }
          }
        }

        if (!payload.quick) {
          this.notFoundCache.add(lookupCacheKey)
        }
        console.warn(`[ImageDecrypt] 未找到图片文件: ${payload.imageDatName || payload.imageMd5} sessionId=${payload.sessionId}`)
        this.logDecryptTiming({
          cacheKey,
          payload,
          datPath,
          resolveSource: datDiagnostics.source,
          resolveDatMs,
          cacheLookupMs,
          decryptMs,
          wxgfMs,
          writeMs,
          motionVideoMs,
          thumbnailCleanupMs,
          decryptSource,
          fallbackReason,
          finalExt: finalExtForLog,
          usedCachedOutput,
          nativeFallbackUsed,
          wxgfDetected,
          status: 'missing_dat',
          totalMs: Date.now() - totalStartedAt
        })
        return { success: false, error: '未找到图片文件' }
      }

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.cacheSessionDatRoot(accountDir, payload.sessionId, datPath)
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const localPath = this.filePathToUrl(datPath)
        const isThumb = this.isThumbnailPath(datPath)
        this.emitCacheResolved(payload, cacheKey, localPath)
        this.logDecryptTiming({
          cacheKey,
          payload,
          datPath,
          resolveSource: datDiagnostics.source,
          resolveDatMs,
          cacheLookupMs,
          decryptMs,
          wxgfMs,
          writeMs,
          motionVideoMs,
          thumbnailCleanupMs,
          decryptSource,
          fallbackReason,
          finalExt: extname(datPath).toLowerCase(),
          usedCachedOutput,
          nativeFallbackUsed,
          wxgfDetected,
          status: 'plain_file',
          totalMs: Date.now() - totalStartedAt
        })
        return { success: true, localPath, isThumb, liveVideoPath: !isThumb ? this.checkLiveVideoCache(datPath) : undefined }
      }

      // 查找已缓存的解密文件
      const cacheLookupStartedAt = Date.now()
      const existing = this.findCachedOutputFast(cacheKey, payload.sessionId, payload.force, payload.createTime) ||
        this.findCachedOutputByDatPath(datPath, payload.sessionId, payload.force) ||
        (payload.quick ? null : this.findCachedOutput(cacheKey, payload.sessionId, payload.force))
      cacheLookupMs = Date.now() - cacheLookupStartedAt
      if (existing) {
        usedCachedOutput = true
        const isHd = this.isHdPath(existing)
        // 如果要求高清但找到的是缩略图，继续解密高清图
        if (!(payload.force && !isHd)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
          const localPath = this.filePathToUrl(existing)
          const isThumb = this.isThumbnailPath(existing)
          this.emitCacheResolved(payload, cacheKey, localPath)
          this.logDecryptTiming({
            cacheKey,
            payload,
            datPath,
            resolveSource: datDiagnostics.source,
            resolveDatMs,
            cacheLookupMs,
            decryptMs,
            wxgfMs,
            writeMs,
            motionVideoMs,
            thumbnailCleanupMs,
            decryptSource,
            fallbackReason,
            finalExt: extname(existing).toLowerCase(),
            usedCachedOutput,
            nativeFallbackUsed,
            wxgfDetected,
            status: 'cache_hit',
            totalMs: Date.now() - totalStartedAt
          })
          return { success: true, localPath, isThumb, liveVideoPath: !isThumb ? this.checkLiveVideoCache(existing) : undefined }
        }
      }

      const xorKeyStr = this.configService.get('imageXorKey')
      // 支持十六进制格式（如 0x53）和十进制格式
      let xorKey: number
      if (typeof xorKeyStr === 'string') {
        const trimmed = xorKeyStr.trim()
        if (trimmed.toLowerCase().startsWith('0x')) {
          xorKey = parseInt(trimmed, 16)
        } else {
          xorKey = parseInt(trimmed, 10)
        }
      } else {
        xorKey = xorKeyStr as number
      }
      if (Number.isNaN(xorKey) || (!xorKey && xorKey !== 0)) {
        return { success: false, error: '未配置图片解密密钥' }
      }

      const aesKeyRaw = this.configService.get('imageAesKey')
      const aesKeyText = typeof aesKeyRaw === 'string' ? aesKeyRaw.trim() : ''
      const aesKey = this.resolveAesKey(aesKeyRaw)

      const decryptStartedAt = Date.now()
      let decryptOutcome = await this.decryptDatAuto(datPath, xorKey, aesKey, aesKeyText)
      decryptMs += Date.now() - decryptStartedAt
      decryptSource = decryptOutcome.source
      fallbackReason = decryptOutcome.fallbackReason
      let decrypted = decryptOutcome.data

      const unwrapStartedAt = Date.now()
      let wxgfResult = await this.unwrapWxgf(decrypted)
      wxgfMs += Date.now() - unwrapStartedAt
      wxgfDetected = wxgfResult.isWxgf
      decrypted = wxgfResult.data

      let ext = this.detectImageExtension(decrypted)

      if (wxgfResult.isWxgf && !ext) {
        ext = '.hevc'
      }

      if (!ext && decryptOutcome.source === 'native') {
        console.warn(`[ImageDecrypt] Native DAT 解密结果无效，回退 TS 逻辑: ${datPath} reason=${decryptOutcome.fallbackReason || 'invalid_output'}`)
        nativeFallbackUsed = true
        fallbackReason = decryptOutcome.fallbackReason || 'invalid_output'
        const fallbackDecryptStartedAt = Date.now()
        decryptOutcome = this.decryptDatLegacy(datPath, xorKey, aesKey)
        decryptMs += Date.now() - fallbackDecryptStartedAt
        decryptSource = decryptOutcome.source
        decrypted = decryptOutcome.data
        const fallbackUnwrapStartedAt = Date.now()
        wxgfResult = await this.unwrapWxgf(decrypted)
        wxgfMs += Date.now() - fallbackUnwrapStartedAt
        wxgfDetected = wxgfResult.isWxgf
        decrypted = wxgfResult.data
        ext = this.detectImageExtension(decrypted)
        if (wxgfResult.isWxgf && !ext) {
          ext = '.hevc'
        }
      }

      const finalExt = ext || '.jpg'
      finalExtForLog = finalExt

      // 图片完整性校验：检测解密后的数据是否有完整的结束标记
      const isImageComplete = this.verifyImageComplete(decrypted, finalExt)

      if (!isImageComplete) {
        const datSize = statSync(datPath).size
        const datVersion = this.getDatVersion(datPath)
        console.warn(`[ImageDecrypt] 图片不完整! cacheKey=${cacheKey} datPath=${datPath} datSize=${datSize} version=V${datVersion === 0 ? '3' : datVersion === 1 ? '4v1' : '4v2'} decryptedSize=${decrypted.length} ext=${finalExt} headHex=${decrypted.subarray(0, 8).toString('hex')} tailHex=${decrypted.subarray(Math.max(0, decrypted.length - 8)).toString('hex')}`)
      }

      const outputPath = this.getCacheOutputPathFromDat(datPath, finalExt, payload.sessionId)
      const writeStartedAt = Date.now()
      await writeFile(outputPath, decrypted)
      writeMs = Date.now() - writeStartedAt

      // 检测实况照片（Motion Photo）
      let liveVideoPath: string | undefined
      if (!this.isThumbnailPath(datPath) && (finalExt === '.jpg' || finalExt === '.jpeg')) {
        const motionStartedAt = Date.now()
        const vp = await this.extractMotionPhotoVideo(outputPath, decrypted)
        motionVideoMs = Date.now() - motionStartedAt
        if (vp) liveVideoPath = this.filePathToUrl(vp)
      }

      const isThumb = this.isThumbnailPath(datPath)

      // 如果图片是完整的，才缓存路径映射（不完整的下次重新解密）
      if (isImageComplete) {
        this.cacheSessionDatRoot(accountDir, payload.sessionId, datPath)
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
        if (!isThumb) {
          this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
          const thumbnailCleanupStartedAt = Date.now()
          this.deleteThumbnailByKeysInDir(this.getCacheKeys(payload), dirname(outputPath))
          thumbnailCleanupMs = Date.now() - thumbnailCleanupStartedAt
        }
      }

      // 对于 hevc 格式，返回错误提示用户安装 ffmpeg
      if (finalExt === '.hevc') {
        console.warn(`[ImageDecrypt] 检测到 wxgf/hevc 格式图片，但未启用转换或转换失败: ${cacheKey}`)
        this.logDecryptTiming({
          cacheKey,
          payload,
          datPath,
          resolveSource: datDiagnostics.source,
          resolveDatMs,
          cacheLookupMs,
          decryptMs,
          wxgfMs,
          writeMs,
          motionVideoMs,
          thumbnailCleanupMs,
          decryptSource,
          fallbackReason,
          finalExt: finalExtForLog,
          usedCachedOutput,
          nativeFallbackUsed,
          wxgfDetected,
          status: 'hevc_unavailable',
          totalMs: Date.now() - totalStartedAt
        })
        return {
          success: false,
          error: '此图片为微信新格式(wxgf)，需要安装 ffmpeg 才能显示。请运行: winget install ffmpeg',
          isThumb
        }
      }

      const localPath = this.filePathToUrl(outputPath)
      this.emitCacheResolved(payload, cacheKey, localPath)
      this.logDecryptTiming({
        cacheKey,
        payload,
        datPath,
        resolveSource: datDiagnostics.source,
        resolveDatMs,
        cacheLookupMs,
        decryptMs,
        wxgfMs,
        writeMs,
        motionVideoMs,
        thumbnailCleanupMs,
        decryptSource,
        fallbackReason,
        finalExt: finalExtForLog,
        usedCachedOutput,
        nativeFallbackUsed,
        wxgfDetected,
        status: 'success',
        totalMs: Date.now() - totalStartedAt
      })

      return { success: true, localPath, isThumb, liveVideoPath }
    } catch (e) {
      this.logDecryptTiming({
        cacheKey,
        payload,
        datPath,
        resolveSource: datDiagnostics.source,
        resolveDatMs,
        cacheLookupMs,
        decryptMs,
        wxgfMs,
        writeMs,
        motionVideoMs,
        thumbnailCleanupMs,
        decryptSource,
        fallbackReason,
        finalExt: finalExtForLog,
        usedCachedOutput,
        nativeFallbackUsed,
        wxgfDetected,
        status: 'error',
        totalMs: Date.now() - totalStartedAt,
        error: String(e)
      })
      console.error(`[ImageDecrypt] 解密异常: ${cacheKey}`, e)
      return { success: false, error: String(e) }
    }
  }

  private logDecryptTiming(details: {
    cacheKey: string
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean; quick?: boolean }
    datPath: string | null
    resolveSource?: string
    resolveDatMs: number
    cacheLookupMs: number
    decryptMs: number
    wxgfMs: number
    writeMs: number
    motionVideoMs: number
    thumbnailCleanupMs: number
    decryptSource: 'native' | 'ts' | 'none'
    fallbackReason?: string
    finalExt?: string
    usedCachedOutput: boolean
    nativeFallbackUsed: boolean
    wxgfDetected: boolean
    status: 'success' | 'cache_hit' | 'plain_file' | 'missing_dat' | 'missing_hd' | 'hevc_unavailable' | 'error'
    totalMs: number
    error?: string
  }): void {
    if (process.env.CIPHERTALK_IMAGE_DECRYPT_DEBUG !== '1') return

    const shouldLog =
      details.status !== 'success' ||
      details.totalMs >= 300 ||
      details.resolveDatMs >= 120 ||
      details.cacheLookupMs >= 80 ||
      details.decryptMs >= 100 ||
      details.wxgfMs >= 100 ||
      details.writeMs >= 80 ||
      details.motionVideoMs >= 120 ||
      details.thumbnailCleanupMs >= 80 ||
      details.nativeFallbackUsed ||
      details.resolveSource === 'search' ||
      details.resolveSource === 'search_normalized'

    if (!shouldLog) return

    console.info('[ImageDecrypt] 耗时分析', {
      cacheKey: details.cacheKey,
      sessionId: details.payload.sessionId,
      imageDatName: details.payload.imageDatName,
      imageMd5: details.payload.imageMd5,
      force: Boolean(details.payload.force),
      quick: Boolean(details.payload.quick),
      status: details.status,
      datPath: details.datPath,
      resolveSource: details.resolveSource || 'unknown',
      usedCachedOutput: details.usedCachedOutput,
      decryptSource: details.decryptSource,
      fallbackReason: details.fallbackReason || null,
      wxgfDetected: details.wxgfDetected,
      finalExt: details.finalExt || null,
      totalMs: details.totalMs,
      resolveDatMs: details.resolveDatMs,
      cacheLookupMs: details.cacheLookupMs,
      decryptMs: details.decryptMs,
      wxgfMs: details.wxgfMs,
      writeMs: details.writeMs,
      motionVideoMs: details.motionVideoMs,
      thumbnailCleanupMs: details.thumbnailCleanupMs,
      error: details.error || null
    })
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const cleanedWxid = this.cleanAccountDirName(wxid)
    const normalized = dbPath.replace(/[\\/]+$/, '')

    // 1. 直接匹配原始 wxid
    const directOriginal = join(normalized, wxid)
    if (existsSync(directOriginal)) return directOriginal

    // 2. 直接匹配清理后的 wxid
    if (cleanedWxid !== wxid) {
      const directCleaned = join(normalized, cleanedWxid)
      if (existsSync(directCleaned)) return directCleaned
    }

    if (this.isAccountDir(normalized)) return normalized

    // 3. 扫描目录查找匹配
    try {
      const entries = readdirSync(normalized)
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()
      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue
        const lowerEntry = entry.toLowerCase()

        // 精确匹配或前缀匹配
        if (lowerEntry === wxidLower || lowerEntry === cleanedWxidLower ||
          lowerEntry.startsWith(`${wxidLower}_`) || lowerEntry.startsWith(`${cleanedWxidLower}_`)) {
          if (this.isAccountDir(entryPath)) return entryPath
        }
      }
    } catch { }

    return null
  }

  /**
   * 获取解密后的缓存目录（用于查找 hardlink.db）
   */
  private getDecryptedCacheDir(wxid: string): string | null {
    // 获取有效的缓存路径（配置的或默认的）
    const configuredPath = this.configService.get('cachePath')
    const cachePath = configuredPath || this.getDefaultCachePath()

    const cleanedWxid = this.cleanAccountDirName(wxid)

    // 1. 先尝试原始 wxid
    const cacheAccountDirOriginal = join(cachePath, wxid)
    if (existsSync(join(cacheAccountDirOriginal, 'hardlink.db'))) {
      return cacheAccountDirOriginal
    }

    // 2. 再尝试清理后的 wxid
    if (cleanedWxid !== wxid) {
      const cacheAccountDirCleaned = join(cachePath, cleanedWxid)
      if (existsSync(join(cacheAccountDirCleaned, 'hardlink.db'))) {
        return cacheAccountDirCleaned
      }
    }

    // 3. 检查根目录
    if (existsSync(join(cachePath, 'hardlink.db'))) {
      return cachePath
    }

    return null
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'hardlink.db')) ||
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2')) ||
      existsSync(join(dirPath, 'msg', 'attach'))  // 新版微信图片存储位置
    )
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  private buildLookupCacheKey(payload: ImageLookupPayload, cacheKey: string): string {
    return [
      String(cacheKey || '').trim().toLowerCase(),
      String(payload.sessionId || '').trim().toLowerCase(),
      String(payload.createTime || 0)
    ].join('|')
  }

  private async resolveDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string,
    createTime?: number,
    options?: { allowThumbnail?: boolean; skipResolvedCache?: boolean; skipSearchFallback?: boolean },
    diagnostics?: ResolveDatDiagnostics
  ): Promise<string | null> {
    const allowThumbnail = options?.allowThumbnail ?? true
    const skipResolvedCache = options?.skipResolvedCache ?? false
    const skipSearchFallback = options?.skipSearchFallback ?? false

    // 优先通过 hardlink.db 查询
    if (imageMd5) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) {
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          diagnostics && (diagnostics.source = 'hardlink')
          this.cacheSessionDatRoot(accountDir, sessionId, hardlinkPath)
          this.cacheDatPath(accountDir, imageMd5, hardlinkPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        // 尝试在同一目录下查找高清图变体（快速查找）
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
        if (hdPath) {
          diagnostics && (diagnostics.source = 'hardlink_hd_same_dir')
          this.cacheSessionDatRoot(accountDir, sessionId, hdPath)
          this.cacheDatPath(accountDir, imageMd5, hdPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        // 同目录没找到高清图，尝试在该目录下搜索
        const hdInDir = await this.searchDatFileInDir(dirname(hardlinkPath), imageDatName || imageMd5 || '', false)
        if (hdInDir) {
          diagnostics && (diagnostics.source = 'hardlink_hd_dir_scan')
          this.cacheSessionDatRoot(accountDir, sessionId, hdInDir)
          this.cacheDatPath(accountDir, imageMd5, hdInDir)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hdInDir)
          return hdInDir
        }
        // 该目录也没找到；如果有消息时间，继续按会话月份精确查找旧图。
        if (!createTime && !imageDatName) return null
      }
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath) {
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          diagnostics && (diagnostics.source = 'hardlink')
          this.cacheSessionDatRoot(accountDir, sessionId, hardlinkPath)
          this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
        if (hdPath) {
          diagnostics && (diagnostics.source = 'hardlink_hd_same_dir')
          this.cacheSessionDatRoot(accountDir, sessionId, hdPath)
          this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        // 同目录没找到高清图，尝试在该目录下搜索
        const hdInDir = await this.searchDatFileInDir(dirname(hardlinkPath), imageDatName, false)
        if (hdInDir) {
          diagnostics && (diagnostics.source = 'hardlink_hd_dir_scan')
          this.cacheSessionDatRoot(accountDir, sessionId, hdInDir)
          this.cacheDatPath(accountDir, imageDatName, hdInDir)
          return hdInDir
        }
        if (!createTime) return null
      }
    }

    const primaryDatName = imageDatName || imageMd5
    if (!primaryDatName) {
      return null
    }

    const indexedPath = this.getIndexedDatPath(accountDir, [primaryDatName, imageMd5, imageDatName], allowThumbnail)
    if (indexedPath) {
      diagnostics && (diagnostics.source = 'dat_path_index')
      this.cacheSessionDatRoot(accountDir, sessionId, indexedPath)
      for (const name of [primaryDatName, imageMd5, imageDatName]) {
        if (name) this.cacheDatPath(accountDir, name, indexedPath)
      }
      return indexedPath
    }

    const monthPath = this.searchDatInSessionMonth(accountDir, sessionId, primaryDatName, createTime, allowThumbnail)
    if (monthPath) {
      diagnostics && (diagnostics.source = 'session_month')
      this.cacheSessionDatRoot(accountDir, sessionId, monthPath)
      this.resolvedCache.set(primaryDatName, monthPath)
      this.cacheDatPath(accountDir, primaryDatName, monthPath)
      if (imageMd5) this.cacheDatPath(accountDir, imageMd5, monthPath)
      if (imageDatName) this.cacheDatPath(accountDir, imageDatName, monthPath)
      return monthPath
    }

    if (!imageDatName) {
      imageDatName = primaryDatName
    }

    if (!skipResolvedCache) {
      const cached = this.resolvedCache.get(imageDatName)
      if (cached && existsSync(cached)) {
        if (allowThumbnail || !this.isThumbnailPath(cached)) {
          diagnostics && (diagnostics.source = 'resolved_cache')
          this.cacheSessionDatRoot(accountDir, sessionId, cached)
          return cached
        }
        // 缓存的是缩略图，尝试找高清图
        const hdPath = this.findHdVariantInSameDir(cached)
        if (hdPath) {
          diagnostics && (diagnostics.source = 'resolved_cache_hd_same_dir')
          this.cacheSessionDatRoot(accountDir, sessionId, hdPath)
          return hdPath
        }
        // 同目录没找到，尝试在该目录下搜索
        const hdInDir = await this.searchDatFileInDir(dirname(cached), imageDatName, false)
        if (hdInDir) {
          diagnostics && (diagnostics.source = 'resolved_cache_hd_dir_scan')
          this.cacheSessionDatRoot(accountDir, sessionId, hdInDir)
          return hdInDir
        }
      }
    }

    const sessionHashRoot = this.resolveSessionHashDatRoot(accountDir, sessionId)
    if (sessionHashRoot) {
      const sessionHashPath = this.searchDatInSessionRoot(sessionHashRoot, imageDatName, allowThumbnail)
      if (sessionHashPath) {
        diagnostics && (diagnostics.source = 'session_hash_root')
        this.cacheSessionDatRoot(accountDir, sessionId, sessionHashPath)
        this.resolvedCache.set(imageDatName, sessionHashPath)
        this.cacheDatPath(accountDir, imageDatName, sessionHashPath)
        return sessionHashPath
      }
      const normalized = this.normalizeDatBase(imageDatName)
      if (normalized !== imageDatName.toLowerCase()) {
        const normalizedSessionHashPath = this.searchDatInSessionRoot(sessionHashRoot, normalized, allowThumbnail)
        if (normalizedSessionHashPath) {
          diagnostics && (diagnostics.source = 'session_hash_root_normalized')
          this.cacheSessionDatRoot(accountDir, sessionId, normalizedSessionHashPath)
          this.resolvedCache.set(imageDatName, normalizedSessionHashPath)
          this.cacheDatPath(accountDir, imageDatName, normalizedSessionHashPath)
          return normalizedSessionHashPath
        }
      }
    }

    const cachedSessionDir = this.getCachedSessionDatDir(accountDir, sessionId)
    if (cachedSessionDir) {
      const directSessionPath = this.searchDatInKnownDir(cachedSessionDir, imageDatName, allowThumbnail)
      if (directSessionPath) {
        diagnostics && (diagnostics.source = 'session_dir_cache')
        this.cacheSessionDatRoot(accountDir, sessionId, directSessionPath)
        this.resolvedCache.set(imageDatName, directSessionPath)
        this.cacheDatPath(accountDir, imageDatName, directSessionPath)
        return directSessionPath
      }
      const normalized = this.normalizeDatBase(imageDatName)
      if (normalized !== imageDatName.toLowerCase()) {
        const normalizedDirectSessionPath = this.searchDatInKnownDir(cachedSessionDir, normalized, allowThumbnail)
        if (normalizedDirectSessionPath) {
          diagnostics && (diagnostics.source = 'session_dir_cache_normalized')
          this.cacheSessionDatRoot(accountDir, sessionId, normalizedDirectSessionPath)
          this.resolvedCache.set(imageDatName, normalizedDirectSessionPath)
          this.cacheDatPath(accountDir, imageDatName, normalizedDirectSessionPath)
          return normalizedDirectSessionPath
        }
      }
    }

    const cachedSessionRoot = this.getCachedSessionDatRoot(accountDir, sessionId)
    if (cachedSessionRoot) {
      const sessionPath = this.searchDatInSessionRoot(cachedSessionRoot, imageDatName, allowThumbnail)
      if (sessionPath) {
        diagnostics && (diagnostics.source = 'session_root_cache')
        this.cacheSessionDatRoot(accountDir, sessionId, sessionPath)
        this.resolvedCache.set(imageDatName, sessionPath)
        this.cacheDatPath(accountDir, imageDatName, sessionPath)
        return sessionPath
      }
      const normalized = this.normalizeDatBase(imageDatName)
      if (normalized !== imageDatName.toLowerCase()) {
        const normalizedSessionPath = this.searchDatInSessionRoot(cachedSessionRoot, normalized, allowThumbnail)
        if (normalizedSessionPath) {
          diagnostics && (diagnostics.source = 'session_root_cache_normalized')
          this.cacheSessionDatRoot(accountDir, sessionId, normalizedSessionPath)
          this.resolvedCache.set(imageDatName, normalizedSessionPath)
          this.cacheDatPath(accountDir, imageDatName, normalizedSessionPath)
          return normalizedSessionPath
        }
      }
    }

    if (!skipSearchFallback) {
      // 只有在 hardlink 完全没有记录时才搜索文件夹
      const datPath = await this.searchDatFile(accountDir, imageDatName, allowThumbnail, false, createTime)
      if (datPath) {
        diagnostics && (diagnostics.source = 'search')
        this.cacheSessionDatRoot(accountDir, sessionId, datPath)
        this.resolvedCache.set(imageDatName, datPath)
        this.cacheDatPath(accountDir, imageDatName, datPath)
        return datPath
      }
      const normalized = this.normalizeDatBase(imageDatName)
      if (normalized !== imageDatName.toLowerCase()) {
        const normalizedPath = await this.searchDatFile(accountDir, normalized, allowThumbnail, false, createTime)
        if (normalizedPath) {
          diagnostics && (diagnostics.source = 'search_normalized')
          this.cacheSessionDatRoot(accountDir, sessionId, normalizedPath)
          this.resolvedCache.set(imageDatName, normalizedPath)
          this.cacheDatPath(accountDir, imageDatName, normalizedPath)
          return normalizedPath
        }
      }
    }
    return null
  }

  /**
   * 在同一目录下查找高清图变体
   * 缩略图: xxx_t.dat -> 高清图: xxx_h.dat 或 xxx.dat
   */
  private findHdVariantInSameDir(thumbPath: string): string | null {
    try {
      const dir = dirname(thumbPath)
      const fileName = basename(thumbPath).toLowerCase()

      // Extract base name by stripping _t/_t_W/_t_NW/.t and similar thumbnail suffixes
      let baseName = fileName
      if (baseName.endsWith('.dat')) baseName = baseName.slice(0, -4)
      const thumbMatch = baseName.match(/^(.+?)[_.]t(?:_[a-z]+)?$/i)
      if (!thumbMatch) return null
      baseName = thumbMatch[1]

      // Try HD variants including _h_W, _h_NW etc.
      const variants = [
        `${baseName}_h.dat`,
        `${baseName}.h.dat`,
        `${baseName}_h_w.dat`,
        `${baseName}_h_nw.dat`,
        `${baseName}.dat`
      ]

      for (const variant of variants) {
        const variantPath = join(dir, variant)
        if (existsSync(variantPath)) {
          return variantPath
        }
      }
    } catch { }
    return null
  }

  private async resolveThumbnailDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string
  ): Promise<string | null> {
    if (imageMd5) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageDatName) return null
    return this.searchDatFile(accountDir, imageDatName, true, true)
  }

  private async checkHasUpdate(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): Promise<boolean> {
    if (!cachedPath || !existsSync(cachedPath)) return false
    const isThumbnail = this.isThumbnailPath(cachedPath)
    if (!isThumbnail) return false
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return false
    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return false

    const quickDir = this.getCachedDatDir(accountDir, payload.imageDatName, payload.imageMd5)
    if (quickDir) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(quickDir, baseName)
      if (candidate) {
        return true
      }
    }

    const thumbPath = await this.resolveThumbnailDatPath(
      accountDir,
      payload.imageMd5,
      payload.imageDatName,
      payload.sessionId
    )
    if (thumbPath) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(dirname(thumbPath), baseName)
      if (candidate) {
        return true
      }
      const searchHit = await this.searchDatFileInDir(dirname(thumbPath), baseName, false)
      if (searchHit && this.isNonThumbnailVariantDat(searchHit)) {
        return true
      }
    }
    return false
  }

  private triggerUpdateCheck(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): void {
    if (this.updateFlags.get(cacheKey)) return
    void this.checkHasUpdate(payload, cacheKey, cachedPath).then((hasUpdate) => {
      if (!hasUpdate) return
      this.updateFlags.set(cacheKey, true)
      this.emitImageUpdate(payload, cacheKey)
    }).catch(() => { })
  }

  private looksLikeMd5(value: string): boolean {
    return /^[a-fA-F0-9]{16,32}$/.test(value)
  }

  private async resolveHardlinkPath(accountDir: string, md5: string, sessionId?: string): Promise<string | null> {
    // 优先从解密后的缓存目录查找 hardlink.db 路径（仅用于判断是否存在，native 负责实际打开）
    const wxid = this.configService.get('myWxid')
    const cacheDir = wxid ? this.getDecryptedCacheDir(wxid) : null

    // 收集所有可能的 hardlink.db 路径（用于判断是否有任一可用）
    const hardlinkPaths: string[] = []
    if (cacheDir) {
      const cachePath = join(cacheDir, 'hardlink.db')
      if (existsSync(cachePath)) hardlinkPaths.push(cachePath)
    }
    const accountPath = join(accountDir, 'hardlink.db')
    if (existsSync(accountPath) && !hardlinkPaths.includes(accountPath)) {
      hardlinkPaths.push(accountPath)
    }

    // Mac: 动态扫描 xwechat_files 下各子目录的 hardlink 路径
    if (process.platform === 'darwin' && wxid) {
      const home = (await import('os')).homedir()
      const xwechatRoot = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
      if (existsSync(xwechatRoot)) {
        try {
          for (const entry of readdirSync(xwechatRoot)) {
            const candidate = join(xwechatRoot, entry, 'db_storage', 'hardlink')
            if (existsSync(candidate) && !hardlinkPaths.includes(candidate)) {
              hardlinkPaths.push(candidate)
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (hardlinkPaths.length === 0) {
      return null
    }

    try {
      const state = await this.getHardlinkState(accountDir)
      if (!state.imageTable) {
        return null
      }

      const row = await dbAdapter.get<{ dir1?: number; dir2?: number; file_name?: string }>(
        'hardlink',
        '',
        `SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE lower(md5) = lower(?) LIMIT 1`,
        [md5]
      )

      if (!row) {
        return null
      }

      const { dir1, dir2, file_name: fileName } = row
      if (dir1 === undefined || dir2 === undefined || !fileName) return null

      const lowerFileName = fileName.toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const baseLower = lowerFileName.slice(0, -4)
        if (!this.isLikelyImageDatBase(baseLower) && !this.looksLikeMd5(baseLower)) {
          return null
        }
      }

      // dir1 和 dir2 是 rowid，需要从 dir2id 表查询对应的目录名
      let dir1Name: string | null = null
      let dir2Name: string | null = null

      if (state.dirTable) {
        try {
          const dir1Row = await dbAdapter.get<{ username?: string }>(
            'hardlink',
            '',
            `SELECT username FROM ${state.dirTable} WHERE rowid = ? LIMIT 1`,
            [dir1]
          )
          if (dir1Row?.username) dir1Name = dir1Row.username

          const dir2Row = await dbAdapter.get<{ username?: string }>(
            'hardlink',
            '',
            `SELECT username FROM ${state.dirTable} WHERE rowid = ? LIMIT 1`,
            [dir2]
          )
          if (dir2Row?.username) dir2Name = dir2Row.username
        } catch {
          // ignore
        }
      }

      if (!dir1Name || !dir2Name) {
        return null
      }

      // 构建可能的所有路径结构（仅限 msg/attach）
      const possiblePaths = [
        // 常见结构: msg/attach/xx/yy/Img/name
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'Img', fileName),
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'mg', fileName),
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, fileName),
      ]

      for (const fullPath of possiblePaths) {
        if (existsSync(fullPath)) {
          return fullPath
        }
      }
    } catch {
      // ignore
    }

    return null
  }

  private async getHardlinkState(accountDir: string): Promise<HardlinkState> {
    const cached = this.hardlinkCache.get(accountDir)
    if (cached) return cached

    const imageRow = await dbAdapter.get<{ name?: string }>(
      'hardlink',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1"
    )
    const dirRow = await dbAdapter.get<{ name?: string }>(
      'hardlink',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1"
    )
    const state: HardlinkState = {
      imageTable: imageRow?.name as string | undefined,
      dirTable: dirRow?.name as string | undefined
    }
    this.hardlinkCache.set(accountDir, state)
    return state
  }

  private async searchDatFile(
    accountDir: string,
    datName: string,
    allowThumbnail = true,
    thumbOnly = false,
    createTime?: number
  ): Promise<string | null> {
    const key = `${accountDir}|${datName}`
    const cached = this.resolvedCache.get(key)
    if (cached && existsSync(cached)) {
      if (allowThumbnail || !this.isThumbnailPath(cached)) return cached
    }

    const root = join(accountDir, 'msg', 'attach')
    if (!existsSync(root)) return null

    // 优化1：快速概率性查找
    // 包含：1. 基于文件名的前缀猜测 (旧版)
    //       2. 基于日期的最近月份扫描 (新版无索引时)
    const fastHit = await this.fastProbabilisticSearch(root, datName, createTime)
    if (fastHit) {
      this.resolvedCache.set(key, fastHit)
      return fastHit
    }

    // 优化2：兜底查全量索引（首次构建一次，之后 O(1)；替代原每次未命中的全盘 BFS）
    let index = await this.ensureFullDatIndex(root)
    let found = this.lookupFullDatIndex(index, datName, allowThumbnail, thumbOnly)
    if (!found && Date.now() - this.fullDatIndexBuiltAt > 60_000) {
      // 未命中且索引超过 60s：可能是索引建成后新落盘的文件，重建一次再查
      index = await this.rebuildFullDatIndex(root)
      found = this.lookupFullDatIndex(index, datName, allowThumbnail, thumbOnly)
    }
    if (found) {
      this.resolvedCache.set(key, found)
      return found
    }
    return null
  }

  private ensureFullDatIndex(root: string): Promise<Map<string, string[]>> {
    if (this.fullDatIndex && this.fullDatIndexRoot === root) {
      return Promise.resolve(this.fullDatIndex)
    }
    if (!this.fullDatIndexPromise || this.fullDatIndexRoot !== root) {
      this.fullDatIndexRoot = root
      this.fullDatIndexPromise = this.buildFullDatIndex(root).then((idx) => {
        this.fullDatIndex = idx
        this.fullDatIndexBuiltAt = Date.now()
        return idx
      })
    }
    return this.fullDatIndexPromise
  }

  private rebuildFullDatIndex(root: string): Promise<Map<string, string[]>> {
    this.fullDatIndex = null
    this.fullDatIndexPromise = null
    return this.ensureFullDatIndex(root)
  }

  private async buildFullDatIndex(root: string): Promise<Map<string, string[]>> {
    const { promises: fsp } = require('fs')
    const { join } = require('path')
    const started = Date.now()
    const index = new Map<string, string[]>()
    let fileCount = 0
    const queue: string[] = [root]
    while (queue.length > 0) {
      const batch = queue.splice(0, 16)
      await Promise.all(batch.map(async (dir: string) => {
        let entries: any[] = []
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            queue.push(full)
          } else if (entry.name.toLowerCase().endsWith('.dat')) {
            fileCount++
            const base = this.normalizeDatBase(entry.name)
            const list = index.get(base)
            if (list) list.push(full)
            else index.set(base, [full])
          }
        }
      }))
    }
    console.log(`[ImageDecrypt] 全量 dat 索引构建完成: ${fileCount} 个文件 / ${index.size} 个基名, 耗时 ${Date.now() - started}ms`)
    return index
  }

  private lookupFullDatIndex(
    index: Map<string, string[]>,
    datName: string,
    allowThumbnail: boolean,
    thumbOnly: boolean
  ): string | null {
    const candidates = index.get(this.normalizeDatBase(datName)) || []
    for (const p of candidates) {
      const name = basename(p)
      const isThumb = this.isThumbnailDat(name.toLowerCase())
      if (thumbOnly && !isThumb) continue
      if (!allowThumbnail && isThumb) continue
      if (this.matchesDatName(name, datName) && existsSync(p)) return p
    }
    return null
  }

  /**
   * 基于文件名的哈希特征猜测可能的路径
   * 包含：1. 微信旧版结构 filename.substr(0, 2)/...
   *       2. 微信新版结构 msg/attach/{hash}/{YYYY-MM}/Img/filename
   */
  private async fastProbabilisticSearch(root: string, datName: string, createTime?: number): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    try {
      // --- 策略 A: 旧版路径猜测 (msg/attach/xx/yy/...) ---
      const lowerName = datName.toLowerCase()
      let baseName = lowerName
      if (baseName.endsWith('.dat')) {
        baseName = baseName.slice(0, -4)
        // Strip variant suffixes like _t, _h, _t_W, _t_NW, _h_W, _hd, _thumb
        baseName = baseName.replace(/[_.](?:t|h|hd|thumb)(?:_[a-z]+)?$/, '')
      }

      const candidates: string[] = []
      if (/^[a-f0-9]{32}$/.test(baseName)) {
        const dir1 = baseName.substring(0, 2)
        const dir2 = baseName.substring(2, 4)
        candidates.push(
          join(root, dir1, dir2, datName),
          join(root, dir1, dir2, 'Img', datName),
          join(root, dir1, dir2, 'mg', datName),
          join(root, dir1, dir2, 'Image', datName)
        )
      }

      for (const path of candidates) {
        try {
          await fs.access(path)
          return path
        } catch { }
      }

      // --- 策略 B: 新版 Session 哈希路径猜测 ---
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        const sessionDirs = entries
          .filter((e: any) => e.isDirectory() && e.name.length === 32 && /^[a-f0-9]+$/i.test(e.name))
          .map((e: any) => e.name)

        if (sessionDirs.length === 0) return null

        const months = this.buildDatSearchMonthHints(createTime)

        const targetNames = [datName]
        if (baseName !== lowerName) {
          targetNames.push(`${baseName}.dat`)
          targetNames.push(`${baseName}_t.dat`)
          targetNames.push(`${baseName}_thumb.dat`)
        }

        const batchSize = 20
        for (let i = 0; i < sessionDirs.length; i += batchSize) {
          const batch = sessionDirs.slice(i, i + batchSize)
          const tasks = batch.map(async (sessDir: string) => {
            for (const month of months) {
              const subDirs = ['Img', 'Image']
              for (const sub of subDirs) {
                const dirPath = join(root, sessDir, month, sub)
                try { await fs.access(dirPath) } catch { continue }
                for (const name of targetNames) {
                  const p = join(dirPath, name)
                  try { await fs.access(p); return p } catch { }
                }
              }
            }
            return null
          })
          const results = await Promise.all(tasks)
          const hit = results.find(r => r !== null)
          if (hit) return hit
        }
      } catch { }

    } catch { }
    return null
  }

  private async searchDatFileInDir(
    dirPath: string,
    datName: string,
    allowThumbnail = true
  ): Promise<string | null> {
    if (!existsSync(dirPath)) return null
    return await this.walkForDatInWorker(dirPath, datName.toLowerCase(), 3, allowThumbnail, false)
  }

  private async walkForDatInWorker(
    root: string,
    datName: string,
    maxDepth = 4,
    allowThumbnail = true,
    thumbOnly = false
  ): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    // 广度优先搜索 (BFS) 队列
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
    const targetBase = this.normalizeDatBase(datName.toLowerCase())

    while (queue.length > 0) {
      // 每次取出一批并行处理，提高 IO 吞吐
      const batchSize = 10
      const batch = queue.splice(0, batchSize)

      const results = await Promise.all(batch.map(async ({ path: currentPath, depth }) => {
        if (depth > maxDepth) return null
        try {
          const entries = await fs.readdir(currentPath, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(currentPath, entry.name)
            if (entry.isDirectory()) {
              queue.push({ path: fullPath, depth: depth + 1 })
            } else if (entry.isFile()) {
              const lowerName = entry.name.toLowerCase()
              if (!lowerName.endsWith('.dat')) continue

              const isThumb = this.isThumbnailDat(lowerName)
              if (thumbOnly && !isThumb) continue
              if (!allowThumbnail && isThumb) continue

              if (this.matchesDatName(entry.name, datName)) {
                return fullPath
              }
            }
          }
        } catch { }
        return null
      }))

      const found = results.find(r => r !== null)
      if (found) return found
    }
    return null
  }

  private matchesDatName(fileName: string, datName: string): boolean {
    const lower = fileName.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedBase = this.normalizeDatBase(base)
    const normalizedTarget = this.normalizeDatBase(datName.toLowerCase())
    if (normalizedBase === normalizedTarget) return true
    const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`, 'i')
    if (pattern.test(lower)) return true
    return lower.endsWith('.dat') && lower.includes(datName)
  }

  private scoreDatName(fileName: string): number {
    if (fileName.includes('.t.dat') || fileName.includes('_t.dat')) return 1
    if (fileName.includes('.c.dat') || fileName.includes('_c.dat')) return 1
    return 2
  }

  private isThumbnailDat(fileName: string): boolean {
    const lower = fileName.toLowerCase()
    return (
      /[._]t(?:_[a-z]+)?\.dat$/.test(lower) ||
      lower.includes('_thumb.dat')
    )
  }

  private hasXVariant(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isThumbnailPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    if (this.isThumbnailDat(lower)) return true
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    // 支持新命名 _thumb 和旧命名 _t
    return (
      base.endsWith('_t') ||
      base.endsWith('_thumb') ||
      base.endsWith('.t')
    )
  }

  private isHdPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    return base.endsWith('_hd') || base.endsWith('_h')
  }

  private hasImageVariantSuffix(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isLikelyImageDatBase(baseLower: string): boolean {
    return this.hasImageVariantSuffix(baseLower) || this.looksLikeMd5(baseLower)
  }

  private normalizeDatBase(name: string): string {
    let base = name.toLowerCase()
    if (base.endsWith('.dat') || base.endsWith('.jpg')) {
      base = base.slice(0, -4)
    }
    while (/[._][a-z]$/.test(base)) {
      base = base.slice(0, -2)
    }
    return base
  }

  private findCachedOutput(cacheKey: string, sessionId?: string, preferHd: boolean = false): string | null {
    const allRoots = this.getAllCacheRoots()
    const normalizedKey = this.normalizeDatBase(cacheKey.toLowerCase())
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    // 校验缓存文件是否存在且完整，不完整的自动删除
    const validateCached = (filePath: string): boolean => {
      return this.validateCachedImageFile(filePath)
    }

    // 遍历所有可能的缓存根路径
    for (const root of allRoots) {
      // 新目录结构: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg 或 _hd.jpg
      // 需要遍历 sessionId 目录下的所有日期目录
      if (sessionId) {
        const sessionDir = join(root, sessionId)
        if (existsSync(sessionDir)) {
          try {
            const dateDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)
              .sort()
              .reverse() // 最新的日期优先

            for (const dateDir of dateDirs) {
              const imageDir = join(sessionDir, dateDir)
              // 清理旧的 .hevc 文件
              this.cleanupHevcFiles(imageDir, normalizedKey)
              for (const ext of extensions) {
                if (preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (validateCached(hdPath)) return hdPath
                }
                const thumbPath = join(imageDir, `${normalizedKey}_thumb${ext}`)
                if (validateCached(thumbPath)) return thumbPath
                if (!preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (validateCached(hdPath)) return hdPath
                }
              }
            }
          } catch { }
        }
      }

      // 遍历所有 sessionId 目录查找
      try {
        const sessionDirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)

        for (const session of sessionDirs) {
          const sessionDir = join(root, session)
          // 检查是否是日期目录结构
          try {
            const subDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)

            for (const dateDir of subDirs) {
              const imageDir = join(sessionDir, dateDir)
              // 清理旧的 .hevc 文件
              this.cleanupHevcFiles(imageDir, normalizedKey)
              for (const ext of extensions) {
                if (preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (validateCached(hdPath)) return hdPath
                }
                const thumbPath = join(imageDir, `${normalizedKey}_thumb${ext}`)
                if (validateCached(thumbPath)) return thumbPath
                if (!preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (validateCached(hdPath)) return hdPath
                }
              }
            }
          } catch { }
        }
      } catch { }

      // 兼容旧目录结构: Images/{normalizedKey}/{normalizedKey}_thumb.jpg
      const oldImageDir = join(root, normalizedKey)
      if (existsSync(oldImageDir)) {
        // 清理旧的 .hevc 文件
        this.cleanupHevcFiles(oldImageDir, normalizedKey)
        for (const ext of extensions) {
          if (preferHd) {
            const hdPath = join(oldImageDir, `${normalizedKey}_hd${ext}`)
            if (validateCached(hdPath)) return hdPath
          }
          const thumbPath = join(oldImageDir, `${normalizedKey}_thumb${ext}`)
          if (validateCached(thumbPath)) return thumbPath
          if (!preferHd) {
            const hdPath = join(oldImageDir, `${normalizedKey}_hd${ext}`)
            if (validateCached(hdPath)) return hdPath
          }
        }
      }

      // 兼容最旧的平铺结构
      for (const ext of extensions) {
        const candidate = join(root, `${cacheKey}${ext}`)
        if (validateCached(candidate)) return candidate
      }
    }

    return null
  }

  /**
   * 快速查找缓存文件（直接构造路径，不遍历目录）
   * 用于 resolveCachedImage，避免全局扫描
   */
  private findCachedOutputFast(cacheKey: string, sessionId?: string, preferHd: boolean = false, createTime?: number): string | null {
    if (!sessionId) return null

    const normalizedKey = this.normalizeDatBase(cacheKey.toLowerCase())
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    const allRoots = this.getAllCacheRoots()
    const dateDirs = this.buildCacheMonthHints(createTime)

    // 直接构造路径并检查文件是否存在
    for (const root of allRoots) {
      for (const dateDir of dateDirs) {
        const imageDir = join(root, sessionId, dateDir)

        // 批量构造所有可能的路径
        const candidates: string[] = []

        if (preferHd) {
          // 优先高清图
          for (const ext of extensions) {
            candidates.push(join(imageDir, `${normalizedKey}_hd${ext}`))
          }
          for (const ext of extensions) {
            candidates.push(join(imageDir, `${normalizedKey}_thumb${ext}`))
          }
        } else {
          // 优先缩略图
          for (const ext of extensions) {
            candidates.push(join(imageDir, `${normalizedKey}_thumb${ext}`))
          }
          for (const ext of extensions) {
            candidates.push(join(imageDir, `${normalizedKey}_hd${ext}`))
          }
        }

        // 检查文件是否存在且图片数据完整
        for (const candidate of candidates) {
          if (this.validateCachedImageFile(candidate)) return candidate
        }
      }
    }

    return null
  }

  private findCachedOutputByDatPath(datPath: string, sessionId?: string, preferHd: boolean = false): string | null {
    if (!datPath || !sessionId) return null

    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedKey = this.normalizeDatBase(base)
    const dateDir = this.extractDateFromPath(datPath)
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    const suffixes = preferHd ? ['_hd', '_thumb'] : ['_thumb', '_hd']

    for (const root of this.getAllCacheRoots()) {
      const imageDir = join(root, sessionId, dateDir)
      for (const suffix of suffixes) {
        for (const ext of extensions) {
          const candidate = join(imageDir, `${normalizedKey}${suffix}${ext}`)
          if (this.validateCachedImageFile(candidate)) return candidate
        }
      }

      const oldImageDir = join(root, normalizedKey)
      for (const suffix of suffixes) {
        for (const ext of extensions) {
          const candidate = join(oldImageDir, `${normalizedKey}${suffix}${ext}`)
          if (this.validateCachedImageFile(candidate)) return candidate
        }
      }

      for (const ext of extensions) {
        const candidate = join(root, `${normalizedKey}${ext}`)
        if (this.validateCachedImageFile(candidate)) return candidate
      }
    }

    return null
  }

  private buildCacheMonthHints(createTime?: number): string[] {
    const months: string[] = []
    const add = (month: string) => {
      if (month && !months.includes(month)) months.push(month)
    }

    add(this.resolveYearMonthFromCreateTime(createTime))

    const now = new Date()
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }

    return months
  }

  private buildDatSearchMonthHints(createTime?: number): string[] {
    const months: string[] = []
    const add = (month: string) => {
      if (month && !months.includes(month)) months.push(month)
    }

    add(this.resolveYearMonthFromCreateTime(createTime))

    const now = new Date()
    for (let i = 0; i < 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }

    return months
  }

  /**
   * 快速校验缓存图片文件末尾是否完整
   * 只读取最后 64 字节进行检查，开销极小
   */
  private validateCachedImageFile(filePath: string): boolean {
    if (!existsSync(filePath) || !this.isImageFile(filePath)) return false
    try {
      const size = statSync(filePath).size
      if (size <= 100) {
        unlinkSync(filePath)
        return false
      }
      if (this.isSuspiciousBlankCachedImage(filePath, size)) {
        console.warn(`[ImageDecrypt] 发现疑似 wxgf 白图缓存，已删除并触发重解: ${filePath} (size=${size})`)
        unlinkSync(filePath)
        return false
      }
      if (!this.isFileTailValid(filePath, size)) {
        console.warn(`[ImageDecrypt] 发现不完整缓存图片，已删除: ${filePath} (size=${size})`)
        unlinkSync(filePath)
        return false
      }
      return true
    } catch {
      return false
    }
  }

  private isSuspiciousBlankCachedImage(filePath: string, fileSize: number): boolean {
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.jpg' && ext !== '.jpeg') return false
    if (fileSize > 8 * 1024) return false

    try {
      const data = readFileSync(filePath)
      return this.isProbablyBlankConvertedJpeg(data)
    } catch {
      return false
    }
  }

  private isFileTailValid(filePath: string, fileSize: number): boolean {
    try {
      const ext = filePath.toLowerCase()
      const fs = require('fs')
      const fd = fs.openSync(filePath, 'r')

      if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
        // JPEG: 末尾应有 EOI marker (0xFF 0xD9)
        const tailSize = Math.min(fileSize, 64)
        const buf = Buffer.alloc(tailSize)
        fs.readSync(fd, buf, 0, tailSize, fileSize - tailSize)
        // 检查末尾是否有 EOI marker
        for (let i = buf.length - 2; i >= 0; i--) {
          if (buf[i] === 0xFF && buf[i + 1] === 0xD9) {
            fs.closeSync(fd)
            return true
          }
        }
        // 可能是 Motion Photo（JPEG + MP4 拼接），检查文件头是否合法 JPEG
        const headBuf = Buffer.alloc(3)
        fs.readSync(fd, headBuf, 0, 3, 0)
        fs.closeSync(fd)
        // 只要文件头是 FFD8FF 且大于 1KB，认为是有效的（可能是 Motion Photo）
        if (headBuf[0] === 0xFF && headBuf[1] === 0xD8 && headBuf[2] === 0xFF && fileSize > 1024) {
          return true
        }
        return false
      }

      if (ext.endsWith('.png')) {
        // PNG: 末尾应有 IEND chunk
        const buf = Buffer.alloc(12)
        fs.readSync(fd, buf, 0, 12, fileSize - 12)
        fs.closeSync(fd)
        return buf[4] === 0x49 && buf[5] === 0x45 && buf[6] === 0x4E && buf[7] === 0x44
      }

      if (ext.endsWith('.gif')) {
        // GIF: 末尾应有 0x3B
        const buf = Buffer.alloc(1)
        fs.readSync(fd, buf, 0, 1, fileSize - 1)
        fs.closeSync(fd)
        return buf[0] === 0x3B
      }

      fs.closeSync(fd)
      // WebP 等其他格式暂不校验末尾
      return true
    } catch {
      return true // 读取失败时不阻塞，放行
    }
  }

  /**
   * 清理旧的 .hevc 文件（ffmpeg 转换失败时遗留的）
   */
  private cleanupHevcFiles(dirPath: string, normalizedKey: string): void {
    try {
      const hevcThumb = join(dirPath, `${normalizedKey}_thumb.hevc`)
      const hevcHd = join(dirPath, `${normalizedKey}_hd.hevc`)
      if (existsSync(hevcThumb)) unlinkSync(hevcThumb)
      if (existsSync(hevcHd)) unlinkSync(hevcHd)
    } catch { }
  }

  /**
   * 从 DAT 路径中提取日期（年-月）
   * 路径格式: .../2026-01/Img/xxx.dat
   */
  private extractDateFromPath(datPath: string): string {
    // 匹配 yyyy-MM 格式的日期目录
    const match = datPath.match(/[\\\/](\d{4}-\d{2})[\\\/]/i)
    if (match) {
      return match[1]
    }
    // 如果没找到，使用当前日期
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  /**
   * 生成缓存输出路径
   * 格式: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg 或 _hd.jpg
   */
  private getCacheOutputPathFromDat(datPath: string, ext: string, sessionId?: string): string {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? name.slice(0, -4) : name

    // 提取基础名称（去掉 _t, _h 等后缀）
    const normalizedBase = this.normalizeDatBase(base)

    // 判断是缩略图还是高清图
    const isThumb = this.isThumbnailDat(lower)
    const suffix = isThumb ? '_thumb' : '_hd'

    // 提取日期
    const dateDir = this.extractDateFromPath(datPath)

    // 使用 sessionId 或 'unknown' 作为会话目录
    const sessionDir = sessionId || 'unknown'

    // 分级存储: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg
    const imageDir = join(this.getCacheRoot(), sessionDir, dateDir)
    if (!existsSync(imageDir)) {
      mkdirSync(imageDir, { recursive: true })
    }

    return join(imageDir, `${normalizedBase}${suffix}${ext}`)
  }

  private cacheResolvedPaths(cacheKey: string, imageMd5: string | undefined, imageDatName: string | undefined, outputPath: string): void {
    this.resolvedCache.set(cacheKey, outputPath)
    if (imageMd5 && imageMd5 !== cacheKey) {
      this.resolvedCache.set(imageMd5, outputPath)
    }
    if (imageDatName && imageDatName !== cacheKey && imageDatName !== imageMd5) {
      this.resolvedCache.set(imageDatName, outputPath)
    }
  }

  private getCacheKeys(payload: { imageMd5?: string; imageDatName?: string }): string[] {
    const keys: string[] = []
    const addKey = (value?: string) => {
      if (!value) return
      const lower = value.toLowerCase()
      if (!keys.includes(value)) keys.push(value)
      if (!keys.includes(lower)) keys.push(lower)
      const normalized = this.normalizeDatBase(lower)
      if (normalized && !keys.includes(normalized)) keys.push(normalized)
    }
    addKey(payload.imageMd5)
    if (payload.imageDatName && payload.imageDatName !== payload.imageMd5) {
      addKey(payload.imageDatName)
    }
    return keys
  }

  private cacheDatPath(accountDir: string, datName: string, datPath: string): void {
    const key = `${accountDir}|${datName}`
    this.resolvedCache.set(key, datPath)
    const normalized = this.normalizeDatBase(datName)
    if (normalized && normalized !== datName.toLowerCase()) {
      this.resolvedCache.set(`${accountDir}|${normalized}`, datPath)
    }
    this.setDatPathIndex(accountDir, datName, datPath)
  }

  private getDatPathIndexPath(): string {
    const dir = join(getUserDataPath(), 'image-cache')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return join(dir, 'dat-path-index.json')
  }

  private ensureDatPathIndexLoaded(): void {
    if (this.datPathIndexLoaded) return
    this.datPathIndexLoaded = true

    try {
      const filePath = this.getDatPathIndexPath()
      if (!existsSync(filePath)) return
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { entries?: Array<[string, string]> }
      if (!Array.isArray(parsed.entries)) return

      for (const entry of parsed.entries) {
        const key = String(entry?.[0] || '').trim()
        const value = String(entry?.[1] || '').trim()
        if (key && value) this.datPathIndex.set(key, value)
      }
    } catch {
      this.datPathIndex.clear()
    }
  }

  private getDatPathIndexKeys(accountDir: string, datName: string): string[] {
    const account = accountDir.trim().toLowerCase()
    const lower = datName.trim().toLowerCase()
    if (!account || !lower) return []

    const keys: string[] = []
    const add = (name: string) => {
      const normalizedName = name.trim().toLowerCase()
      if (!normalizedName) return
      const key = `${account}|${normalizedName}`
      if (!keys.includes(key)) keys.push(key)
    }

    add(lower)
    add(this.normalizeDatBase(lower))
    return keys
  }

  private getIndexedDatPath(accountDir: string, datNames: Array<string | undefined>, allowThumbnail: boolean): string | null {
    this.ensureDatPathIndexLoaded()

    let removedStale = false
    const names = Array.from(new Set(datNames.filter((name): name is string => Boolean(name))))
    for (const name of names) {
      for (const key of this.getDatPathIndexKeys(accountDir, name)) {
        const cached = this.datPathIndex.get(key)
        if (!cached) continue
        if (!existsSync(cached)) {
          this.datPathIndex.delete(key)
          removedStale = true
          continue
        }
        if (allowThumbnail || !this.isThumbnailPath(cached)) return cached

        const hdPath = this.findHdVariantInSameDir(cached)
        if (hdPath) return hdPath
      }
    }

    if (removedStale) this.scheduleDatPathIndexFlush()
    return null
  }

  private setDatPathIndex(accountDir: string, datName: string, datPath: string): void {
    if (!datName || !datPath) return
    this.ensureDatPathIndexLoaded()

    let changed = false
    for (const key of this.getDatPathIndexKeys(accountDir, datName)) {
      if (!key) continue
      if (this.datPathIndex.get(key) === datPath) continue
      if (this.datPathIndex.has(key)) this.datPathIndex.delete(key)
      this.datPathIndex.set(key, datPath)
      changed = true
    }

    if (changed) this.scheduleDatPathIndexFlush()
  }

  private scheduleDatPathIndexFlush(): void {
    if (this.datPathIndexWriteTimer) return
    this.datPathIndexWriteTimer = setTimeout(() => {
      this.datPathIndexWriteTimer = null
      this.flushDatPathIndex()
    }, 1_000)
    ;(this.datPathIndexWriteTimer as any)?.unref?.()
  }

  private flushDatPathIndex(): void {
    try {
      const entries = Array.from(this.datPathIndex.entries())
        .filter(([, filePath]) => existsSync(filePath))
        .slice(-this.datPathIndexMaxEntries)

      this.datPathIndex = new Map(entries)
      writeFileSync(this.getDatPathIndexPath(), JSON.stringify({ version: 1, entries }), 'utf-8')
    } catch {
      // 索引只是加速缓存，写入失败不影响图片解密
    }
  }

  private cacheSessionDatRoot(accountDir: string, sessionId: string | undefined, datPath: string): void {
    if (!sessionId || !datPath) return
    const dirKey = `${accountDir}|${sessionId}`
    const datDir = dirname(datPath)
    if (existsSync(datDir)) {
      this.sessionDatDirCache.set(dirKey, datDir)
    }
    const root = this.extractSessionDatRoot(accountDir, datPath)
    if (!root || !existsSync(root)) return
    this.sessionDatRootCache.set(dirKey, root)
  }

  private getCachedSessionDatDir(accountDir: string, sessionId?: string): string | null {
    if (!sessionId) return null
    const key = `${accountDir}|${sessionId}`
    const cached = this.sessionDatDirCache.get(key)
    if (cached && existsSync(cached)) return cached
    if (cached) this.sessionDatDirCache.delete(key)
    return null
  }

  private getCachedSessionDatRoot(accountDir: string, sessionId?: string): string | null {
    if (!sessionId) return null
    const key = `${accountDir}|${sessionId}`
    const cached = this.sessionDatRootCache.get(key)
    if (cached && existsSync(cached)) return cached
    if (cached) this.sessionDatRootCache.delete(key)
    return null
  }

  private resolveSessionStorageDirs(sessionId?: string): string[] {
    const raw = String(sessionId || '').trim()
    if (!raw) return []

    const dirs: string[] = []
    const add = (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      const lower = trimmed.toLowerCase()
      if (this.looksLikeMd5(trimmed) && !dirs.includes(lower)) {
        dirs.push(lower)
      }
      const hashed = crypto.createHash('md5').update(trimmed).digest('hex').toLowerCase()
      if (!dirs.includes(hashed)) dirs.push(hashed)
      if (lower !== trimmed) {
        const lowerHashed = crypto.createHash('md5').update(lower).digest('hex').toLowerCase()
        if (!dirs.includes(lowerHashed)) dirs.push(lowerHashed)
      }
    }

    add(raw)
    const cleaned = this.cleanAccountDirName(raw)
    if (cleaned !== raw) add(cleaned)
    return dirs
  }

  private resolveSessionHashDatRoot(accountDir: string, sessionId?: string): string | null {
    for (const sessionDir of this.resolveSessionStorageDirs(sessionId)) {
      const root = join(accountDir, 'msg', 'attach', sessionDir)
      if (existsSync(root)) return root
    }
    return null
  }

  private getLikelyDatFileNames(datName: string, allowThumbnail = true): string[] {
    const lower = datName.toLowerCase()
    const normalized = this.normalizeDatBase(lower)
    const names = [
      lower.endsWith('.dat') ? lower : `${lower}.dat`,
      `${normalized}.dat`,
      `${normalized}_h.dat`,
      `${normalized}.h.dat`,
      `${normalized}_hd.dat`
    ]
    if (allowThumbnail) {
      names.push(`${normalized}_t.dat`, `${normalized}.t.dat`, `${normalized}_thumb.dat`)
    }
    return Array.from(new Set(names.filter(Boolean)))
  }

  private searchDatInKnownDir(dirPath: string, datName: string, allowThumbnail = true): string | null {
    if (!existsSync(dirPath)) return null
    const candidateNames = this.getLikelyDatFileNames(datName, allowThumbnail)
    for (const candidateName of candidateNames) {
      const candidatePath = join(dirPath, candidateName)
      if (!existsSync(candidatePath)) continue
      if (!allowThumbnail && this.isThumbnailPath(candidatePath)) continue
      return candidatePath
    }
    return null
  }

  private searchDatInSessionRoot(sessionRoot: string, datName: string, allowThumbnail = true): string | null {
    if (!existsSync(sessionRoot)) return null

    let monthDirs: string[]
    try {
      monthDirs = readdirSync(sessionRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
        .map(d => d.name)
        .sort()
        .reverse()
        .slice(0, 6)
    } catch {
      return null
    }

    const candidateNames = this.getLikelyDatFileNames(datName, allowThumbnail)
    const subDirs = ['Img', 'Image', 'mg']
    for (const monthDir of monthDirs) {
      for (const subDir of subDirs) {
        const imageDir = join(sessionRoot, monthDir, subDir)
        const matched = this.searchDatInKnownDir(imageDir, datName, allowThumbnail)
        if (matched) return matched
        for (const candidateName of candidateNames) {
          const candidatePath = join(imageDir, candidateName)
          if (!existsSync(candidatePath)) continue
          if (!allowThumbnail && this.isThumbnailPath(candidatePath)) continue
          return candidatePath
        }
      }
    }
    return null
  }

  private searchDatInSessionMonth(
    accountDir: string,
    sessionId: string | undefined,
    datName: string,
    createTime: number | undefined,
    allowThumbnail = true
  ): string | null {
    if (!sessionId || !datName || !createTime) return null
    const monthDir = this.resolveYearMonthFromCreateTime(createTime)
    if (!monthDir) return null

    const roots = this.resolveSessionStorageDirs(sessionId)
      .map(sessionDir => join(accountDir, 'msg', 'attach', sessionDir, monthDir))
    const subDirs = ['Img', 'Image', 'mg', 'MsgImg']
    for (const root of roots) {
      for (const subDir of subDirs) {
        const hit = this.searchDatInKnownDir(join(root, subDir), datName, allowThumbnail)
        if (hit) return hit
      }
      const directHit = this.searchDatInKnownDir(root, datName, allowThumbnail)
      if (directHit) return directHit
    }
    return null
  }

  private resolveYearMonthFromCreateTime(createTime?: number): string {
    const raw = Number(createTime)
    if (!Number.isFinite(raw) || raw <= 0) return ''
    const ts = raw > 1e12 ? raw : raw * 1000
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return ''
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  private extractSessionDatRoot(accountDir: string, datPath: string): string | null {
    const attachRoot = join(accountDir, 'msg', 'attach')
    const normalizedAttachRoot = attachRoot.toLowerCase()
    const normalizedDatPath = datPath.toLowerCase()
    if (!normalizedDatPath.startsWith(normalizedAttachRoot)) {
      return dirname(datPath)
    }

    const relative = datPath.slice(attachRoot.length).replace(/^[\\/]+/, '')
    if (!relative) return dirname(datPath)
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return dirname(datPath)
    return join(attachRoot, parts[0])
  }

  private clearUpdateFlags(cacheKey: string, imageMd5?: string, imageDatName?: string): void {
    this.updateFlags.delete(cacheKey)
    if (imageMd5) this.updateFlags.delete(imageMd5)
    if (imageDatName) this.updateFlags.delete(imageDatName)
  }

  private deleteThumbnailByKeys(keys: string[]): number {
    if (keys.length === 0) return 0

    const normalizedKeys = Array.from(new Set(
      keys
        .map(k => this.normalizeDatBase(k.toLowerCase()))
        .filter(Boolean)
    ))
    if (normalizedKeys.length === 0) return 0

    let deleted = 0
    const roots = this.getAllCacheRoots()

    const isMatchThumbFile = (filePath: string): boolean => {
      const lower = filePath.toLowerCase()
      if (!this.isThumbnailPath(lower)) return false
      const baseName = basename(lower)
      return normalizedKeys.some(key => baseName.startsWith(`${key}_thumb.`))
    }

    const walk = (dir: string) => {
      let entries: any[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (isMatchThumbFile(full)) {
          try {
            unlinkSync(full)
            deleted++
          } catch { }
        }
      }
    }

    for (const root of roots) {
      if (existsSync(root)) {
        walk(root)
      }
    }

    for (const [key, resolvedPath] of this.resolvedCache.entries()) {
      if (!isMatchThumbFile(resolvedPath)) continue
      const lowerKey = key.toLowerCase()
      const normalizedKey = this.normalizeDatBase(lowerKey)
      if (normalizedKeys.includes(normalizedKey) || normalizedKeys.includes(lowerKey)) {
        this.resolvedCache.delete(key)
      }
    }

    return deleted
  }

  private deleteThumbnailByKeysInDir(keys: string[], dirPath: string): number {
    if (keys.length === 0 || !dirPath || !existsSync(dirPath)) return 0
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    const normalizedKeys = Array.from(new Set(
      keys
        .map(k => this.normalizeDatBase(k.toLowerCase()))
        .filter(Boolean)
    ))
    if (normalizedKeys.length === 0) return 0

    let deleted = 0
    for (const key of normalizedKeys) {
      for (const ext of extensions) {
        const candidate = join(dirPath, `${key}_thumb${ext}`)
        if (!existsSync(candidate)) continue
        try {
          unlinkSync(candidate)
          deleted++
        } catch { }
      }
    }

    for (const [cacheKey, resolvedPath] of this.resolvedCache.entries()) {
      const lowerKey = this.normalizeDatBase(cacheKey.toLowerCase())
      if (!normalizedKeys.includes(lowerKey)) continue
      if (!this.isThumbnailPath(resolvedPath)) continue
      if (dirname(resolvedPath) !== dirPath) continue
      this.resolvedCache.delete(cacheKey)
    }

    return deleted
  }

  private getCachedDatDir(accountDir: string, imageDatName?: string, imageMd5?: string): string | null {
    const keys = [
      imageDatName ? `${accountDir}|${imageDatName}` : null,
      imageDatName ? `${accountDir}|${this.normalizeDatBase(imageDatName)}` : null,
      imageMd5 ? `${accountDir}|${imageMd5}` : null
    ].filter(Boolean) as string[]
    for (const key of keys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached)) return dirname(cached)
    }
    return null
  }

  private findNonThumbnailVariantInDir(dirPath: string, baseName: string): string | null {
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return null
    }
    const target = this.normalizeDatBase(baseName.toLowerCase())
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      if (!lower.endsWith('.dat')) continue
      if (this.isThumbnailDat(lower)) continue
      if (!this.hasXVariant(lower.slice(0, -4))) continue
      const baseLower = lower.slice(0, -4)
      if (this.normalizeDatBase(baseLower) !== target) continue
      return join(dirPath, entry)
    }
    return null
  }

  private isNonThumbnailVariantDat(datPath: string): boolean {
    const lower = basename(datPath).toLowerCase()
    if (!lower.endsWith('.dat')) return false
    if (this.isThumbnailDat(lower)) return false
    const baseLower = lower.slice(0, -4)
    return this.hasXVariant(baseLower)
  }

  private getBrowserWindowClass(): typeof BrowserWindowT | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('electron').BrowserWindow ?? null
    } catch {
      return null
    }
  }

  private emitImageUpdate(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string): void {
    const BrowserWindow = this.getBrowserWindowClass()
    if (!BrowserWindow) return
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:updateAvailable', message)
      }
    }
  }

  private emitCacheResolved(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string, localPath: string): void {
    const BrowserWindow = this.getBrowserWindowClass()
    if (!BrowserWindow) return
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName, localPath }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:cacheResolved', message)
      }
    }
  }

  private async ensureCacheIndexed(): Promise<void> {
    if (this.cacheIndexed) return
    if (this.cacheIndexing) return this.cacheIndexing
    this.cacheIndexing = new Promise((resolve) => {
      const allRoots = this.getAllCacheRoots()
      const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

      for (const root of allRoots) {
        let entries: string[]
        try {
          entries = readdirSync(root)
        } catch {
          continue
        }
        for (const entry of entries) {
          const lower = entry.toLowerCase()
          const ext = extensions.find((item) => lower.endsWith(item))
          if (!ext) continue
          const fullPath = join(root, entry)
          try {
            if (!statSync(fullPath).isFile()) continue
          } catch {
            continue
          }
          const base = entry.slice(0, -ext.length)
          this.addCacheIndex(base, fullPath)
          const normalized = this.normalizeDatBase(base)
          if (normalized && normalized !== base.toLowerCase()) {
            this.addCacheIndex(normalized, fullPath)
          }
        }
      }
      this.cacheIndexed = true
      this.cacheIndexing = null
      resolve()
    })
    return this.cacheIndexing
  }

  private addCacheIndex(key: string, path: string): void {
    const normalizedKey = key.toLowerCase()
    const existing = this.resolvedCache.get(normalizedKey)
    if (existing) {
      const existingIsThumb = this.isThumbnailPath(existing)
      const candidateIsThumb = this.isThumbnailPath(path)
      if (!existingIsThumb && candidateIsThumb) return
    }
    this.resolvedCache.set(normalizedKey, path)
  }

  /**
   * 获取默认缓存路径（与 dataManagementService 保持一致）
   */
  private getDefaultCachePath(): string {
    return getPlatformDefaultCachePath()
  }

  private getCacheRoot(): string {
    const configured = this.configService.get('cachePath')
    const root = configured
      ? join(configured, 'Images')
      : join(this.getDefaultCachePath(), 'Images')
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }
    return root
  }

  /**
   * 获取所有可能的缓存根路径（用于查找已缓存的图片）
   * 包含新路径和旧的 CipherTalk/Images 路径
   */
  private getAllCacheRoots(): string[] {
    const roots: string[] = []
    const configured = this.configService.get('cachePath')
    const documentsPath = getDocumentsPath()

    // 主要路径（当前使用的）
    const mainRoot = this.getCacheRoot()
    roots.push(mainRoot)

    // 如果配置了自定义路径，也检查其下的 Images
    if (configured) {
      roots.push(join(configured, 'Images'))
      roots.push(join(configured, 'images'))
    }

    // 默认路径
    const defaultPath = this.getDefaultCachePath()
    roots.push(join(defaultPath, 'Images'))
    roots.push(join(defaultPath, 'images'))

    // 兼容旧的 CipherTalk/Images 路径
    const oldPath = join(documentsPath, 'CipherTalk', 'Images')
    roots.push(oldPath)

    // 去重
    const uniqueRoots = Array.from(new Set(roots))
    // 过滤存在的路径
    const existingRoots = uniqueRoots.filter(r => existsSync(r))

    return existingRoots
  }

  private resolveAesKey(aesKeyRaw: string): Buffer | null {
    const trimmed = aesKeyRaw?.trim() ?? ''
    if (!trimmed) return null
    return this.asciiKey16(trimmed)
  }

  private async decryptDatAuto(
    datPath: string,
    xorKey: number,
    aesKey: Buffer | null,
    aesKeyText?: string
  ): Promise<DatDecryptOutcome> {
    // 优先走 worker 线程池：读盘 + AES + XOR 离开当前线程，多核真并行
    const pooled = imageDecryptWorkerPool.decrypt(datPath, xorKey, aesKeyText || '', aesKey)
    if (pooled) {
      try {
        return await pooled
      } catch (e: any) {
        // worker 侧失败（解密异常或线程崩溃）：回退当前线程原地解密，保持原行为
        console.warn(`[ImageDecryptPool] worker 解密失败，回退主线程: ${datPath} - ${e?.message || String(e)}`)
      }
    }

    const nativeResult = this.tryDecryptDatWithNative(datPath, xorKey, aesKeyText)
    if (nativeResult && this.looksLikeNativeImagePayload(nativeResult.data)) {
      return { data: nativeResult.data, source: 'native' }
    }
    const fallbackReason = nativeResult ? 'invalid_native_payload' : 'native_unavailable'
    if (nativeResult || nativeDecryptEnabled()) {
      console.warn(`[ImageDecrypt] Native DAT 解密不可用，回退 TS: ${datPath} reason=${fallbackReason}`)
    }
    return this.decryptDatLegacy(datPath, xorKey, aesKey, fallbackReason)
  }

  public decryptDatFile(inputPath: string, xorKey: number, aesKey?: Buffer | string): Buffer {
    const { buffer, text } = this.normalizeAesKeyInput(aesKey)
    return this.decryptDatFileInternal(inputPath, xorKey, buffer, text)
  }

  public getDatVersion(inputPath: string): number {
    return getDatVersionCore(inputPath)
  }

  private decryptDatFileInternal(inputPath: string, xorKey: number, aesKey: Buffer | null, aesKeyText?: string): Buffer {
    const outcome = this.tryDecryptDatWithNative(inputPath, xorKey, aesKeyText)
    if (outcome && this.looksLikeNativeImagePayload(outcome.data)) {
      return outcome.data
    }
    if (outcome || nativeDecryptEnabled()) {
      const reason = outcome ? 'invalid_native_payload' : 'native_unavailable'
      console.warn(`[ImageDecrypt] Native 文件解密不可用，回退 TS: ${inputPath} reason=${reason}`)
    }
    return this.decryptDatLegacy(inputPath, xorKey, aesKey).data
  }

  private decryptDatLegacy(
    inputPath: string,
    xorKey: number,
    aesKey: Buffer | null,
    fallbackReason?: string
  ): DatDecryptOutcome {
    return decryptDatLegacyCore(inputPath, xorKey, aesKey, fallbackReason)
  }

  private normalizeAesKeyInput(aesKey?: Buffer | string): { buffer: Buffer | null; text: string } {
    if (typeof aesKey === 'string') {
      const text = aesKey.trim()
      return {
        buffer: text ? this.asciiKey16(text) : null,
        text
      }
    }
    return {
      buffer: aesKey ?? null,
      text: ''
    }
  }

  private tryDecryptDatWithNative(
    inputPath: string,
    xorKey: number,
    aesKeyText?: string
  ): { data: Buffer; ext: string; isWxgf: boolean } | null {
    const result = decryptDatViaNative(inputPath, xorKey, aesKeyText || undefined)
    if (!this.nativeLogged) {
      this.nativeLogged = true
      if (process.env.CIPHERTALK_IMAGE_DECRYPT_DEBUG === '1') {
        if (result) {
          const metadata = nativeAddonMetadata()
          console.info('[ImageDecrypt] Native DAT 解密已启用', {
            addonPath: nativeAddonLocation(),
            source: 'native',
            platform: process.platform,
            arch: process.arch,
            moduleName: metadata?.name || 'unknown',
            moduleVersion: metadata?.version || 'unknown',
            moduleVendor: metadata?.vendor || 'unknown'
          })
        } else {
          const metadata = nativeAddonMetadata()
          console.info('[ImageDecrypt] Native DAT 解密不可用', {
            addonPath: nativeAddonLocation(),
            source: 'native_unavailable',
            platform: process.platform,
            arch: process.arch,
            moduleName: metadata?.name || 'unknown',
            moduleVersion: metadata?.version || 'unknown',
            moduleVendor: metadata?.vendor || 'unknown'
          })
        }
      }
    }
    return result
  }

  private looksLikeNativeImagePayload(data: Buffer): boolean {
    return looksLikeNativeImagePayloadCore(data)
  }

  asciiKey16(keyString: string): Buffer {
    return asciiKey16Core(keyString)
  }

  /**
   * 解包 wxgf 格式
   * wxgf 是微信的图片格式，内部使用 HEVC 编码
   * 参考：https://sarv.blog/posts/wxam/
   * 
   * wxgf 文件结构:
   * - 4 bytes: magic "wxgf" (77 78 67 66)
   * - 后续是分片数据，每个分片包含 HEVC NALU
   */
  private async unwrapWxgf(buffer: Buffer): Promise<{ data: Buffer; isWxgf: boolean }> {
    // 检查是否是 wxgf 格式 (77 78 67 66 = "wxgf")
    if (buffer.length < 20 ||
      buffer[0] !== 0x77 || buffer[1] !== 0x78 ||
      buffer[2] !== 0x67 || buffer[3] !== 0x66) {
      return { data: buffer, isWxgf: false }
    }

    // 先尝试搜索内嵌的传统图片签名（有些 wxgf 可能直接包含 JPG/PNG）
    for (let i = 4; i < Math.min(buffer.length - 12, 4096); i++) {
      // JPG
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
      // PNG
      if (buffer[i] === 0x89 && buffer[i + 1] === 0x50 &&
        buffer[i + 2] === 0x4e && buffer[i + 3] === 0x47) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
    }

    // 提取 HEVC NALU 裸流。部分 wxgf 内会有多段 still-image HEVC，首段可能是白色占位帧。
    const hevcStreams = this.extractHevcNaluStreams(buffer)
    if (hevcStreams.length === 0) {
      console.warn(`[ImageDecrypt] HEVC NALU 提取失败或数据过短: buffer=${buffer.length}`)
      return { data: buffer, isWxgf: true }
    }

    let fallbackJpg: Buffer | null = null
    for (const hevcData of hevcStreams) {
      const jpgData = await this.convertHevcToJpg(hevcData)
      if (jpgData && jpgData.length > 0) {
        if (!this.isProbablyBlankConvertedJpeg(jpgData)) {
          return { data: jpgData, isWxgf: false }
        }
        fallbackJpg ||= jpgData
      }
    }

    if (fallbackJpg) {
      return { data: fallbackJpg, isWxgf: false }
    }

    // ffmpeg 失败，返回原始 HEVC 数据
    return { data: hevcStreams[0], isWxgf: true }
  }

  /**
   * 从 wxgf 数据中提取 HEVC NALU 裸流
   * 
   * wxgf 格式分析（基于 https://sarv.blog/posts/wxam/）:
   * - 文件头: "wxgf" + 元数据
   * - 数据区: 包含 HEVC NALU 单元
   * - HEVC NALU 起始码: 0x00000001 或 0x000001
   * 
   * HEVC NAL Unit Type (在起始码后的第一个字节的高6位):
   * - VPS (32): 视频参数集
   * - SPS (33): 序列参数集  
   * - PPS (34): 图像参数集
   * - IDR (19/20): 关键帧
   */
  private extractHevcNaluStreams(buffer: Buffer): Buffer[] {
    const nalUnits = this.extractHevcNaluUnits(buffer)
    if (nalUnits.length === 0) return []

    const groups: Buffer[][] = []
    let current: Buffer[] = []
    for (const unit of nalUnits) {
      const unitType = this.getHevcNalType(unit)
      if (unitType === 32 && current.length > 0) {
        groups.push(current)
        current = []
      }
      current.push(unit)
    }
    if (current.length > 0) groups.push(current)

    return groups
      .map(group => this.mergeHevcNaluUnits(group))
      .filter(stream => stream.length >= 100)
  }

  private extractHevcNaluUnits(buffer: Buffer): Buffer[] {
    const nalUnits: Buffer[] = []
    let i = 4 // 跳过 "wxgf" 头

    // 解析 wxgf 头部获取数据偏移
    // wxgf 头部结构不固定，我们直接搜索 HEVC NALU 起始码

    while (i < buffer.length - 4) {
      // 查找 4 字节起始码 0x00000001
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
        buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {

        // 找到起始码，确定 NAL 单元的结束位置
        let nalStart = i
        let nalEnd = buffer.length

        // 搜索下一个起始码
        for (let j = i + 4; j < buffer.length - 3; j++) {
          if (buffer[j] === 0x00 && buffer[j + 1] === 0x00) {
            if (buffer[j + 2] === 0x01 ||
              (buffer[j + 2] === 0x00 && j + 3 < buffer.length && buffer[j + 3] === 0x01)) {
              nalEnd = j
              break
            }
          }
        }

        // 提取 NAL 单元
        const nalUnit = buffer.subarray(nalStart, nalEnd)
        if (nalUnit.length > 4) {
          nalUnits.push(nalUnit)
        }

        i = nalEnd
      } else if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x01) {
        // 3 字节起始码
        let nalStart = i
        let nalEnd = buffer.length

        for (let j = i + 3; j < buffer.length - 2; j++) {
          if (buffer[j] === 0x00 && buffer[j + 1] === 0x00) {
            if (buffer[j + 2] === 0x01 ||
              (buffer[j + 2] === 0x00 && j + 3 < buffer.length && buffer[j + 3] === 0x01)) {
              nalEnd = j
              break
            }
          }
        }

        const nalUnit = buffer.subarray(nalStart, nalEnd)
        if (nalUnit.length > 3) {
          nalUnits.push(nalUnit)
        }

        i = nalEnd
      } else {
        i++
      }
    }

    if (nalUnits.length === 0) {
      // 备用方案：直接从第一个起始码开始截取到文件末尾
      for (let j = 4; j < buffer.length - 4; j++) {
        if (buffer[j] === 0x00 && buffer[j + 1] === 0x00 &&
          buffer[j + 2] === 0x00 && buffer[j + 3] === 0x01) {
          return [buffer.subarray(j + 4)]
        }
      }
      return []
    }

    return nalUnits
  }

  private mergeHevcNaluUnits(nalUnits: Buffer[]): Buffer {
    const chunks: Buffer[] = []
    for (const unit of nalUnits) {
      chunks.push(Buffer.from([0x00, 0x00, 0x00, 0x01]), unit)
    }
    return Buffer.concat(chunks)
  }

  private getHevcNalType(unit: Buffer): number | null {
    if (!unit.length) return null
    return (unit[0] >> 1) & 0x3f
  }

  private isProbablyBlankConvertedJpeg(data: Buffer): boolean {
    const dimensions = this.getJpegDimensions(data)
    if (!dimensions) return false
    const pixels = dimensions.width * dimensions.height
    if (pixels < 50_000) return false
    return data.length * 100 < pixels * 4
  }

  private getJpegDimensions(data: Buffer): { width: number; height: number } | null {
    if (data.length < 12 || data[0] !== 0xff || data[1] !== 0xd8) return null

    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      while (offset < data.length && data[offset] === 0xff) offset += 1
      if (offset >= data.length) return null

      const marker = data[offset]
      offset += 1
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue
      }
      if (offset + 2 > data.length) return null

      const segmentLength = data.readUInt16BE(offset)
      if (segmentLength < 2 || offset + segmentLength > data.length) return null

      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof && segmentLength >= 7) {
        const height = data.readUInt16BE(offset + 3)
        const width = data.readUInt16BE(offset + 5)
        return width > 0 && height > 0 ? { width, height } : null
      }

      offset += segmentLength
    }

    return null
  }

  /**
   * 获取 ffmpeg 可执行文件路径
   * 优先使用 ffmpeg-static 提供的路径，如果不可用则尝试系统 PATH
   */
  private getFfmpegPath(): string {
    // 尝试获取 ffmpeg-static 的路径
    const staticPath = getStaticFfmpegPath()
    if (staticPath) {
      // 处理 asar 打包的情况
      const unpackedPath = staticPath.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(unpackedPath)) {
        return unpackedPath
      }
      if (existsSync(staticPath)) {
        return staticPath
      }
    }
    // 回退到系统 PATH
    console.warn(`[ImageDecrypt] ffmpeg-static 未找到解压路径，尝试使用系统 ffmpeg: ${staticPath}`)
    return 'ffmpeg'
  }

  /**
   * 使用 ffmpeg 将 HEVC 裸流转换为 JPG
   * 使用 spawn + 管道，最小化开销
   */
  private convertHevcToJpg(hevcData: Buffer): Promise<Buffer | null> {
    const ffmpeg = this.getFfmpegPath()
    // console.log(`[ImageDecrypt] 使用 ffmpeg: ${ffmpeg}`)

    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('child_process')
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'hevc',
        '-i', 'pipe:0',
        '-vframes', '1',
        '-q:v', '3',           // 稍微降低质量，加快编码
        '-f', 'mjpeg',
        'pipe:1'
      ]

      const proc = spawn(ffmpeg, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true      // Windows 下隐藏窗口
      })

      // wxgf 内嵌的 still-image HEVC 裸流缺帧边界分隔符时，ffmpeg 会等下一个 access unit
      // 才输出当前帧，导致进程永久阻塞、不退出 → 聊天里划过大量 wxgf 图会攒成成千上万个
      // 卡死的 ffmpeg.exe（各带一个 conhost 窗口）。补超时 kill，与语音转换路径保持一致。
      const killTimer = setTimeout(() => {
        console.error('[ImageDecrypt] ffmpeg 转换超时，强制结束进程')
        try { proc.kill() } catch { /* 已退出 */ }
        resolve(null)
      }, 15000)

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

      proc.on('close', (code: number) => {
        clearTimeout(killTimer)
        if (code === 0 && chunks.length > 0) {
          const result = Buffer.concat(chunks)
          resolve(result)
        } else {
          const errMsg = Buffer.concat(errChunks).toString()
          console.error(`[ImageDecrypt] ffmpeg 转换失败 code=${code} err=${errMsg}`)
          resolve(null)
        }
      })

      proc.on('error', (err: any) => {
        clearTimeout(killTimer)
        console.error(`[ImageDecrypt] ffmpeg 启动失败: ${ffmpeg}`, err)
        resolve(null)
      })

      // 写入数据并关闭
      try {
        proc.stdin.write(hevcData)
        proc.stdin.end()
      } catch (e) {
        console.error('[ImageDecrypt] 写入 ffmpeg stdin 失败', e)
        resolve(null)
      }
    })
  }

  private detectImageExtension(buffer: Buffer): string | null {
    return detectImageExtensionCore(buffer)
  }

  /**
   * 验证解密后的图片数据是否完整
   * JPEG: 末尾应有 EOI marker (0xFF 0xD9)
   * PNG: 末尾应有 IEND chunk
   * GIF: 末尾应有 trailer (0x3B)
   * 不完整的图片不应该被缓存，下次重新解密可能拿到完整数据
   */
  private verifyImageComplete(data: Buffer, ext: string): boolean {
    if (!data || data.length < 100) return false

    const lowerExt = ext.toLowerCase()

    if (lowerExt === '.jpg' || lowerExt === '.jpeg') {
      // JPEG: 检查是否存在 EOI marker (0xFF 0xD9)
      // 从末尾往前搜索（有些 JPEG 在 EOI 后有少量附加数据）
      const searchLen = Math.min(data.length, 64)
      for (let i = data.length - 2; i >= data.length - searchLen; i--) {
        if (data[i] === 0xFF && data[i + 1] === 0xD9) {
          return true
        }
      }
      // Motion Photo 情况：JPEG 后面紧跟 MP4，EOI 在中间位置
      const quarterStart = Math.floor(data.length * 3 / 4)
      for (let i = quarterStart; i < data.length - 1; i++) {
        if (data[i] === 0xFF && data[i + 1] === 0xD9) {
          return true
        }
      }
      return false
    }

    if (lowerExt === '.png') {
      // PNG: 末尾应有 IEND chunk (... 49 45 4E 44 AE 42 60 82)
      if (data.length < 12) return false
      const tail = data.subarray(data.length - 12)
      if (tail[4] === 0x49 && tail[5] === 0x45 && tail[6] === 0x4E && tail[7] === 0x44) {
        return true
      }
      return false
    }

    if (lowerExt === '.gif') {
      // GIF: 末尾应有 trailer byte (0x3B)
      return data[data.length - 1] === 0x3B
    }

    // WebP 和其他格式暂不做细粒度校验，仅检查最低大小
    return data.length > 100
  }

  private bufferToDataUrl(buffer: Buffer, ext: string): string | null {
    const mimeType = this.mimeFromExtension(ext)
    if (!mimeType) return null
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  }

  private fileToDataUrl(filePath: string): string | null {
    try {
      const ext = extname(filePath).toLowerCase()
      const mimeType = this.mimeFromExtension(ext)
      if (!mimeType) return null
      const data = readFileSync(filePath)
      return `data:${mimeType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  private mimeFromExtension(ext: string): string | null {
    switch (ext.toLowerCase()) {
      case '.gif':
        return 'image/gif'
      case '.png':
        return 'image/png'
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg'
      case '.webp':
        return 'image/webp'
      case '.heic':
      case '.heif':
        return 'image/heic'
      default:
        return null
    }
  }

  private checkLiveVideoCache(imagePath: string): string | undefined {
    if (this.noLiveSet.has(imagePath)) return undefined
    const livePath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '_live.mp4')
    if (existsSync(livePath)) return this.filePathToUrl(livePath)
    // Try extracting from cached JPEG
    try {
      if (!existsSync(imagePath)) { this.noLiveSet.add(imagePath); return undefined }
      const buf = readFileSync(imagePath)
      const offset = this.findMotionPhotoOffset(buf)
      if (offset === null) { this.noLiveSet.add(imagePath); return undefined }
      writeFileSync(livePath, buf.subarray(offset))
      return this.filePathToUrl(livePath)
    } catch {
      this.noLiveSet.add(imagePath)
      return undefined
    }
  }

  private findMotionPhotoOffset(buf: Buffer): number | null {
    if (buf.length < 8 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
    let videoOffset: number | null = null
    for (let i = Math.max(0, buf.length - 8); i > 0; i--) {
      if (buf[i] === 0x66 && buf[i + 1] === 0x74 && buf[i + 2] === 0x79 && buf[i + 3] === 0x70) {
        videoOffset = i - 4; break
      }
    }
    if (videoOffset === null || videoOffset <= 0) {
      try {
        const text = buf.toString('latin1')
        const match = text.match(/MediaDataOffset="(\d+)"/i) || text.match(/MicroVideoOffset="(\d+)"/i)
        if (match) {
          const offset = parseInt(match[1], 10)
          if (offset > 0 && offset < buf.length) videoOffset = buf.length - offset
        }
      } catch { }
    }
    if (videoOffset === null || videoOffset <= 100) return null
    if (buf[videoOffset + 4] !== 0x66 || buf[videoOffset + 5] !== 0x74 ||
      buf[videoOffset + 6] !== 0x79 || buf[videoOffset + 7] !== 0x70) return null
    return videoOffset
  }

  private async extractMotionPhotoVideo(imagePath: string, buf: Buffer): Promise<string | null> {
    const videoOffset = this.findMotionPhotoOffset(buf)
    if (videoOffset === null) return null
    const videoPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '_live.mp4')
    await writeFile(videoPath, buf.subarray(videoOffset))
    return videoPath
  }

  private filePathToUrl(filePath: string): string {
    const url = pathToFileURL(filePath).toString()
    try {
      const mtime = statSync(filePath).mtimeMs
      return `${url}?v=${Math.floor(mtime)}`
    } catch {
      return url
    }
  }

  private isImageFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return ext === '.gif' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp'
  }

  private compareBytes(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  // 保留原有的批量检测 XOR 密钥方法（用于兼容）
  async batchDetectXorKey(dirPath: string, maxFiles: number = 100): Promise<number | null> {
    const keyCount: Map<number, number> = new Map()
    let filesChecked = 0

    const V1_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
    const V2_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const IMAGE_SIGNATURES: { [key: string]: Buffer } = {
      jpg: Buffer.from([0xFF, 0xD8, 0xFF]),
      png: Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      gif: Buffer.from([0x47, 0x49, 0x46, 0x38]),
      bmp: Buffer.from([0x42, 0x4D]),
      webp: Buffer.from([0x52, 0x49, 0x46, 0x46])
    }

    const detectXorKeyFromV3 = (header: Buffer): number | null => {
      for (const [, signature] of Object.entries(IMAGE_SIGNATURES)) {
        const xorKey = header[0] ^ signature[0]
        let valid = true
        for (let i = 0; i < signature.length && i < header.length; i++) {
          if ((header[i] ^ xorKey) !== signature[i]) {
            valid = false
            break
          }
        }
        if (valid) return xorKey
      }
      return null
    }

    const scanDir = (dir: string) => {
      if (filesChecked >= maxFiles) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (filesChecked >= maxFiles) return
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            scanDir(fullPath)
          } else if (entry.name.endsWith('.dat')) {
            try {
              const header = Buffer.alloc(16)
              const fd = require('fs').openSync(fullPath, 'r')
              require('fs').readSync(fd, header, 0, 16, 0)
              require('fs').closeSync(fd)

              if (header.subarray(0, 6).equals(V1_SIGNATURE) || header.subarray(0, 6).equals(V2_SIGNATURE)) {
                continue
              }

              const key = detectXorKeyFromV3(header)
              if (key !== null) {
                keyCount.set(key, (keyCount.get(key) || 0) + 1)
                filesChecked++
              }
            } catch { }
          }
        }
      } catch { }
    }

    scanDir(dirPath)

    if (keyCount.size === 0) return null

    let maxCount = 0
    let mostCommonKey: number | null = null
    keyCount.forEach((count, key) => {
      if (count > maxCount) {
        maxCount = count
        mostCommonKey = key
      }
    })

    return mostCommonKey
  }

  // 保留原有的解密到文件方法（用于兼容）
  async decryptToFile(inputPath: string, outputPath: string, xorKey: number, aesKey?: Buffer | string): Promise<void> {
    const { buffer, text } = this.normalizeAesKeyInput(aesKey)
    const decrypted = this.decryptDatFileInternal(inputPath, xorKey, buffer, text)

    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    await writeFile(outputPath, decrypted)
  }

  /**
   * 清理 hardlink 数据库缓存（用于增量更新时释放文件）
   */
  clearHardlinkCache(): void {
    this.hardlinkCache.clear()
  }

  /**
   * 统计缩略图缓存数量
   */
  countThumbnails(): { success: boolean; count: number; error?: string } {
    try {
      const root = this.getCacheRoot()
      let count = 0
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (this.isThumbnailPath(full)) count++
        }
      }
      walk(root)
      return { success: true, count }
    } catch (e) {
      return { success: false, count: 0, error: String(e) }
    }
  }

  /**
   * 批量删除缩略图缓存
   */
  async deleteThumbnails(): Promise<{ success: boolean; deleted: number; error?: string }> {
    try {
      const root = this.getCacheRoot()
      let deleted = 0
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
          } else if (this.isThumbnailPath(full)) {
            try { unlinkSync(full); deleted++ } catch { }
          }
        }
      }
      walk(root)
      // 清理内存缓存中的缩略图引用
      for (const [key, path] of this.resolvedCache.entries()) {
        if (this.isThumbnailPath(path)) this.resolvedCache.delete(key)
      }
      return { success: true, deleted }
    } catch (e) {
      return { success: false, deleted: 0, error: String(e) }
    }
  }
}

export const imageDecryptService = new ImageDecryptService()
