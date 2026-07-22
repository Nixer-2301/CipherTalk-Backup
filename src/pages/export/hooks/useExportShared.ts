import { useState, useEffect, useCallback } from 'react'
import * as configService from '../../../services/config'
import type { ExportProgress, ExportResult } from '../types'

export interface ExportShared {
  exportFolder: string
  isExporting: boolean
  setIsExporting: (v: boolean) => void
  exportProgress: ExportProgress
  setExportProgress: React.Dispatch<React.SetStateAction<ExportProgress>>
  exportResult: ExportResult | null
  setExportResult: (r: ExportResult | null) => void
  selectExportFolder: () => Promise<void>
  openExportFolder: () => Promise<void>
}

const EMPTY_PROGRESS: ExportProgress = {
  current: 0,
  total: 0,
  currentName: '',
  phase: '',
  detail: ''
}

// 三个 tab 共享的导出状态：目标文件夹、导出中标志、进度、结果
export function useExportShared(): ExportShared {
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress>(EMPTY_PROGRESS)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)

  // 监听导出进度
  useEffect(() => {
    const removeListener = window.electronAPI.export.onProgress((data) => {
      // 将 phase 英文映射为中文描述
      const phaseMap: Record<string, string> = {
        'preparing': '正在准备...',
        'exporting': '正在导出...',
        'writing': '正在写入文件...',
        'complete': '导出完成'
      }
      setExportProgress({
        current: data.current || 0,
        total: data.total || 0,
        currentName: data.currentSession || '',
        phase: (data.phase ? phaseMap[data.phase] : undefined) || data.phase || '',
        detail: data.detail || ''
      })
    })

    return () => {
      removeListener()
    }
  }, [])

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  useEffect(() => {
    loadExportPath()
  }, [loadExportPath])

  const openExportFolder = useCallback(async () => {
    if (exportFolder) {
      await window.electronAPI.shell.openPath(exportFolder)
    }
  }, [exportFolder])

  // 选择导出文件夹
  const selectExportFolder = useCallback(async () => {
    try {
      const result = await window.electronAPI.dialog.openFile({
        properties: ['openDirectory'],
        title: '选择导出位置'
      })
      if (!result.canceled && result.filePaths.length > 0) {
        const newPath = result.filePaths[0]
        setExportFolder(newPath)
        // 保存到配置
        await configService.setExportPath(newPath)
      }
    } catch (e) {
      console.error('选择文件夹失败:', e)
    }
  }, [])

  return {
    exportFolder,
    isExporting,
    setIsExporting,
    exportProgress,
    setExportProgress,
    exportResult,
    setExportResult,
    selectExportFolder,
    openExportFolder
  }
}
