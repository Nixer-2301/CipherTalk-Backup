import { useState, useEffect, useCallback } from 'react'
import type { DatabaseFile } from '../types'
import type { ExportShared } from './useExportShared'

export function useDatabaseExport(shared: ExportShared, active: boolean) {
  const [databases, setDatabases] = useState<DatabaseFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const loadDatabases = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.export.scanDatabases()
      if (result.success && result.databases) {
        setDatabases(result.databases)
      } else {
        setDatabases([])
        if (result.error) console.error('扫描数据库失败:', result.error)
      }
    } catch (e) {
      console.error('扫描数据库失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 切换到本 tab 时首次加载
  useEffect(() => {
    if (active && databases.length === 0) {
      loadDatabases()
    }
  }, [active, databases.length, loadDatabases])

  const keyword = searchKeyword.trim().toLowerCase()
  const filteredDatabases = keyword
    ? databases.filter(
        (d) =>
          d.name.toLowerCase().includes(keyword) || d.relativePath.toLowerCase().includes(keyword)
      )
    : databases

  const toggleSelectAll = () => {
    if (selected.size === filteredDatabases.length && filteredDatabases.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filteredDatabases.map((d) => d.path)))
    }
  }

  const startDatabaseExport = async () => {
    if (!shared.exportFolder || selected.size === 0) return

    shared.setIsExporting(true)
    shared.setExportProgress({ current: 0, total: selected.size, currentName: '', phase: '准备导出', detail: '' })
    shared.setExportResult(null)
    try {
      const result = await window.electronAPI.export.exportDatabases(
        Array.from(selected),
        shared.exportFolder
      )
      shared.setExportResult(result)
    } catch (e) {
      console.error('导出数据库失败:', e)
      shared.setExportResult({ success: false, error: String(e) })
    } finally {
      shared.setIsExporting(false)
    }
  }

  return {
    databases,
    filteredDatabases,
    selected,
    setSelected,
    searchKeyword,
    setSearchKeyword,
    isLoading,
    loadDatabases,
    toggleSelectAll,
    startDatabaseExport
  }
}
