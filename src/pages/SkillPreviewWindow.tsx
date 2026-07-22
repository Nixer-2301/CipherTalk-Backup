import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, Chip, ScrollShadow, Spinner, Typography } from '@heroui/react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { bundledLanguages, type BundledLanguage } from 'shiki'
import { ChevronRight, File, Folder, FolderOpen } from '@gravity-ui/icons'
import { CodeBlock } from '../components/ai-elements/code-block'
import type { SkillFileItem } from '../types/electron'

type SkillPreviewFile = {
  content: string
  path: string
  size?: number
}

function flattenSkillFiles(items: SkillFileItem[]): SkillFileItem[] {
  return items.flatMap(item => item.type === 'dir'
    ? [item, ...flattenSkillFiles(item.children || [])]
    : [item])
}

function isMarkdownFile(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function formatFileSize(size?: number): string {
  if (typeof size !== 'number') return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function codeLanguageFromPath(path: string): BundledLanguage {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const aliases: Record<string, BundledLanguage> = {
    cjs: 'js',
    cmd: 'bat',
    conf: 'ini',
    cts: 'ts',
    env: 'dotenv',
    h: 'c',
    hpp: 'cpp',
    htm: 'html',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'js',
    mts: 'ts',
    plist: 'xml',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'tsx',
    yml: 'yaml',
  }
  const language = aliases[ext] || ext
  return Object.prototype.hasOwnProperty.call(bundledLanguages, language) ? language as BundledLanguage : 'md'
}

export default function SkillPreviewWindow() {
  const [searchParams] = useSearchParams()
  const skillName = searchParams.get('skill') || ''

  const [skillFiles, setSkillFiles] = useState<SkillFileItem[]>([])
  const [skillFilesTruncated, setSkillFilesTruncated] = useState(false)
  const [skillPreviewFile, setSkillPreviewFile] = useState<SkillPreviewFile | null>(null)
  const [skillPreviewHtml, setSkillPreviewHtml] = useState('')
  const [selectedSkillFilePath, setSelectedSkillFilePath] = useState('SKILL.md')
  const [expandedSkillDirs, setExpandedSkillDirs] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadSkillFilePreview = useCallback(async (filePath: string) => {
    if (!skillName) return
    setLoading(true)
    setError('')
    setSelectedSkillFilePath(filePath)
    setSkillPreviewHtml('')
    try {
      const result = await window.electronAPI.skillManager.readFile(skillName, filePath)
      if (!result.success || typeof result.content !== 'string') {
        setSkillPreviewFile(null)
        setError(result.error || '文件读取失败')
        return
      }
      const nextFile = { content: result.content, path: result.path || filePath, size: result.size }
      setSkillPreviewFile(nextFile)
      if (isMarkdownFile(nextFile.path)) {
        const rendered = await marked.parse(nextFile.content || '')
        setSkillPreviewHtml(DOMPurify.sanitize(rendered))
      }
    } catch (loadError) {
      setSkillPreviewFile(null)
      setError(loadError instanceof Error ? loadError.message : '文件读取失败')
    } finally {
      setLoading(false)
    }
  }, [skillName])

  useEffect(() => {
    if (!skillName) {
      setError('缺少 Skill 名称')
      return
    }
    document.title = `Skill Preview - ${skillName}`
    const loadTree = async () => {
      setLoading(true)
      setError('')
      try {
        const treeResult = await window.electronAPI.skillManager.listFiles(skillName)
        if (!treeResult.success) {
          setError(treeResult.error || '文件树加载失败')
          return
        }
        const files = treeResult.files || []
        setSkillFiles(files)
        setSkillFilesTruncated(Boolean(treeResult.truncated))
        const flatFiles = flattenSkillFiles(files)
        const defaultPath = flatFiles.some(item => item.type === 'file' && item.path === 'SKILL.md')
          ? 'SKILL.md'
          : flatFiles.find(item => item.type === 'file')?.path || 'SKILL.md'
        void loadSkillFilePreview(defaultPath)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '文件树加载失败')
      } finally {
        setLoading(false)
      }
    }
    void loadTree()
  }, [loadSkillFilePreview, skillName])

  const toggleSkillDir = (path: string) => {
    setExpandedSkillDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderSkillFileTree = (items: SkillFileItem[], depth = 0) => items.map(item => {
    const isDir = item.type === 'dir'
    const expanded = expandedSkillDirs.has(item.path)
    const Icon = isDir ? (expanded ? FolderOpen : Folder) : File
    const selected = !isDir && selectedSkillFilePath === item.path

    return (
      <div key={item.path}>
        <Button
          className={`h-7 w-full min-w-0 justify-start rounded-none px-2 text-left font-normal text-xs ${selected ? '' : 'text-muted-foreground'}`}
          onPress={() => {
            if (isDir) toggleSkillDir(item.path)
            else void loadSkillFilePreview(item.path)
          }}
          size="sm"
          style={{ paddingLeft: `${Math.min(depth, 8) * 0.75 + 0.5}rem` }}
          variant={selected ? 'primary' : 'ghost'}
        >
          {isDir ? (
            <ChevronRight className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          ) : (
            <span className="size-3 shrink-0" />
          )}
          <Icon className={`size-3.5 shrink-0 ${isDir ? 'text-accent' : selected ? 'text-accent-foreground' : 'text-muted-foreground'}`} />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {!isDir && item.size !== undefined && (
            <span className={`shrink-0 text-[10px] ${selected ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}>
              {formatFileSize(item.size)}
            </span>
          )}
        </Button>
        {isDir && expanded && item.children && item.children.length > 0 && renderSkillFileTree(item.children, depth + 1)}
      </div>
    )
  })

  const renderContent = () => {
    if (loading && !skillPreviewFile) {
      return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm"><Spinner size="sm" />读取文件中...</div>
    }
    if (error) {
      return <div className="p-4"><Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert></div>
    }
    if (!skillPreviewFile) {
      return <div className="flex h-full items-center justify-center text-muted-foreground text-sm">选择左侧文件预览</div>
    }
    if (!skillPreviewFile.content) {
      return <div className="flex h-full items-center justify-center text-muted-foreground text-sm">空文件</div>
    }
    if (isMarkdownFile(skillPreviewFile.path)) {
      return <Typography.Prose className="max-w-none px-6 py-5"><div dangerouslySetInnerHTML={{ __html: skillPreviewHtml }} /></Typography.Prose>
    }
    return (
      <CodeBlock
        className="h-full min-h-0 rounded-none border-0 bg-transparent [&_.shiki]:min-w-max [&_.shiki]:text-xs [&_pre]:min-h-full"
        code={skillPreviewFile.content}
        language={codeLanguageFromPath(skillPreviewFile.path)}
        showLineNumbers
      />
    )
  }

  return (
    <div className="grid h-screen min-h-0 overflow-hidden bg-background md:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-border/70 bg-surface/45">
        <div className="flex h-[var(--window-chrome-height)] shrink-0 items-center justify-between gap-2 border-b border-border/70 py-0 pr-3 [-webkit-app-region:drag]"
          style={{ paddingLeft: 'var(--window-controls-left-safe)' }}>
          <Typography type="body-xs" weight="semibold" className="uppercase tracking-wide text-muted-foreground">Explorer</Typography>
          {skillFilesTruncated && <Chip variant="secondary" size="sm">已截断</Chip>}
        </div>
        <div className="flex h-8 shrink-0 items-center border-b border-border/50 px-3 text-[11px] font-medium text-foreground">
          <span className="truncate">{skillName}</span>
        </div>
        <ScrollShadow className="min-h-0 flex-1 overflow-auto py-1" size={28}>
          {skillFiles.length > 0 ? <div>{renderSkillFileTree(skillFiles)}</div> : <div className="px-2 py-3 text-muted-foreground text-xs">暂无文件</div>}
        </ScrollShadow>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <div className="flex h-[var(--window-chrome-height)] shrink-0 items-end border-b border-border/70 bg-surface/30 pl-0 [-webkit-app-region:drag]"
          style={{ paddingRight: 'var(--window-controls-right-safe)' }}>
          <div className="flex h-9 max-w-[70%] items-center gap-2 border-r border-border/70 border-t-2 border-t-accent bg-background px-3 text-xs [-webkit-app-region:no-drag]">
            <File className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{skillPreviewFile?.path || selectedSkillFilePath}</span>
          </div>
        </div>
        <ScrollShadow className="min-h-0 flex-1 overflow-auto" size={32}>
          {renderContent()}
        </ScrollShadow>
        <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-surface/45 px-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{skillPreviewFile?.path || selectedSkillFilePath}</span>
          <span className="shrink-0">{formatFileSize(skillPreviewFile?.size) || 'Ready'}</span>
        </div>
      </section>
    </div>
  )
}
