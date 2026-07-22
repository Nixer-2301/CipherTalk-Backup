import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, mkdtempSync, renameSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import AdmZip from 'adm-zip'
import type { AgentSkillContextItem } from './agent/types'

type AdmZipFull = InstanceType<typeof AdmZip> & {
  getEntries(): Array<{ entryName: string }>
  extractAllTo(targetPath: string, overwrite: boolean): void
}

export type SkillInfo = {
  name: string
  version: string
  description: string
  builtin: boolean
}

export type SkillFileItem = {
  path: string
  name: string
  type: 'file' | 'dir'
  size?: number
  children?: SkillFileItem[]
}

type SkillDocument = {
  name: string
  version: string
  description: string
  content: string
}

const BUILTIN_SKILLS = new Set(['ct-mcp-copilot', 'frontend-design'])
const DEFAULT_AGENT_ALL_SKILL_BUDGET = 30_000
const SKILL_DOCS_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_SKILL_PREVIEW_FILE_BYTES = 1024 * 1024
const MAX_SKILL_TREE_ENTRIES = 800
const DEFAULT_SELECTED_SKILL_BUDGET = 18_000
const MAX_SELECTED_SKILLS = 3

function parseSkillFrontmatter(content: string): { name: string; version: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const raw = match?.[1] ?? ''

  const values: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const matchLine = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!matchLine) {
      index += 1
      continue
    }

    const key = matchLine[1]
    const value = matchLine[2].trim()
    if (value === '>' || value === '|') {
      const blockLines: string[] = []
      index += 1
      while (index < lines.length && (/^\s+/.test(lines[index]) || lines[index].trim() === '')) {
        blockLines.push(lines[index].trim())
        index += 1
      }
      values[key] = value === '>' ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n').trim()
      continue
    }

    values[key] = value.replace(/^['"]|['"]$/g, '')
    index += 1
  }

  return {
    name: values.name || '',
    version: values.version || '0.0.0',
    description: values.description || '',
  }
}

function getSkillRoots(): string[] {
  return [
    join(process.resourcesPath, 'builtin-skills'),
    join(process.resourcesPath, 'app.asar'),
    join(process.resourcesPath, 'app.asar.unpacked'),
    join(app.getAppPath(), 'resources', 'builtin-skills'),
    join(process.cwd(), 'resources', 'builtin-skills'),
    app.getAppPath(),
    process.cwd(),
  ]
}

function resolveSkillDir(skillName: string): string | null {
  for (const root of getSkillRoots()) {
    const candidate = join(root, skillName)
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate
    const alt = join(root, 'skills', skillName)
    if (existsSync(join(alt, 'SKILL.md'))) return alt
  }
  return null
}

let _cacheBasePath: string | null = null

export function setUserSkillsCachePath(cacheBasePath: string): void {
  _cacheBasePath = cacheBasePath
}

function getUserSkillsDir(): string {
  const base = _cacheBasePath || join(app.getPath('userData'), 'CipherTalk')
  return join(base, 'skills')
}

function scanSkillDir(baseDir: string, builtin: boolean): SkillInfo[] {
  if (!existsSync(baseDir)) return []
  const results: SkillInfo[] = []
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMdPath = join(baseDir, entry.name, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    try {
      const content = readFileSync(skillMdPath, 'utf8')
      const meta = parseSkillFrontmatter(content)
      results.push({
        name: meta.name || entry.name,
        version: meta.version,
        description: meta.description,
        builtin,
      })
    } catch {
      results.push({ name: entry.name, version: '0.0.0', description: '', builtin })
    }
  }
  return results
}

function findSkillDirectoryRecursive(baseDir: string): string | null {
  if (!existsSync(baseDir)) return null
  if (existsSync(join(baseDir, 'SKILL.md'))) return baseDir
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const entryPath = join(baseDir, entry.name)
    if (!entry.isDirectory()) continue
    if (existsSync(join(entryPath, 'SKILL.md'))) return entryPath
    const nested = findSkillDirectoryRecursive(entryPath)
    if (nested) return nested
  }
  return null
}

function getSkillNameFromDir(dir: string): string {
  try {
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    return parseSkillFrontmatter(content).name || dir.split(/[\\/]/).pop() || 'skill'
  } catch {
    return dir.split(/[\\/]/).pop() || 'skill'
  }
}

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim()
}

function compactSkillContent(content: string, maxChars: number): string {
  const body = stripSkillFrontmatter(content)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 20)).trim()}\n...<truncated>` : body
}

function normalizeSkillSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeSkillQuery(value: string): string[] {
  const normalized = normalizeSkillSearchText(value)
  if (!normalized) return []
  const tokens = normalized.split(' ').filter(token => token.length >= 2)
  const cjkChars = Array.from(normalized.matchAll(/\p{Script=Han}/gu)).map(match => match[0])
  return Array.from(new Set([...tokens, ...cjkChars]))
}

function skillSearchHaystack(doc: SkillDocument): string {
  const headings = doc.content
    .split(/\r?\n/)
    .filter(line => /^#{1,3}\s+/.test(line))
    .join('\n')
  return normalizeSkillSearchText([
    doc.name,
    doc.version,
    doc.description,
    headings,
    doc.content.slice(0, 4000),
  ].join('\n'))
}

function scoreSkillForQuery(doc: SkillDocument, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const name = normalizeSkillSearchText(doc.name)
  const description = normalizeSkillSearchText(doc.description)
  const haystack = skillSearchHaystack(doc)
  let score = 0
  for (const token of queryTokens) {
    if (name.includes(token)) score += 8
    if (description.includes(token)) score += 5
    if (haystack.includes(token)) score += 1
  }
  return score
}

function packSkillDocuments(docs: SkillDocument[], totalBudget: number): AgentSkillContextItem[] {
  const safeBudget = Math.max(0, Math.floor(totalBudget))
  if (docs.length === 0 || safeBudget <= 0) return []
  let remaining = safeBudget
  return docs.map((doc, index) => {
    const remainingDocs = Math.max(1, docs.length - index)
    const perSkillBudget = Math.max(0, Math.floor(remaining / remainingDocs))
    const content = compactSkillContent(doc.content, perSkillBudget)
    remaining = Math.max(0, remaining - content.length)
    return {
      name: doc.name,
      version: doc.version,
      description: doc.description,
      content,
    }
  }).filter(skill => skill.content)
}

function sortSkillFileItems(items: SkillFileItem[]): SkillFileItem[] {
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192)
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

export class SkillManagerService {
  listSkills(): SkillInfo[] {
    const results: SkillInfo[] = []
    const seen = new Set<string>()

    for (const root of getSkillRoots()) {
      for (const skill of scanSkillDir(root, true)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name)
          results.push(skill)
        }
      }
      for (const skill of scanSkillDir(join(root, 'skills'), true)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name)
          results.push(skill)
        }
      }
    }

    for (const skill of scanSkillDir(getUserSkillsDir(), false)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        results.push(skill)
      }
    }

    return results
  }

  readSkillContent(skillName: string): { success: boolean; content?: string; error?: string } {
    const dir = resolveSkillDir(skillName) ?? this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }
    try {
      const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  listSkillFiles(skillName: string): { success: boolean; files?: SkillFileItem[]; truncated?: boolean; error?: string } {
    const dir = this.resolveAnySkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }

    let count = 0
    let truncated = false

    const readDirectory = (baseDir: string, basePath = ''): SkillFileItem[] => {
      if (truncated) return []
      const entries = readdirSync(baseDir, { withFileTypes: true })
      const items: SkillFileItem[] = []

      for (const entry of entries) {
        if (truncated) break
        count += 1
        if (count > MAX_SKILL_TREE_ENTRIES) {
          truncated = true
          break
        }

        const itemPath = basePath ? `${basePath}/${entry.name}` : entry.name
        const fullPath = join(baseDir, entry.name)
        if (entry.isDirectory()) {
          items.push({
            path: itemPath,
            name: entry.name,
            type: 'dir',
            children: readDirectory(fullPath, itemPath),
          })
          continue
        }
        if (!entry.isFile()) continue
        const stats = statSync(fullPath)
        items.push({
          path: itemPath,
          name: entry.name,
          type: 'file',
          size: stats.size,
        })
      }

      return sortSkillFileItems(items)
    }

    try {
      return { success: true, files: readDirectory(dir), truncated }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  readSkillFile(skillName: string, filePath: string): { success: boolean; path?: string; content?: string; size?: number; binary?: boolean; error?: string } {
    const dir = this.resolveAnySkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }

    const target = resolve(dir, filePath || 'SKILL.md')
    const safeRelativePath = relative(dir, target)
    if (!safeRelativePath || safeRelativePath.startsWith('..') || isAbsolute(safeRelativePath)) {
      return { success: false, error: '文件路径无效' }
    }

    try {
      const stats = statSync(target)
      if (!stats.isFile()) return { success: false, error: '只能预览文件' }
      if (stats.size > MAX_SKILL_PREVIEW_FILE_BYTES) {
        return { success: false, path: safeRelativePath, size: stats.size, error: '文件过大，无法预览' }
      }

      const buffer = readFileSync(target)
      if (isBinaryBuffer(buffer)) {
        return { success: false, path: safeRelativePath, size: stats.size, binary: true, error: '二进制文件无法预览' }
      }

      return {
        success: true,
        path: safeRelativePath,
        content: buffer.toString('utf8'),
        size: stats.size,
      }
    } catch (error) {
      return { success: false, path: basename(filePath), error: String(error) }
    }
  }

  updateSkillContent(skillName: string, content: string): { success: boolean; error?: string } {
    const dir = this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `User skill "${skillName}" not found. Only user-imported skills can be edited.` }
    try {
      writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  exportSkillZip(skillName: string): { success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string } {
    const sourcePath = resolveSkillDir(skillName) ?? this.resolveUserSkillDir(skillName)
    if (!sourcePath) return { success: false, error: `Skill "${skillName}" not found` }

    try {
      const content = readFileSync(join(sourcePath, 'SKILL.md'), 'utf8')
      const meta = parseSkillFrontmatter(content)
      const downloadsDir = app.getPath('downloads')
      const version = meta.version || '0.0.0'
      const fileName = `${skillName}-v${version}.zip`
      const outputPath = join(downloadsDir, fileName)
      const zip: AdmZipFull = new AdmZip() as AdmZipFull
      zip.addLocalFolder(sourcePath, skillName)
      zip.writeZip(outputPath)
      return { success: true, outputPath, fileName, version }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  importSkillZip(zipPath: string): { success: boolean; skillName?: string; error?: string } {
    let tempDir: string | null = null
    try {
      const zip: AdmZipFull = new AdmZip(zipPath) as AdmZipFull
      const entries = zip.getEntries()
      if (entries.length === 0) return { success: false, error: 'Zip file is empty' }

      if (!entries.some((e: { entryName: string }) => e.entryName.split('/').pop() === 'SKILL.md')) {
        return { success: false, error: 'No SKILL.md found in zip' }
      }

      const userSkillsDir = getUserSkillsDir()
      if (!existsSync(userSkillsDir)) {
        mkdirSync(userSkillsDir, { recursive: true })
      }

      tempDir = mkdtempSync(join(app.getPath('userData'), 'skill-import-'))
      zip.extractAllTo(tempDir, true)

      const extractedDir = findSkillDirectoryRecursive(tempDir)
      if (!extractedDir) {
        return { success: false, error: 'Skill extracted but SKILL.md not found' }
      }

      const skillName = getSkillNameFromDir(extractedDir)
      if (this.resolveUserSkillDir(skillName) || resolveSkillDir(skillName)) {
        return { success: false, error: `Skill "${skillName}" already exists` }
      }

      const destDir = join(userSkillsDir, skillName)
      if (existsSync(destDir)) {
        return { success: false, error: `Skill directory "${skillName}" already exists` }
      }

      renameSync(extractedDir, destDir)
      this.invalidateSkillCaches()
      return { success: true, skillName }
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  }

  deleteSkill(skillName: string): { success: boolean; error?: string } {
    if (BUILTIN_SKILLS.has(skillName)) {
      return { success: false, error: `Cannot delete builtin skill "${skillName}"` }
    }

    const dir = this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }

    try {
      rmSync(dir, { recursive: true, force: true })
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  createSkill(skillName: string, content: string): { success: boolean; error?: string } {
    const userSkillsDir = getUserSkillsDir()
    const destDir = join(userSkillsDir, skillName)

    if (existsSync(destDir)) {
      return { success: false, error: `Skill "${skillName}" already exists` }
    }

    try {
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, 'SKILL.md'), content, 'utf8')
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // 全量技能文档缓存：每条 Agent 消息都要读取技能上下文，同步重读全部 SKILL.md（含逐根目录 existsSync 探测）
  // 会堵事件循环几百毫秒。技能增删改时失效，TTL 兜底外部直接改文件的情况。
  private skillDocsCache: { value: SkillDocument[]; at: number } | null = null

  private invalidateSkillCaches(): void {
    this.skillDocsCache = null
  }

  private getSkillDocuments(): SkillDocument[] {
    const cached = this.skillDocsCache
    if (cached && Date.now() - cached.at < SKILL_DOCS_CACHE_TTL_MS) return cached.value
    const docs = this.listSkills()
      .map((skill) => {
        const loaded = this.readSkillContent(skill.name)
        if (!loaded.success || !loaded.content) return null
        const meta = parseSkillFrontmatter(loaded.content)
        return {
          name: meta.name || skill.name,
          version: meta.version || skill.version,
          description: meta.description || skill.description,
          content: loaded.content,
        }
      })
      .filter((item): item is SkillDocument => Boolean(item))
    this.skillDocsCache = { value: docs, at: Date.now() }
    return docs
  }

  getAllSkillsForAgentPrompt(totalBudget = DEFAULT_AGENT_ALL_SKILL_BUDGET): AgentSkillContextItem[] {
    const docs = this.getSkillDocuments()
    if (docs.length === 0) return []
    const full = packSkillDocuments(docs, Number.MAX_SAFE_INTEGER)
    const fullLength = full.reduce((sum, item) => sum + item.content.length, 0)
    const safeBudget = Math.max(0, Math.floor(totalBudget))
    if (fullLength <= safeBudget) return full

    return packSkillDocuments(docs, safeBudget)
  }

  selectSkillsForAgentPrompt(query: string, totalBudget = DEFAULT_SELECTED_SKILL_BUDGET): AgentSkillContextItem[] {
    const docs = this.getSkillDocuments()
    if (docs.length === 0) return []
    const tokens = tokenizeSkillQuery(query)
    if (tokens.length === 0) return []

    const selected = docs
      .map(doc => ({ doc, score: scoreSkillForQuery(doc, tokens) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
      .slice(0, MAX_SELECTED_SKILLS)
      .map(item => item.doc)

    return packSkillDocuments(selected, totalBudget)
  }

  private resolveUserSkillDir(skillName: string): string | null {
    const dir = join(getUserSkillsDir(), skillName)
    if (existsSync(join(dir, 'SKILL.md'))) return dir
    const userSkillsDir = getUserSkillsDir()
    if (!existsSync(userSkillsDir)) return null
    for (const entry of readdirSync(userSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(userSkillsDir, entry.name)
      if (!existsSync(join(candidate, 'SKILL.md'))) continue
      if (getSkillNameFromDir(candidate) === skillName) return candidate
    }
    return null
  }

  private resolveAnySkillDir(skillName: string): string | null {
    return resolveSkillDir(skillName) ?? this.resolveUserSkillDir(skillName)
  }
}

export const skillManagerService = new SkillManagerService()
