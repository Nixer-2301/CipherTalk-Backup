import { dirname, join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, createWriteStream } from 'fs'
import { writeFile } from 'fs/promises'
import { ConfigService } from './config'
import { getDefaultCachePath as getPlatformDefaultCachePath } from './platformService'
import { dbAdapter } from './dbAdapter'
import { Isaac64 } from './isaac64'
import https from 'https'
import http from 'http'
import { getDocumentsPath, getExePath } from './runtimePaths'

export interface VideoInfo {
  videoUrl?: string       // 视频文件路径（用�?readFile�?
  coverUrl?: string       // 封面 data URL
  thumbUrl?: string       // 缩略�?data URL
  exists: boolean
  diagnostics?: VideoLookupDiagnostics
}

export interface VideoLookupDiagnostics {
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

export interface ChannelVideoInfo {
  objectId: string
  title: string
  author: string
  avatar?: string
  videoUrl: string
  thumbUrl?: string
  coverUrl?: string
  duration?: number
  width?: number
  height?: number
  decodeKey?: string
}

export interface DownloadProgress {
  downloaded: number
  total: number
  percentage: number
}

export interface DownloadResult {
  success: boolean
  filePath?: string
  error?: string
  needsKey?: boolean  // 是否需要解密 key
}

class VideoService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private logVideoLookup(stage: string, payload: Record<string, unknown> = {}): void {
    void stage
    void payload
  }

  private warnVideoLookup(stage: string, payload: Record<string, unknown> = {}): void {
    void stage
    void payload
  }

  private previewRawContent(content?: string): string | undefined {
    if (!content) return undefined
    const normalized = content.replace(/\s+/g, ' ').trim()
    if (!normalized) return undefined
    return normalized.slice(0, 220)
  }

  /**
   * 获取数据库根目录
   */
  private getDbPath(): string {
    return this.configService.get('dbPath') || ''
  }

  /**
   * 获取当前用户的wxid
   */
  private getMyWxid(): string {
    return this.configService.get('myWxid') || ''
  }

  /**
   * 获取缓存目录（解密后的数据库存放位置�?   */
  private getCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    return this.getDefaultCachePath()
  }

  private getDefaultCachePath(): string {
    return getPlatformDefaultCachePath()
  }

  /**
   * 清理 wxid 目录名（去掉后缀�?
   */
  private cleanWxid(wxid: string): string {
    const trimmed = wxid.trim()
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

  private normalizeMd5(value?: string | null): string | undefined {
    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized || !/^[a-f0-9]{8,}$/.test(normalized)) return undefined
    return normalized
  }

  private addMd5Candidate(candidates: string[], value?: string | null): void {
    const normalized = this.normalizeMd5(value)
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }

  private normalizeVideoFileKey(value?: string | null): string | undefined {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')

    if (!normalized || !/^[a-z0-9_-]{8,}$/.test(normalized)) return undefined
    return normalized
  }

  private addVideoFileKeyCandidate(candidates: string[], value?: string | null): void {
    const normalized = this.normalizeVideoFileKey(value)
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }

  private addResolvedVideoFileKeyCandidates(candidates: string[], value?: string | null): void {
    const normalized = this.normalizeVideoFileKey(value)
    if (!normalized) return

    const normalizedBase = normalized.replace(/_raw$/, '')
    if (normalizedBase !== normalized) {
      this.addVideoFileKeyCandidate(candidates, normalizedBase)
    }
    this.addVideoFileKeyCandidate(candidates, normalized)
  }

  private extractVideoMsgAttribute(content: string, attrName: string): string | undefined {
    const match = new RegExp(`<videomsg[^>]*\\s${attrName}\\s*=\\s*['"]([a-fA-F0-9]+)['"]`, 'i').exec(content)
    return this.normalizeMd5(match?.[1])
  }

  private extractVideoXmlValue(content: string, tagName: string): string | undefined {
    const match = new RegExp(`<${tagName}>\\s*([a-fA-F0-9]+)\\s*<\\/${tagName}>`, 'i').exec(content)
    return this.normalizeMd5(match?.[1])
  }

  private collectVideoMd5Candidates(content?: string, preferredMd5?: string): string[] {
    const candidates: string[] = []

    this.addMd5Candidate(candidates, preferredMd5)
    if (!content) return candidates

    this.addMd5Candidate(candidates, this.extractVideoMsgAttribute(content, 'newmd5'))
    this.addMd5Candidate(candidates, this.extractVideoMsgAttribute(content, 'md5'))
    this.addMd5Candidate(candidates, this.extractVideoMsgAttribute(content, 'rawmd5'))
    this.addMd5Candidate(candidates, this.extractVideoXmlValue(content, 'newmd5'))
    this.addMd5Candidate(candidates, this.extractVideoXmlValue(content, 'md5'))
    this.addMd5Candidate(candidates, this.extractVideoXmlValue(content, 'rawmd5'))

    return candidates
  }

  private formatMd5CandidateSummary(values: string[]): string {
    return values
      .filter(Boolean)
      .slice(0, 3)
      .map(value => value.slice(0, 8))
      .join(' / ')
  }

  private buildLookupSummary(
    reason: VideoLookupDiagnostics['reason'],
    diagnostics: Pick<VideoLookupDiagnostics, 'candidateMd5s' | 'searchedFileKeys' | 'hardlinkMatchedMd5'>
  ): string {
    switch (reason) {
      case 'missing_input':
        return '缺少视频 MD5'
      case 'missing_config':
        return '缺少数据库路径或微信账号'
      case 'account_dir_not_found':
        return '未找到账号目录'
      case 'video_dir_missing':
        return '未找到 msg/video 目录'
      case 'local_file_missing': {
        if (diagnostics.hardlinkMatchedMd5) {
          const resolved = this.formatMd5CandidateSummary(diagnostics.searchedFileKeys || [])
          return resolved ? `hardlink 已命中，但本地文件缺失 ${resolved}` : 'hardlink 已命中，但本地文件缺失'
        }

        const summary = this.formatMd5CandidateSummary(diagnostics.candidateMd5s || [])
        return summary ? `未命中本地缓存，候选 ${summary}` : '未命中本地缓存'
      }
      default:
        return '视频不可用'
    }
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  private isAccountDir(path: string): boolean {
    return (
      existsSync(join(path, 'msg')) ||
      existsSync(join(path, 'db_storage')) ||
      existsSync(join(path, 'hardlink.db'))
    )
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const normalized = dbPath.replace(/[\\/]+$/, '')
    const cleanedWxid = this.cleanWxid(wxid)

    const directCandidates = new Set<string>([
      normalized,
      join(normalized, wxid)
    ])

    if (cleanedWxid !== wxid) {
      directCandidates.add(join(normalized, cleanedWxid))
    }

    for (const candidate of directCandidates) {
      if (this.isAccountDir(candidate)) return candidate
    }

    if (!this.isDirectory(normalized)) return null

    try {
      const entries = readdirSync(normalized)
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()

      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue

        const lowerEntry = entry.toLowerCase()
        const cleanedEntry = this.cleanWxid(entry).toLowerCase()
        if (
          lowerEntry === wxidLower ||
          lowerEntry === cleanedWxidLower ||
          lowerEntry.startsWith(`${wxidLower}_`) ||
          lowerEntry.startsWith(`${cleanedWxidLower}_`) ||
          cleanedEntry === wxidLower ||
          cleanedEntry === cleanedWxidLower
        ) {
          if (this.isAccountDir(entryPath)) return entryPath
        }
      }
    } catch {
      // ignore
    }

    return null
  }

  /**
   * �?video_hardlink_info_v4 表查询视频文件名
   */
  private resolveHardlinkDbPath(): string | undefined {
    const cachePath = this.getCachePath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)
    const dbPath = this.getDbPath()
    
    if (!cachePath || !wxid) return undefined

    // hardlink.db 可能在多个位�?
    const possiblePaths = new Set<string>([
      join(cachePath, cleanedWxid, 'hardlink.db'),
      join(cachePath, wxid, 'hardlink.db'),
      join(cachePath, 'hardlink.db'),
      join(cachePath, 'databases', cleanedWxid, 'hardlink.db'),
      join(cachePath, 'databases', wxid, 'hardlink.db')
    ])

    // Mac: 动态扫描 xwechat_files 下各子目录的 hardlink 路径
    if (process.platform === 'darwin') {
      const home = require('os').homedir()
      const xwechatRoot = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
      if (existsSync(xwechatRoot)) {
        try {
          const entries = readdirSync(xwechatRoot)
          for (const entry of entries) {
            possiblePaths.add(join(xwechatRoot, entry, 'db_storage', 'hardlink'))
          }
        } catch { /* ignore */ }
      }
    }

    if (dbPath) {
      const baseCandidates = new Set<string>([
        dbPath,
        join(dbPath, wxid),
        join(dbPath, cleanedWxid)
      ])
      for (const base of baseCandidates) {
        possiblePaths.add(join(base, 'hardlink.db'))
        possiblePaths.add(join(base, 'msg', 'hardlink.db'))
      }
    }
    
    let hardlinkDbPath: string | undefined
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        hardlinkDbPath = p
        break
      }
    }
    
    return hardlinkDbPath
  }

  private async queryVideoFileNames(md5Candidates: string[]): Promise<{
    fileKeys: string[]
    hardlinkDbPath?: string
    hardlinkMatchedMd5?: string
  }> {
    const hardlinkDbPath = this.resolveHardlinkDbPath()
    if (!hardlinkDbPath || md5Candidates.length === 0) {
      return { fileKeys: [], hardlinkDbPath }
    }

    try {
      const fileKeys: string[] = []
      let hardlinkMatchedMd5: string | undefined

      for (const md5 of md5Candidates) {
        const row = await dbAdapter.get<{ file_name?: string; md5?: string }>(
          'hardlink',
          '',
          'SELECT file_name, md5 FROM video_hardlink_info_v4 WHERE md5 = ? LIMIT 1',
          [md5]
        )
        const normalizedFileKey = this.normalizeVideoFileKey(row?.file_name)
        if (!normalizedFileKey) continue

        if (!hardlinkMatchedMd5) {
          hardlinkMatchedMd5 = this.normalizeMd5(row?.md5) || md5
        }

        this.addResolvedVideoFileKeyCandidates(fileKeys, normalizedFileKey)
      }

      this.logVideoLookup('hardlink-query', {
        hardlinkDbPath,
        md5Candidates,
        fileKeys,
        hardlinkMatchedMd5
      })

      return { fileKeys, hardlinkDbPath, hardlinkMatchedMd5 }
    } catch (error) {
      this.warnVideoLookup('hardlink-query-error', {
        hardlinkDbPath,
        md5Candidates,
        error: String(error)
      })
      return { fileKeys: [], hardlinkDbPath }
    }
  }

  /**
   * 将文件转换为 data URL
   */
  private fileToDataUrl(filePath: string, mimeType: string): string | undefined {
    try {
      if (!existsSync(filePath)) return undefined
      const buffer = readFileSync(filePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      return undefined
    }
  }

  /**
   * 根据视频MD5获取视频文件信息
   * 视频存放�? {数据库根目录}/{用户wxid}/msg/video/{年月}/
   * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
   */
  async getVideoInfo(videoMd5: string, rawContent?: string): Promise<VideoInfo> {
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()
    const requestedMd5 = this.normalizeMd5(videoMd5)
    const candidateMd5s = this.collectVideoMd5Candidates(rawContent, requestedMd5)
    const diagnostics: VideoLookupDiagnostics = {
      requestedMd5,
      candidateMd5s
    }

    this.logVideoLookup('request', {
      requestedMd5,
      candidateMd5s,
      hasRawContent: Boolean(rawContent),
      rawPreview: this.previewRawContent(rawContent),
      dbPath,
      wxid
    })

    if (candidateMd5s.length === 0) {
      diagnostics.reason = 'missing_input'
      diagnostics.summary = this.buildLookupSummary('missing_input', diagnostics)
      this.warnVideoLookup('missing-input', diagnostics)
      return { exists: false, diagnostics }
    }

    if (!dbPath || !wxid) {
      diagnostics.reason = 'missing_config'
      diagnostics.summary = this.buildLookupSummary('missing_config', diagnostics)
      this.warnVideoLookup('missing-config', diagnostics)
      return { exists: false, diagnostics }
    }

    const accountDir = this.resolveAccountDir(dbPath, wxid)
    diagnostics.accountDir = accountDir || undefined

    this.logVideoLookup('account-dir', {
      requestedMd5,
      accountDir,
      dbPath,
      wxid
    })

    if (!accountDir) {
      diagnostics.reason = 'account_dir_not_found'
      diagnostics.summary = this.buildLookupSummary('account_dir_not_found', diagnostics)
      this.warnVideoLookup('account-dir-not-found', diagnostics)
      return { exists: false, diagnostics }
    }

    const videoBaseDir = join(accountDir, 'msg', 'video')
    diagnostics.videoBaseDir = videoBaseDir

    const hardlinkResult = await this.queryVideoFileNames(candidateMd5s)
    diagnostics.hardlinkDbPath = hardlinkResult.hardlinkDbPath
    diagnostics.hardlinkMatchedMd5 = hardlinkResult.hardlinkMatchedMd5

    const fileKeys = [...candidateMd5s]
    for (const fileKey of hardlinkResult.fileKeys) {
      this.addResolvedVideoFileKeyCandidates(fileKeys, fileKey)
    }
    diagnostics.searchedFileKeys = fileKeys

    this.logVideoLookup('search-plan', {
      requestedMd5,
      candidateMd5s,
      hardlinkDbPath: diagnostics.hardlinkDbPath,
      hardlinkMatchedMd5: diagnostics.hardlinkMatchedMd5,
      searchedFileKeys: diagnostics.searchedFileKeys,
      videoBaseDir
    })

    if (!existsSync(videoBaseDir)) {
      diagnostics.reason = 'video_dir_missing'
      diagnostics.summary = this.buildLookupSummary('video_dir_missing', diagnostics)
      this.warnVideoLookup('video-dir-missing', diagnostics)
      return { exists: false, diagnostics }
    }

    // 遍历年月目录查找视频文件
    try {
      const allDirs = readdirSync(videoBaseDir)
      
      // 支持多种目录格式: YYYY-MM, YYYYMM, 或其�?
      const yearMonthDirs = allDirs
        .filter(dir => {
          const dirPath = join(videoBaseDir, dir)
          return statSync(dirPath).isDirectory()
        })
        .sort((a, b) => b.localeCompare(a)) // 从最新的目录开始查�?

      for (const yearMonth of yearMonthDirs) {
        const dirPath = join(videoBaseDir, yearMonth)

        for (const fileKey of fileKeys) {
          const videoPath = join(dirPath, `${fileKey}.mp4`)
          const assetKey = fileKey.replace(/_raw$/, '')
          const coverPath = join(dirPath, `${assetKey}.jpg`)
          const thumbPath = join(dirPath, `${assetKey}_thumb.jpg`)

          // 检查视频文件是否存�?
          if (existsSync(videoPath)) {
            diagnostics.matchedMd5 = fileKey
            this.logVideoLookup('local-file-hit', {
              requestedMd5,
              matchedMd5: fileKey,
              yearMonth,
              videoPath,
              coverExists: existsSync(coverPath),
              thumbExists: existsSync(thumbPath)
            })
            return {
              videoUrl: `file:///${videoPath.replace(/\\/g, '/')}`,  // 转换为 file:// 协议
              coverUrl: this.fileToDataUrl(coverPath, 'image/jpeg'),
              thumbUrl: this.fileToDataUrl(thumbPath, 'image/jpeg'),
              exists: true,
              diagnostics
            }
          }
        }
      }
    } catch (error) {
      this.warnVideoLookup('scan-error', {
        requestedMd5,
        videoBaseDir,
        searchedFileKeys: diagnostics.searchedFileKeys,
        error: String(error)
      })
    }

    diagnostics.reason = 'local_file_missing'
    diagnostics.summary = this.buildLookupSummary('local_file_missing', diagnostics)
    this.warnVideoLookup('local-file-missing', diagnostics)
    return { exists: false, diagnostics }
  }

  /**
   * 根据消息内容解析视频MD5
   */
  parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      return (
        this.extractVideoXmlValue(content, 'md5') ||
        this.extractVideoMsgAttribute(content, 'md5') ||
        this.extractVideoXmlValue(content, 'newmd5') ||
        this.extractVideoMsgAttribute(content, 'newmd5') ||
        this.extractVideoXmlValue(content, 'rawmd5') ||
        this.extractVideoMsgAttribute(content, 'rawmd5')
      )
    } catch (e) {
      console.error('解析视频MD5失败:', e)
    }

    return undefined
  }

  /**
   * 从聊天消息 XML 中解析视频号信息
   */
  parseChannelVideoFromXml(content: string): ChannelVideoInfo | undefined {
    if (!content) return undefined

    try {
      // 提取 finderFeed 内容
      const finderMatch = /<finderFeed>([\s\S]*?)<\/finderFeed>/i.exec(content)
      if (!finderMatch) return undefined

      const finderXml = finderMatch[1]

      // 提取基本信息
      const objectIdMatch = /<objectId>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/objectId>/i.exec(finderXml)
      const nicknameMatch = /<nickname>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/nickname>/i.exec(finderXml)
      const descMatch = /<desc>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/desc>/i.exec(finderXml)
      const avatarMatch = /<avatar>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/avatar>/i.exec(finderXml)

      if (!objectIdMatch) return undefined

      const objectId = objectIdMatch[1]
      const author = nicknameMatch ? nicknameMatch[1] : '未知作者'
      const title = descMatch ? descMatch[1] : '视频号视频'
      const avatar = avatarMatch ? avatarMatch[1] : undefined

      // 提取媒体信息
      const mediaListMatch = /<mediaList>([\s\S]*?)<\/mediaList>/i.exec(finderXml)
      if (!mediaListMatch) return undefined

      const mediaXml = mediaListMatch[1]
      const urlMatch = /<url>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/url>/i.exec(mediaXml)
      const thumbUrlMatch = /<thumbUrl>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/thumbUrl>/i.exec(mediaXml)
      const coverUrlMatch = /<coverUrl>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/coverUrl>/i.exec(mediaXml)
      const durationMatch = /<videoPlayDuration>[\s\S]*?<!\[CDATA\[(\d+)\]\]>[\s\S]*?<\/videoPlayDuration>/i.exec(mediaXml)
      const widthMatch = /<width>[\s\S]*?<!\[CDATA\[(\d+)\]\]>[\s\S]*?<\/width>/i.exec(mediaXml)
      const heightMatch = /<height>[\s\S]*?<!\[CDATA\[(\d+)\]\]>[\s\S]*?<\/height>/i.exec(mediaXml)
      const decodeKeyMatch = /<decodeKey>[\s\S]*?<!\[CDATA\[(.*?)\]\]>[\s\S]*?<\/decodeKey>/i.exec(mediaXml)

      if (!urlMatch) return undefined

      return {
        objectId,
        title,
        author,
        avatar,
        videoUrl: urlMatch[1],
        thumbUrl: thumbUrlMatch ? thumbUrlMatch[1] : undefined,
        coverUrl: coverUrlMatch ? coverUrlMatch[1] : undefined,
        duration: durationMatch ? parseInt(durationMatch[1]) : undefined,
        width: widthMatch ? parseInt(widthMatch[1]) : undefined,
        height: heightMatch ? parseInt(heightMatch[1]) : undefined,
        decodeKey: decodeKeyMatch ? decodeKeyMatch[1] : undefined
      }
    } catch (e) {
      console.error('解析视频号信息失败:', e)
      return undefined
    }
  }

  /**
   * 下载视频号视频
   * @param videoInfo 视频信息
   * @param key 解密密钥（可选）
   * @param onProgress 进度回调
   */
  async downloadChannelVideo(
    videoInfo: ChannelVideoInfo,
    key?: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    try {
      console.log('[ChannelVideo] 开始下载:', videoInfo.objectId)
      console.log('[ChannelVideo] 完整URL:', videoInfo.videoUrl)

      if (!videoInfo.videoUrl) {
        console.error('[ChannelVideo] videoUrl 为空')
        return { success: false, error: '视频地址为空' }
      }

      // 创建下载目录
      const cachePath = this.getCachePath()
      const channelDir = join(cachePath, 'channel_videos', this.sanitizeFilename(videoInfo.author))
      
      if (!existsSync(channelDir)) {
        mkdirSync(channelDir, { recursive: true })
      }

      // 生成文件名
      const filename = `${this.sanitizeFilename(videoInfo.title)}_${videoInfo.objectId}.mp4`
      const filePath = join(channelDir, filename)

      // 检查文件是否已存在
      if (existsSync(filePath)) {
        return {
          success: true,
          filePath
        }
      }

      // 下载视频
      const tempPath = filePath + '.tmp'
      const downloaded = await this.downloadFile(videoInfo.videoUrl, tempPath, onProgress)

      if (downloaded !== true) {
        const msg = downloaded === 400 || downloaded === 403 ? '链接已过期，无法下载' : '下载失败'
        return { success: false, error: msg }
      }

      // 检查下载的文件大小
      const stat = require('fs').statSync(tempPath)
      console.log('[ChannelVideo] 下载完成, 文件大小:', stat.size)

      // TODO: 后续实现解密（需要通过 JS Hook 获取 decodeKey）

      // 重命名为最终文件
      require('fs').renameSync(tempPath, filePath)

      return {
        success: true,
        filePath
      }
    } catch (e: any) {
      console.error('下载视频号视频失败:', e)
      return {
        success: false,
        error: e.message || '下载失败'
      }
    }
  }

  /**
   * 下载文件
   */
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<true | number> {
    return new Promise((resolve) => {
      const doRequest = (currentUrl: string, redirectsLeft: number) => {
        try {
          console.log('[ChannelVideo] 请求URL:', currentUrl.substring(0, 120), '剩余重定向:', redirectsLeft)
          const parsedUrl = new URL(currentUrl)
          const reqPath = parsedUrl.pathname + parsedUrl.search
          console.log('[ChannelVideo] 解析path长度:', reqPath.length, 'search长度:', parsedUrl.search.length)
          const proto = parsedUrl.protocol === 'https:' ? https : http
          const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
              'Referer': 'https://channels.weixin.qq.com/'
            }
          }

          proto.get(reqOptions, (response) => {
            console.log('[ChannelVideo] 响应状态:', response.statusCode)
            // 处理重定向
            if ([301, 302, 303, 307, 308].includes(response.statusCode!) && response.headers.location) {
              if (redirectsLeft <= 0) {
                console.error('重定向次数过多')
                resolve(0)
                return
              }
              doRequest(response.headers.location, redirectsLeft - 1)
              return
            }

            if (response.statusCode !== 200) {
              console.error('下载失败，状态码:', response.statusCode)
              resolve(response.statusCode || 0)
              return
            }

            const totalSize = parseInt(response.headers['content-length'] || '0', 10)
            let downloadedSize = 0
            const fileStream = createWriteStream(destPath)

            response.on('data', (chunk) => {
              downloadedSize += chunk.length
              if (onProgress && totalSize > 0) {
                onProgress({
                  downloaded: downloadedSize,
                  total: totalSize,
                  percentage: (downloadedSize / totalSize) * 100
                })
              }
            })

            response.pipe(fileStream)

            fileStream.on('finish', () => {
              fileStream.close()
              resolve(true)
            })

            fileStream.on('error', (err) => {
              console.error('写入文件失败:', err)
              fileStream.close()
              resolve(0)
            })
          }).on('error', (err) => {
            console.error('下载请求失败:', err)
            resolve(0)
          })
        } catch (e) {
          console.error('下载异常:', e)
          resolve(0)
        }
      }

      doRequest(url, 5)
    })
  }

  /**
   * 检查视频是否加密
   * 通过检查文件头部特征判断
   */
  private async checkIfEncrypted(filePath: string): Promise<boolean> {
    try {
      const fd = require('fs').openSync(filePath, 'r')
      const header = Buffer.alloc(12)
      require('fs').readSync(fd, header, 0, 12, 0)
      require('fs').closeSync(fd)

      const sig = header.toString('ascii', 4, 8)
      console.log('[ChannelVideo] 文件头签名:', sig, '前12字节hex:', header.toString('hex'))

      // MP4 box types that indicate a valid video file
      if (['ftyp', 'mdat', 'moov', 'free', 'skip', 'wide'].includes(sig)) {
        return false
      }
      // 也检查前4字节是否是常见视频格式
      const head4 = header.toString('hex', 0, 4)
      if (head4 === '1a45dfa3' || head4 === '464c5601') { // WebM / FLV
        return false
      }
      return true
    } catch (e) {
      console.error('检查加密状态失败:', e)
      return false
    }
  }

  /**
   * 使用 ISAAC64 解密视频号视频
   * 只解密前 128KB
   */
  private async decryptChannelVideo(filePath: string, key: string): Promise<boolean> {
    try {
      const buffer = readFileSync(filePath)
      const prefixLen = 131072  // 128KB

      if (buffer.length === 0) return false

      // 生成解密密钥流
      const isaac = new Isaac64(key)
      const keystream = isaac.generateKeystreamBE(Math.min(prefixLen, buffer.length))

      // XOR 解密前 128KB
      const decryptLen = Math.min(prefixLen, buffer.length)
      for (let i = 0; i < decryptLen; i++) {
        buffer[i] ^= keystream[i]
      }

      // 写回文件
      await writeFile(filePath, buffer)
      return true
    } catch (e) {
      console.error('解密视频失败:', e)
      return false
    }
  }

  /**
   * 清理文件名中的非法字符
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')  // 替换非法字符
      .replace(/\s+/g, '_')            // 替换空格
      .substring(0, 100)               // 限制长度
  }
}

export const videoService = new VideoService()
