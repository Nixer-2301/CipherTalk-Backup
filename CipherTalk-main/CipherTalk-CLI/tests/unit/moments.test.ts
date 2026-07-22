import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { wcdbMock, dbAdapterMock } = vi.hoisted(() => ({
  wcdbMock: {
    open: vi.fn(),
    getSnsTimeline: vi.fn(),
    execQuery: vi.fn(),
    execQueryWithParams: vi.fn()
  },
  dbAdapterMock: {
    all: vi.fn(),
    get: vi.fn(),
    exec: vi.fn()
  }
}))

vi.mock('../../src/services/db/wcdbService.js', () => ({
  wcdbService: wcdbMock,
  WcdbService: class {}
}))

vi.mock('../../src/services/db/dbAdapter.js', () => ({
  dbAdapter: dbAdapterMock
}))

import { getMomentsTimeline } from '../../src/services/sns/snsService.js'
import type { RuntimeConfig } from '../../src/types.js'

const config: RuntimeConfig = {
  dbPath: '/tmp/fake-db',
  keyHex: 'a'.repeat(64),
  wxid: 'wxid_test',
  defaultFormat: 'json',
  defaultLimit: 20,
  cacheDir: '/tmp/cache',
  configPath: '/tmp/config'
}

beforeEach(() => {
  wcdbMock.open.mockReset()
  wcdbMock.getSnsTimeline.mockReset()
  dbAdapterMock.all.mockReset()
  dbAdapterMock.get.mockReset()
  wcdbMock.open.mockResolvedValue(true)
  dbAdapterMock.all.mockResolvedValue([
    { username: 'wxid_friend_a', nickname: '小明', remark: '' },
    { username: 'wxid_friend_b', nickname: '小李', remark: '李子' }
  ])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('getMomentsTimeline', () => {
  it('normalizes timeline rows into MomentsEntry shape', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValueOnce({
      success: true,
      timeline: [
        {
          id: '13888',
          username: 'wxid_friend_a',
          createTime: 1700000000,
          contentDesc: '今天天气不错',
          rawXml: '<TimelineObject><id>13888</id><createTime>1700000000</createTime><contentDesc><![CDATA[今天天气不错]]></contentDesc><LikeUserList><name>a</name><name>b</name></LikeUserList></TimelineObject>',
          media: [{ url: 'https://example.com/img.jpg', thumb: 'https://example.com/t.jpg' }],
          likes: ['a', 'b'],
          comments: [{ id: 'c1' }]
        }
      ]
    })

    const result = await getMomentsTimeline(config, { limit: 5 })
    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.id).toBe('13888')
    expect(entry.author.wxid).toBe('wxid_friend_a')
    expect(entry.author.displayName).toBe('小明')
    expect(entry.createTime).toBe(1700000000)
    expect(entry.contentText).toBe('今天天气不错')
    expect(entry.mediaUrls).toContain('https://example.com/img.jpg')
    expect(entry.likes).toBe(2)
    expect(entry.comments).toBe(1)
    expect(result.meta?.nativeSupported).toBe(true)
    expect(result.limit).toBe(5)
    expect(result.total).toBe(1)
  })

  it('clamps limit to 200 and defaults to 20', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValue({ success: true, timeline: [] })

    const def = await getMomentsTimeline(config)
    expect(def.limit).toBe(20)
    const big = await getMomentsTimeline(config, { limit: 9999 })
    expect(big.limit).toBe(200)
    const zero = await getMomentsTimeline(config, { limit: 0 })
    expect(zero.limit).toBe(20)
  })

  it('parses fields out of XML when native row only carries content', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValueOnce({
      success: true,
      timeline: [
        {
          username: 'wxid_friend_b',
          content: '<TimelineObject><id>42</id><createTime>1234567890</createTime><contentDesc>仅 XML</contentDesc><url type="2">https://img.example.com/photo.jpg</url></TimelineObject>'
        }
      ]
    })

    const result = await getMomentsTimeline(config, { limit: 3 })
    expect(result.entries[0].id).toBe('42')
    expect(result.entries[0].createTime).toBe(1234567890)
    expect(result.entries[0].contentText).toBe('仅 XML')
    expect(result.entries[0].mediaUrls).toEqual(['https://img.example.com/photo.jpg'])
    expect(result.entries[0].author.displayName).toBe('李子')
  })

  it('passes time range filters and username filter to native', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValueOnce({ success: true, timeline: [] })
    await getMomentsTimeline(config, {
      limit: 30,
      user: 'wxid_friend_a',
      from: '2024-01-01',
      to: '2024-12-31'
    })
    const call = wcdbMock.getSnsTimeline.mock.calls[0]
    // signature: (limit, offset, usernames, keyword, startTime, endTime)
    expect(call[0]).toBe(30)
    expect(call[1]).toBe(0)
    expect(call[2]).toEqual(['wxid_friend_a'])
    expect(call[3]).toBeUndefined()
    expect(typeof call[4]).toBe('number')
    expect(typeof call[5]).toBe('number')
    expect(call[4]).toBeLessThan(call[5])
  })

  it('gracefully degrades when native SNS symbol is missing', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValueOnce({ success: false, error: 'native 未支持 SNS 查询' })

    const result = await getMomentsTimeline(config, { limit: 10 })
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
    expect(result.meta?.nativeSupported).toBe(false)
    expect(result.meta?.note).toContain('native')
  })

  it('throws MiyuError for hard failures unrelated to support', async () => {
    wcdbMock.getSnsTimeline.mockResolvedValueOnce({ success: false, error: '查询执行失败' })
    await expect(getMomentsTimeline(config, { limit: 10 })).rejects.toThrow(/查询执行失败/)
  })

  it('throws when db path or key missing', async () => {
    const bad: RuntimeConfig = { ...config, dbPath: undefined }
    await expect(getMomentsTimeline(bad)).rejects.toThrow(/db-path|微信数据目录/)
  })
})
