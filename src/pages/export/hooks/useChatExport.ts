import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import * as configService from '../../../services/config'
import { fetchAllSessions } from '../../../services/chatSessions'
import type { ChatSession, ExportOptions, SessionTypeFilter } from '../types'
import type { ExportShared } from './useExportShared'
import { isExcludedSession } from '../utils'

// 计算「最近 N 天」的起止日期字符串
function computeDefaultDateRange(defaultDateRange: number): { startDate: string; endDate: string } {
  if (defaultDateRange <= 0) {
    return { startDate: '', endDate: '' }
  }

  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  const todayStr = `${year}-${month}-${day}`

  if (defaultDateRange === 1) {
    // 最近1天 = 今天
    return { startDate: todayStr, endDate: todayStr }
  }

  // 其他天数：从 N 天前到今天
  const start = new Date(today)
  start.setDate(today.getDate() - defaultDateRange + 1)
  const startYear = start.getFullYear()
  const startMonth = String(start.getMonth() + 1).padStart(2, '0')
  const startDay = String(start.getDate()).padStart(2, '0')

  return { startDate: `${startYear}-${startMonth}-${startDay}`, endDate: todayStr }
}

export function useChatExport(shared: ExportShared) {
  const location = useLocation()
  const preSelectAppliedRef = useRef(false)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [filteredSessions, setFilteredSessions] = useState<ChatSession[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sessionTypeFilter, setSessionTypeFilter] = useState<SessionTypeFilter>('all')

  const [options, setOptions] = useState<ExportOptions>({
    format: 'chatlab',
    startDate: '',
    endDate: '',
    exportAvatars: true,
    exportImages: false,
    exportVideos: false,
    exportEmojis: false,
    exportVoices: false
  })

  // 加载聊天会话
  const loadSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoading(false)
        return
      }
      const allSessions = await fetchAllSessions()
      setSessions(allSessions)
      setFilteredSessions(allSessions)
      if (!preSelectAppliedRef.current) {
        const state = location.state as { preSelectedSessions?: string[] } | null
        if (state?.preSelectedSessions?.length) {
          preSelectAppliedRef.current = true
          setSelectedSessions(new Set(state.preSelectedSessions))
        }
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [location.state])

  // 加载默认时间范围配置
  const loadDefaultDateRange = useCallback(async () => {
    try {
      const defaultDateRange = await configService.getExportDefaultDateRange()
      const { startDate, endDate } = computeDefaultDateRange(defaultDateRange)
      setOptions(prev => ({ ...prev, startDate, endDate, exportAvatars: true }))
    } catch (e) {
      console.error('加载默认导出配置失败:', e)
      // 即使加载失败也不影响页面显示，使用默认值
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadDefaultDateRange()
  }, [loadSessions, loadDefaultDateRange])

  // 聊天会话搜索与类型过滤
  useEffect(() => {
    // 先排除公众号/服务号/系统账号，「全部」只含群聊与真人私聊
    let filtered = sessions.filter(s => !isExcludedSession(s.username))

    // 类型过滤
    if (sessionTypeFilter === 'group') {
      filtered = filtered.filter(s => s.username.includes('@chatroom'))
    } else if (sessionTypeFilter === 'private') {
      filtered = filtered.filter(s => !s.username.includes('@chatroom'))
    }

    // 关键词过滤
    if (searchKeyword.trim()) {
      const lower = searchKeyword.toLowerCase()
      filtered = filtered.filter(s =>
        s.displayName?.toLowerCase().includes(lower) ||
        s.username.toLowerCase().includes(lower)
      )
    }

    setFilteredSessions(filtered)
  }, [searchKeyword, sessions, sessionTypeFilter])

  // 导出聊天记录
  const startExport = async () => {
    if (selectedSessions.size === 0 || !shared.exportFolder) return

    shared.setIsExporting(true)
    shared.setExportProgress({ current: 0, total: selectedSessions.size, currentName: '', phase: '准备导出', detail: '' })
    shared.setExportResult(null)

    try {
      const sessionList = Array.from(selectedSessions)
      const exportOptions = {
        format: options.format,
        dateRange: (options.startDate && options.endDate) ? {
          start: Math.floor(new Date(options.startDate + 'T00:00:00').getTime() / 1000),
          end: Math.floor(new Date(options.endDate + 'T23:59:59').getTime() / 1000)
        } : null,
        exportAvatars: options.exportAvatars,
        exportImages: options.exportImages,
        exportVideos: options.exportVideos,
        exportEmojis: options.exportEmojis,
        exportVoices: options.exportVoices
      }

      if (options.format === 'chatlab' || options.format === 'chatlab-jsonl' || options.format === 'json' || options.format === 'excel' || options.format === 'html' || options.format === 'sql') {
        const result = await window.electronAPI.export.exportSessions(
          sessionList,
          shared.exportFolder,
          exportOptions
        )
        shared.setExportResult(result)
      } else {
        shared.setExportResult({ success: false, error: `${options.format.toUpperCase()} 格式导出功能开发中...` })
      }
    } catch (e) {
      console.error('导出失败:', e)
      shared.setExportResult({ success: false, error: String(e) })
    } finally {
      shared.setIsExporting(false)
    }
  }

  return {
    sessions,
    filteredSessions,
    selectedSessions,
    setSelectedSessions,
    isLoading,
    searchKeyword,
    setSearchKeyword,
    sessionTypeFilter,
    setSessionTypeFilter,
    options,
    setOptions,
    loadSessions,
    startExport
  }
}
