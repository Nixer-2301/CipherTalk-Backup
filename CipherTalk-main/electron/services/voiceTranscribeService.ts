/**
 * 语音转写服务
 * 负责模型管理（下载、校验）和转写任务调度
 * 支持转写结果缓存
 */
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, createWriteStream, renameSync, type WriteStream } from 'fs'
import { dirname, join } from 'path'
import * as https from 'https'
import * as http from 'http'
import Database from 'better-sqlite3'
import { ConfigService } from './config'
import { getAppDataPath, getUserDataPath } from './runtimePaths'

// 模型信息
interface ModelInfo {
    name: string
    files: {
        model: string
        tokens: string
    }
    sizeBytes: number
    sizeLabel: string
}

// 下载进度
interface DownloadProgress {
    modelName: string
    downloadedBytes: number
    totalBytes?: number
    percent?: number
}

// 模型类型
type ModelType = 'int8' | 'float32'

type DownloadCancelState = {
    cancelled: boolean
    request?: http.ClientRequest
    writer?: WriteStream
}

const DOWNLOAD_CANCELLED_MESSAGE = '下载已暂停'

// SenseVoice 模型配置（按类型）
const SENSEVOICE_MODELS: Record<ModelType, ModelInfo> = {
    int8: {
        name: 'SenseVoice (int8 量化版)',
        files: {
            model: 'model.int8.onnx',
            tokens: 'tokens.txt'
        },
        sizeBytes: 235_000_000,
        sizeLabel: '235 MB'
    },
    float32: {
        name: 'SenseVoice (float32 完整版)',
        files: {
            model: 'model.onnx',
            tokens: 'tokens.txt'
        },
        sizeBytes: 920_000_000,
        sizeLabel: '920 MB'
    }
}

// 模型下载地址 (ModelScope)
const MODEL_DOWNLOAD_URLS: Record<ModelType, { model: string; tokens: string }> = {
    int8: {
        model: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.int8.onnx',
        tokens: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt'
    },
    float32: {
        model: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.onnx',
        tokens: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt'
    }
}

export class VoiceTranscribeService {
    private configService = new ConfigService()
    private downloadTasks = new Map<string, Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }>>()
    private downloadCancels = new Map<string, DownloadCancelState>()
    private cacheDb: Database.Database | null = null
    /** 稳定主缓存路径（不跟账号 cachePath 走，避免换目录后整批重转写） */
    private cacheDbPath: string | null = null
    private primaryLegacyMigratedFor = new Set<string>()
    private mergedLegacyCachePaths = new Set<string>()

    constructor() {
        this.initCacheDb()
    }

    /**
     * 获取当前配置的模型类型
     */
    private getCurrentModelType(): ModelType {
        return this.configService.get('sttModelType') || 'int8'
    }

    /**
     * 获取当前模型配置
     */
    private getCurrentModel(): ModelInfo {
        return SENSEVOICE_MODELS[this.getCurrentModelType()]
    }

    /**
     * 获取当前模型的下载 URL
     */
    private getCurrentModelUrls() {
        return MODEL_DOWNLOAD_URLS[this.getCurrentModelType()]
    }

    /**
     * 转写缓存固定落在 app userData，不跟微信账号的 cachePath。
     * 旧版本曾把 stt-cache.db 写到 cachePath 或 appData/ciphertalk，启动时会合并进来。
     */
    private resolvePrimaryCacheDbPath(): string {
        return join(getUserDataPath(), 'stt-cache.db')
    }

    private resolveLegacyCacheDbPaths(primaryPath: string): string[] {
        const candidates: string[] = [
            join(getAppDataPath(), 'ciphertalk', 'stt-cache.db'),
            join(getUserDataPath(), 'stt-cache.db'),
        ]
        const accountCachePath = String(this.configService.get('cachePath') || '').trim()
        if (accountCachePath) {
            candidates.push(join(accountCachePath, 'stt-cache.db'))
        }

        const primaryReal = this.safeRealpath(primaryPath)
        const seen = new Set<string>()
        const result: string[] = []
        for (const p of candidates) {
            if (!p || !existsSync(p)) continue
            const real = this.safeRealpath(p) || p
            if (primaryReal && real === primaryReal) continue
            if (seen.has(real)) continue
            seen.add(real)
            result.push(p)
        }
        return result
    }

    private safeRealpath(filePath: string): string | null {
        try {
            return realpathSync(filePath)
        } catch {
            return null
        }
    }

    /**
     * 把旧路径里的转写结果合并进主库（INSERT OR IGNORE，不覆盖已有）。
     */
    private mergeLegacyCacheDb(legacyPath: string): number | null {
        if (!this.cacheDb || !existsSync(legacyPath)) return 0
        let legacy: Database.Database | null = null
        try {
            legacy = new Database(legacyPath, { readonly: true, fileMustExist: true })
            const hasTable = legacy.prepare(
                "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='transcript_cache' LIMIT 1"
            ).get() as { ok?: number } | undefined
            if (!hasTable) return 0

            const rows = legacy.prepare(
                'SELECT cache_key, session_id, create_time, transcript, created_at FROM transcript_cache'
            ).all() as Array<{
                cache_key: string
                session_id: string
                create_time: number
                transcript: string
                created_at: number
            }>
            if (rows.length === 0) return 0

            const insert = this.cacheDb.prepare(`
                INSERT OR IGNORE INTO transcript_cache
                (cache_key, session_id, create_time, transcript, created_at)
                VALUES (?, ?, ?, ?, ?)
            `)
            const merge = this.cacheDb.transaction((items: typeof rows) => {
                let added = 0
                for (const row of items) {
                    const sessionId = this.normalizeSessionId(row.session_id)
                    const createTime = this.normalizeCreateTime(row.create_time)
                    const cacheKey = row.cache_key?.startsWith('v2:')
                        ? row.cache_key
                        : this.getCacheKey(sessionId, createTime)
                    const transcript = String(row.transcript || '')
                    const info = insert.run(
                        cacheKey,
                        sessionId,
                        createTime,
                        transcript,
                        Number(row.created_at) || Date.now(),
                    )
                    added += info.changes
                }
                return added
            })
            const added = merge(rows)
            if (added > 0) {
                console.log(`[VoiceTranscribe] 已从旧缓存合并 ${added} 条转写: ${legacyPath}`)
            }
            return added
        } catch (e) {
            console.error('[VoiceTranscribe] 合并旧转写缓存失败:', legacyPath, e)
            return null
        } finally {
            try { legacy?.close() } catch { /* ignore */ }
        }
    }

    private mergeLegacyCacheDbOnce(legacyPath: string): void {
        const identity = this.safeRealpath(legacyPath) || legacyPath
        if (this.mergedLegacyCachePaths.has(identity)) return
        const merged = this.mergeLegacyCacheDb(legacyPath)
        // 临时锁库等失败场景保留重试机会；无表或空库则视为已处理。
        if (merged !== null) this.mergedLegacyCachePaths.add(identity)
    }

    /** 账号切换后按需合并该账号旧 cachePath；同一个真实文件整个进程只处理一次。 */
    private ensureActiveAccountLegacyMerged(): void {
        if (!this.cacheDbPath) return
        for (const legacyPath of this.resolveLegacyCacheDbPaths(this.cacheDbPath)) {
            this.mergeLegacyCacheDbOnce(legacyPath)
        }
    }

    /**
     * 初始化缓存数据库
     */
    private initCacheDb(): void {
        try {
            const dbPath = this.resolvePrimaryCacheDbPath()
            const cacheDir = dirname(dbPath)
            if (!existsSync(cacheDir)) {
                mkdirSync(cacheDir, { recursive: true })
            }

            this.cacheDbPath = dbPath
            this.cacheDb = new Database(dbPath)

            // 创建缓存表
            this.cacheDb.exec(`
                CREATE TABLE IF NOT EXISTS transcript_cache (
                    cache_key TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    create_time INTEGER NOT NULL,
                    transcript TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
            `)

            // 创建索引
            this.cacheDb.exec(`
                CREATE INDEX IF NOT EXISTS idx_session_time 
                ON transcript_cache(session_id, create_time)
            `)

            // 合并历史碎片缓存，避免「以前转过、换目录后又全量重转」
            for (const legacyPath of this.resolveLegacyCacheDbPaths(dbPath)) {
                this.mergeLegacyCacheDbOnce(legacyPath)
            }
        } catch (e) {
            console.error('[VoiceTranscribe] 缓存数据库初始化失败:', e)
            this.cacheDb = null
            this.cacheDbPath = null
        }
    }

    private normalizeSessionId(sessionId: string): string {
        return String(sessionId || '').trim()
    }

    private normalizeCreateTime(createTime: number): number {
        const n = Number(createTime)
        return Number.isFinite(n) ? Math.trunc(n) : 0
    }

    private normalizeLocalId(localId?: number): number {
        const n = Number(localId)
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
    }

    private getAccountScopeId(): string {
        return String(
            this.configService.get('myWxid')
            || this.configService.get('activeAccountId')
            || 'default'
        ).trim() || 'default'
    }

    /**
     * 生成缓存 key
     */
    private getCacheKey(sessionId: string, createTime: number, localId?: number): string {
        return [
            'v2',
            encodeURIComponent(this.getAccountScopeId()),
            encodeURIComponent(this.normalizeSessionId(sessionId)),
            this.normalizeCreateTime(createTime),
            this.normalizeLocalId(localId),
        ].join(':')
    }

    private getLegacyCacheKey(sessionId: string, createTime: number): string {
        return `${this.normalizeSessionId(sessionId)}:${this.normalizeCreateTime(createTime)}`
    }

    /** 把主库中的 v1 键归到当前账号，避免升级为全局库后跨账号命中。 */
    private ensurePrimaryLegacyMigrated(): void {
        if (!this.cacheDb) return
        const accountId = this.getAccountScopeId()
        if (accountId === 'default' || this.primaryLegacyMigratedFor.has(accountId)) return
        try {
            const rows = this.cacheDb.prepare(`
                SELECT cache_key, session_id, create_time, transcript, created_at
                FROM transcript_cache
                WHERE cache_key NOT LIKE 'v2:%'
            `).all() as Array<{
                cache_key: string
                session_id: string
                create_time: number
                transcript: string
                created_at: number
            }>
            if (rows.length > 0) {
                const insert = this.cacheDb.prepare(`
                    INSERT OR IGNORE INTO transcript_cache
                    (cache_key, session_id, create_time, transcript, created_at)
                    VALUES (?, ?, ?, ?, ?)
                `)
                const remove = this.cacheDb.prepare('DELETE FROM transcript_cache WHERE cache_key = ?')
                this.cacheDb.transaction(() => {
                    for (const row of rows) {
                        insert.run(
                            this.getCacheKey(row.session_id, row.create_time),
                            this.normalizeSessionId(row.session_id),
                            this.normalizeCreateTime(row.create_time),
                            String(row.transcript || ''),
                            Number(row.created_at) || Date.now(),
                        )
                        remove.run(row.cache_key)
                    }
                })()
            }
            this.primaryLegacyMigratedFor.add(accountId)
        } catch (e) {
            console.error('[VoiceTranscribe] 升级旧缓存键失败:', e)
        }
    }

    private findCachedTranscript(
        sessionId: string,
        createTime: number,
        localId?: number,
        allowLegacy = localId === undefined,
    ): string | null {
        if (!this.cacheDb) return null
        this.ensureActiveAccountLegacyMerged()
        this.ensurePrimaryLegacyMigrated()
        const exactKey = this.getCacheKey(sessionId, createTime, localId)
        const keys = [exactKey]
        if (allowLegacy && this.normalizeLocalId(localId) > 0) {
            keys.push(this.getCacheKey(sessionId, createTime))
        }
        if (allowLegacy) keys.push(this.getLegacyCacheKey(sessionId, createTime))

        for (const cacheKey of Array.from(new Set(keys))) {
            const row = this.cacheDb.prepare(
                'SELECT transcript FROM transcript_cache WHERE cache_key = ?'
            ).get(cacheKey) as { transcript: string } | undefined
            if (!row) continue
            const transcript = String(row.transcript || '')
            if (cacheKey !== exactKey && this.normalizeLocalId(localId) > 0) {
                this.saveTranscriptCache(sessionId, createTime, transcript, true, localId)
            }
            return transcript
        }
        return null
    }

    /**
     * 是否已有转写缓存（含空结果占位；用于跳过重复 STT，与「有无可用文本」分开）。
     */
    hasCachedTranscript(sessionId: string, createTime: number, localId?: number, allowLegacy = localId === undefined): boolean {
        try {
            return this.findCachedTranscript(sessionId, createTime, localId, allowLegacy) !== null
        } catch (e) {
            console.error('[VoiceTranscribe] 查询缓存是否存在失败:', e)
            return false
        }
    }

    /**
     * 查询缓存。null = 未转写过；空字符串 = 转过但结果为空（仍算已缓存）。
     */
    getCachedTranscript(sessionId: string, createTime: number, localId?: number, allowLegacy = localId === undefined): string | null {
        try {
            return this.findCachedTranscript(sessionId, createTime, localId, allowLegacy)
        } catch (e) {
            console.error('[VoiceTranscribe] 查询缓存失败:', e)
            return null
        }
    }

    /**
     * 保存到缓存。allowEmpty=true 时允许写入空串，标记「已尝试、勿重复扣额度」。
     */
    saveTranscriptCache(sessionId: string, createTime: number, transcript: string, allowEmpty = false, localId?: number): void {
        if (!this.cacheDb) return
        if (!transcript && !allowEmpty) return

        try {
            this.ensureActiveAccountLegacyMerged()
            this.ensurePrimaryLegacyMigrated()
            const normalizedSessionId = this.normalizeSessionId(sessionId)
            const normalizedCreateTime = this.normalizeCreateTime(createTime)
            const cacheKey = this.getCacheKey(normalizedSessionId, normalizedCreateTime, localId)
            this.cacheDb.prepare(`
                INSERT OR REPLACE INTO transcript_cache 
                (cache_key, session_id, create_time, transcript, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(cacheKey, normalizedSessionId, normalizedCreateTime, transcript || '', Date.now())
        } catch (e) {
            console.error('[VoiceTranscribe] 保存缓存失败:', e)
        }
    }

    /**
     * 清理模型文件
     */
    async clearModel(): Promise<{ success: boolean; error?: string }> {
        try {
            const modelDir = this.resolveModelDir()
            if (!existsSync(modelDir)) {
                return { success: true }
            }

            // 清理所有可能的模型文件（int8 和 float32）
            const filesToClean = [
                SENSEVOICE_MODELS.int8.files.model,
                SENSEVOICE_MODELS.int8.files.tokens,
                SENSEVOICE_MODELS.float32.files.model
            ]

            for (const file of filesToClean) {
                const filePath = join(modelDir, file)
                if (existsSync(filePath)) {
                    unlinkSync(filePath)
                }
            }

            // 尝试删除目录（如果为空）
            try {
                // 读取目录，看是否为空
                const fs = require('fs')
                const remaining = fs.readdirSync(modelDir)
                if (remaining.length === 0) {
                    fs.rmdirSync(modelDir)
                }
            } catch {
                // 忽略删目录错误
            }

            return { success: true }
        } catch (e) {
            console.error('[VoiceTranscribe] 清理模型失败:', e)
            return { success: false, error: String(e) }
        }
    }

    /**
     * 获取模型存储目录
     * 注意：sherpa-onnx 的 C++ 底层无法正确处理中文路径，
     * 所以强制使用 APPDATA 目录（通常不含中文）
     */
    private resolveModelDir(): string {
        // 强制使用 APPDATA 目录，避免中文路径问题
        // Windows: C:\Users\<username>\AppData\Roaming\ciphertalk\models\sensevoice
        return join(getAppDataPath(), 'ciphertalk', 'models', 'sensevoice')
    }

    /**
     * 获取模型文件完整路径
     */
    private resolveModelPath(fileName: string): string {
        return join(this.resolveModelDir(), fileName)
    }

    /**
     * 检查模型状态
     */
    async getModelStatus(): Promise<{
        success: boolean
        exists?: boolean
        modelPath?: string
        tokensPath?: string
        sizeBytes?: number
        error?: string
    }> {
        try {
            const currentModel = this.getCurrentModel()
            const modelPath = this.resolveModelPath(currentModel.files.model)
            const tokensPath = this.resolveModelPath(currentModel.files.tokens)

            const modelExists = existsSync(modelPath)
            const tokensExists = existsSync(tokensPath)
            const exists = modelExists && tokensExists

            if (!exists) {
                return { success: true, exists: false, modelPath, tokensPath }
            }

            const modelSize = statSync(modelPath).size
            const tokensSize = statSync(tokensPath).size
            const totalSize = modelSize + tokensSize

            return {
                success: true,
                exists: true,
                modelPath,
                tokensPath,
                sizeBytes: totalSize
            }
        } catch (error) {
            return { success: false, error: String(error) }
        }
    }

    /**
     * 下载模型文件
     */
    async downloadModel(
        onProgress?: (progress: DownloadProgress) => void
    ): Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }> {
        const cacheKey = 'sensevoice'
        const pending = this.downloadTasks.get(cacheKey)
        if (pending) return pending
        const cancelState: DownloadCancelState = { cancelled: false }
        this.downloadCancels.set(cacheKey, cancelState)

        const task = (async () => {
            try {
                const modelDir = this.resolveModelDir()
                if (!existsSync(modelDir)) {
                    mkdirSync(modelDir, { recursive: true })
                }

                const currentModel = this.getCurrentModel()
                const currentUrls = this.getCurrentModelUrls()
                const modelPath = this.resolveModelPath(currentModel.files.model)
                const tokensPath = this.resolveModelPath(currentModel.files.tokens)

                // 下载模型文件 (60%)
                await this.downloadToFile(
                    currentUrls.model,
                    modelPath,
                    'model',
                    (downloaded, total) => {
                        const percent = total ? (downloaded / total) * 60 : undefined
                        onProgress?.({
                            modelName: currentModel.name,
                            downloadedBytes: downloaded,
                            totalBytes: currentModel.sizeBytes,
                            percent
                        })
                    },
                    cancelState
                )

                // 下载 tokens 文件 (40%)
                await this.downloadToFile(
                    currentUrls.tokens,
                    tokensPath,
                    'tokens',
                    (downloaded, total) => {
                        const modelSize = existsSync(modelPath) ? statSync(modelPath).size : 0
                        const percent = total ? 60 + (downloaded / total) * 40 : 60
                        onProgress?.({
                            modelName: currentModel.name,
                            downloadedBytes: modelSize + downloaded,
                            totalBytes: currentModel.sizeBytes,
                            percent
                        })
                    },
                    cancelState
                )

                return { success: true, modelPath, tokensPath }
            } catch (error) {
                if (cancelState.cancelled) {
                    return { success: false, error: DOWNLOAD_CANCELLED_MESSAGE }
                }

                // 下载失败时清理已下载的文件
                const currentModel = this.getCurrentModel()
                const modelPath = this.resolveModelPath(currentModel.files.model)
                const tokensPath = this.resolveModelPath(currentModel.files.tokens)
                try {
                    if (existsSync(modelPath)) unlinkSync(modelPath)
                    if (existsSync(tokensPath)) unlinkSync(tokensPath)
                } catch { }
                return { success: false, error: String(error) }
            } finally {
                this.downloadTasks.delete(cacheKey)
                this.downloadCancels.delete(cacheKey)
            }
        })()

        this.downloadTasks.set(cacheKey, task)
        return task
    }

    cancelDownloadModel(): { success: boolean; cancelled: boolean; error?: string } {
        const cancelState = this.downloadCancels.get('sensevoice')
        if (!cancelState) {
            return { success: true, cancelled: false, error: '没有正在下载的语音识别模型' }
        }

        cancelState.cancelled = true
        try { cancelState.request?.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE)) } catch { }
        try { cancelState.writer?.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE)) } catch { }
        return { success: true, cancelled: true }
    }

    /**
     * 转写 WAV 音频数据
     */
    async transcribeWavBuffer(
        wavData: Buffer,
        onPartial?: (text: string) => void
    ): Promise<{ success: boolean; transcript?: string; error?: string }> {
        return new Promise((resolve) => {
            try {
                const currentModel = this.getCurrentModel()
                const modelPath = this.resolveModelPath(currentModel.files.model)
                const tokensPath = this.resolveModelPath(currentModel.files.tokens)

                if (!existsSync(modelPath)) {
                    console.error('[VoiceTranscribe] 模型文件不存在:', modelPath)
                    resolve({ success: false, error: '模型文件不存在，请先下载模型' })
                    return
                }
                if (!existsSync(tokensPath)) {
                    console.error('[VoiceTranscribe] Tokens 文件不存在:', tokensPath)
                    resolve({ success: false, error: 'Tokens 文件不存在，请先下载模型' })
                    return
                }

                const { Worker } = require('worker_threads')
                const workerPath = join(__dirname, 'transcribeWorker.js')


                if (!existsSync(workerPath)) {
                    console.error('[VoiceTranscribe] Worker 文件不存在:', workerPath)
                    resolve({ success: false, error: 'Worker 文件不存在: ' + workerPath })
                    return
                }

                const sttLanguages = this.configService.get('sttLanguages') || []
                const language = sttLanguages.length === 1 ? sttLanguages[0] : (sttLanguages.length > 1 ? '' : 'zh')

                const worker = new Worker(workerPath, {
                    workerData: {
                        modelPath,
                        tokensPath,
                        wavData,
                        sampleRate: 16000,
                        language,
                        allowedLanguages: sttLanguages
                    }
                })

                let finalTranscript = ''

                worker.on('message', (msg: any) => {

                    if (msg.type === 'partial') {
                        onPartial?.(msg.text)
                    } else if (msg.type === 'final') {
                        finalTranscript = msg.text

                        resolve({ success: true, transcript: finalTranscript })
                        worker.terminate()
                    } else if (msg.type === 'error') {
                        console.error('[VoiceTranscribe] Worker 错误:', msg.error)
                        resolve({ success: false, error: msg.error })
                        worker.terminate()
                    }
                })

                worker.on('error', (err: Error) => {
                    console.error('[VoiceTranscribe] Worker 异常:', err)
                    resolve({ success: false, error: String(err) })
                })

                worker.on('exit', (code: number) => {
                    if (code !== 0) {

                        resolve({ success: false, error: `Worker 异常退出，代码: ${code}` })
                    }
                })

            } catch (error) {
                console.error('[VoiceTranscribe] 转写异常:', error)
                resolve({ success: false, error: String(error) })
            }
        })
    }

    /**
     * 下载文件到本地
     */
    private downloadToFile(
        url: string,
        targetPath: string,
        fileName: string,
        onProgress?: (downloaded: number, total?: number) => void,
        cancelState?: DownloadCancelState,
        remainingRedirects = 5
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (cancelState?.cancelled) {
                reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                return
            }

            if (existsSync(targetPath)) {
                const downloaded = statSync(targetPath).size
                onProgress?.(downloaded, downloaded)
                resolve()
                return
            }

            const protocol = url.startsWith('https') ? https : http
            const tempPath = `${targetPath}.tmp`
            let downloadedBytes = existsSync(tempPath) ? statSync(tempPath).size : 0


            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    ...(downloadedBytes > 0 ? { Range: `bytes=${downloadedBytes}-` } : {})
                }
            }

            const request = protocol.get(url, options, (response) => {
                if (cancelState?.cancelled) {
                    response.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                    reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                    return
                }

                // 处理重定向
                if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
                    if (remainingRedirects <= 0) {
                        reject(new Error('重定向次数过多'))
                        return
                    }

                    this.downloadToFile(response.headers.location, targetPath, fileName, onProgress, cancelState, remainingRedirects - 1)
                        .then(resolve)
                        .catch(reject)
                    return
                }

                const isResumeResponse = response.statusCode === 206
                if (downloadedBytes > 0 && response.statusCode === 200) {
                    try { unlinkSync(tempPath) } catch { }
                    downloadedBytes = 0
                }

                if (response.statusCode !== 200 && response.statusCode !== 206) {
                    reject(new Error(`下载失败: HTTP ${response.statusCode}`))
                    return
                }

                const contentLength = Number(response.headers['content-length'] || 0) || 0
                const rangeTotal = isResumeResponse
                    ? Number(String(response.headers['content-range'] || '').match(/\/(\d+)$/)?.[1] || 0)
                    : 0
                const totalBytes = rangeTotal || (contentLength ? downloadedBytes + contentLength : undefined)

                const writer = createWriteStream(tempPath, { flags: downloadedBytes > 0 ? 'a' : 'w' })
                if (cancelState) {
                    cancelState.request = request
                    cancelState.writer = writer
                }

                response.on('data', (chunk) => {
                    if (cancelState?.cancelled) {
                        response.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                        writer.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                        return
                    }
                    downloadedBytes += chunk.length
                    onProgress?.(downloadedBytes, totalBytes)
                })

                response.on('error', (error) => {
                    try { writer.close() } catch { }
                    reject(error)
                })

                writer.on('error', (error) => {
                    try { writer.close() } catch { }
                    reject(error)
                })

                writer.on('finish', () => {
                    writer.close()
                    if (cancelState?.cancelled) {
                        reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                        return
                    }
                    renameSync(tempPath, targetPath)

                    resolve()
                })

                response.pipe(writer)
            })

            request.on('error', (error) => {
                if (cancelState?.cancelled) {
                    reject(new Error(DOWNLOAD_CANCELLED_MESSAGE))
                    return
                }
                console.error(`[VoiceTranscribe] ${fileName} 下载错误:`, error)
                reject(error)
            })
            if (cancelState) cancelState.request = request
        })
    }

    /**
     * 清理资源
     */
    dispose() {
        // 目前无需特殊清理
    }
}

export const voiceTranscribeService = new VoiceTranscribeService()
