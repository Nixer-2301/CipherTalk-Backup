/**
 * Agent Canvas 渲染端数据访问 —— window.electronAPI.agentCanvas 的薄封装 + 纯工具函数
 * （下载扩展名映射、保存状态文案）。所有写入仍由主进程校验与落库。
 */
import type { AgentCanvasKind, AgentCanvasRecord, AgentCanvasSaveStatus } from './agentCanvasTypes'

export function canvasApi() {
  const api = window.electronAPI?.agentCanvas
  if (!api) throw new Error('electronAPI.agentCanvas 未就绪（preload 未加载？）')
  return api
}

/** 代码语言 → 下载扩展名；未收录的语言退回 .txt，文档固定 .md */
const LANGUAGE_EXT: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'js',
  json: 'json',
  jsx: 'jsx',
  kotlin: 'kt',
  markdown: 'md',
  php: 'php',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  scss: 'scss',
  shell: 'sh',
  sql: 'sql',
  swift: 'swift',
  tsx: 'tsx',
  typescript: 'ts',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yml',
}

export function canvasFileExtension(kind: AgentCanvasKind, language?: string): string {
  if (kind === 'document') return 'md'
  return LANGUAGE_EXT[String(language || '').toLowerCase()] || 'txt'
}

/** 触发浏览器式下载（内容来自本地状态，不经主进程写文件）。 */
export function downloadCanvasContent(record: AgentCanvasRecord, content: string): void {
  const ext = canvasFileExtension(record.kind, record.language)
  const safeTitle = record.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'canvas'
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeTitle}.${ext}`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function saveStatusLabel(status: AgentCanvasSaveStatus): string {
  switch (status) {
    case 'saving': return '保存中'
    case 'dirty': return '未保存'
    case 'save-failed': return '保存失败'
    case 'conflict': return '存在冲突'
    default: return '已保存'
  }
}
