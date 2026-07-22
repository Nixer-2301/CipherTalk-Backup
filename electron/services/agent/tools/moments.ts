/**
 * 朋友圈只读工具：搜索动态与聚合统计。复用 snsService.getTimeline，不触发导出/下载。
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { SnsPost } from '../../snsService'
import { isVideoUrl } from '../../snsService'
import { reportAgentProgress } from '../progress'
import { msToSeconds, toLocalTime, type AgentEvidenceItem } from './shared'

const MAX_TEXT = 240

function compactMoment(post: SnsPost) {
  const media = Array.isArray(post.media) ? post.media : []
  const videoCount = media.filter((item) => isVideoUrl(item.url || item.thumb || '')).length
  const imageCount = Math.max(0, media.length - videoCount)
  const content = String(post.contentDesc || '').replace(/\s+/g, ' ').trim()
  return {
    id: post.id,
    username: post.username,
    nickname: post.nickname || post.username,
    time: toLocalTime(post.createTime),
    createTime: post.createTime,
    content: content.slice(0, MAX_TEXT),
    type: post.type,
    mediaCount: media.length,
    imageCount,
    videoCount,
    hasShare: !!post.shareInfo,
    shareTitle: post.shareInfo?.title || undefined,
    likesCount: Array.isArray(post.likes) ? post.likes.length : 0,
    commentsCount: Array.isArray(post.comments) ? post.comments.length : 0,
    likes: (post.likes || []).slice(0, 20),
    comments: (post.comments || []).slice(0, 20).map((comment) => ({
      nickname: comment.nickname,
      content: String(comment.content || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      refNickname: comment.refNickname,
      emojiCount: comment.emojis?.length || 0,
      imageCount: comment.images?.length || 0,
    })),
  }
}

function evidenceFromMoment(post: ReturnType<typeof compactMoment>): AgentEvidenceItem {
  return {
    id: `moment:${post.id || `${post.username}:${post.createTime}`}`,
    sessionId: post.username,
    time: post.time,
    sender: post.nickname,
    text: post.content || post.shareTitle || `[朋友圈动态：${post.mediaCount} 个媒体]`,
  }
}

function momentContentType(post: ReturnType<typeof compactMoment>): string {
  if (post.hasShare) return '分享'
  if (post.videoCount > 0) return post.imageCount > 0 ? '图文视频' : '视频'
  if (post.imageCount > 0) return post.content ? '图文' : '图片'
  if (post.content) return '文字'
  return '其它'
}

function inc(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] || 0) + amount
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort((a, b) => b[1] - a[1]))
}

function buildStats(posts: Array<ReturnType<typeof compactMoment>>) {
  const byUser: Record<string, number> = {}
  const byType: Record<string, number> = {}
  const byMonth: Record<string, number> = {}
  const byHour: Record<string, number> = {}
  let mediaCount = 0
  let imageCount = 0
  let videoCount = 0
  let likesCount = 0
  let commentsCount = 0

  for (const post of posts) {
    inc(byUser, post.nickname || post.username)
    inc(byType, momentContentType(post))
    mediaCount += post.mediaCount
    imageCount += post.imageCount
    videoCount += post.videoCount
    likesCount += post.likesCount
    commentsCount += post.commentsCount

    const ms = post.createTime > 1e12 ? post.createTime : post.createTime * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) {
      inc(byMonth, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
      inc(byHour, `${String(d.getHours()).padStart(2, '0')}时`)
    }
  }

  const topLiked = posts
    .slice()
    .sort((a, b) => b.likesCount - a.likesCount)
    .slice(0, 10)
    .map((post) => ({ id: post.id, nickname: post.nickname, time: post.time, likesCount: post.likesCount, content: post.content }))
  const topCommented = posts
    .slice()
    .sort((a, b) => b.commentsCount - a.commentsCount)
    .slice(0, 10)
    .map((post) => ({ id: post.id, nickname: post.nickname, time: post.time, commentsCount: post.commentsCount, content: post.content }))

  return {
    totalPosts: posts.length,
    mediaCount,
    imageCount,
    videoCount,
    likesCount,
    commentsCount,
    averages: {
      likesPerPost: posts.length ? Number((likesCount / posts.length).toFixed(2)) : 0,
      commentsPerPost: posts.length ? Number((commentsCount / posts.length).toFixed(2)) : 0,
      mediaPerPost: posts.length ? Number((mediaCount / posts.length).toFixed(2)) : 0,
    },
    byUser: sortRecord(byUser),
    byType: sortRecord(byType),
    byMonth: Object.fromEntries(Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))),
    byHour: Object.fromEntries(Object.entries(byHour).sort(([a], [b]) => a.localeCompare(b))),
    topLiked,
    topCommented,
  }
}

const momentsQuerySchema = z.object({
  usernames: z.array(z.string()).optional().describe('朋友圈发布者 username，可传多个；先用 list_contacts 解析联系人'),
  keyword: z.string().optional().describe('朋友圈正文/XML 关键词'),
  startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
  endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
})

export const searchMoments = tool({
  description:
    '查询/筛选朋友圈动态，只读。适合“某人发过什么朋友圈”“朋友圈里提到 X”“某段时间朋友圈内容”。' +
    '支持发布者 usernames、关键词、时间范围、分页；时间一律毫秒时间戳。返回动态摘要、点赞评论数和出处。',
  inputSchema: momentsQuerySchema.extend({
    limit: z.number().int().min(1).max(100).default(20).describe('返回条数上限'),
    offset: z.number().int().min(0).default(0).describe('分页偏移'),
  }),
  execute: async ({ usernames, keyword, startTimeMs, endTimeMs, limit, offset }) => {
    try {
      reportAgentProgress({
        stage: 'searching',
        title: '搜索朋友圈',
        detail: keyword || (usernames?.length ? usernames.join(', ') : '最近朋友圈'),
      })
      const { snsService } = await import('../../snsService')
      const result = await snsService.getTimeline(
        limit,
        offset,
        usernames,
        keyword,
        msToSeconds(startTimeMs),
        msToSeconds(endTimeMs),
      )
      if (!result.success) return { error: result.error || '查询朋友圈失败' }
      const posts = (result.timeline || []).map(compactMoment)
      return {
        scope: usernames?.length ? 'users' : 'all',
        keyword: keyword || undefined,
        limit,
        offset,
        posts,
        evidence: posts.slice(0, 15).map(evidenceFromMoment),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const momentsStats = tool({
  description:
    '统计朋友圈动态，只读。适合“朋友圈发帖趋势/内容类型占比/谁发得多/点赞评论最多”。' +
    '支持发布者 usernames、关键词、时间范围；返回可直接用于图表的数据分布。',
  inputSchema: momentsQuerySchema.extend({
    limit: z.number().int().min(1).max(2000).default(500).describe('用于统计的最大动态数'),
  }),
  execute: async ({ usernames, keyword, startTimeMs, endTimeMs, limit }) => {
    try {
      reportAgentProgress({
        stage: 'searching',
        title: '统计朋友圈',
        detail: keyword || (usernames?.length ? usernames.join(', ') : `最近 ${limit} 条`),
      })
      const { snsService } = await import('../../snsService')
      const result = await snsService.getTimeline(
        limit,
        0,
        usernames,
        keyword,
        msToSeconds(startTimeMs),
        msToSeconds(endTimeMs),
      )
      if (!result.success) return { error: result.error || '统计朋友圈失败' }
      const posts = (result.timeline || []).map(compactMoment)
      return {
        scope: usernames?.length ? 'users' : 'all',
        keyword: keyword || undefined,
        sampledPosts: posts.length,
        stats: buildStats(posts),
        evidence: posts.slice(0, 15).map(evidenceFromMoment),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
