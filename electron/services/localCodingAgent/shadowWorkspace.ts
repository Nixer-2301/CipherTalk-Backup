import fs from 'fs'
import path from 'path'

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.next',
  '.nuxt',
])

const SKIP_EXTS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
])

const MAX_COPY_FILE_BYTES = 20 * 1024 * 1024

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isPathInside(root: string, target: string): boolean {
  const rootKey = normalizePathKey(root)
  const targetKey = normalizePathKey(target)
  return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`)
}

function shouldSkip(relativePath: string, direntName: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const base = path.basename(direntName).toLowerCase()
  if (!normalized) return false
  if (base === '.env' || base.startsWith('.env.')) return true
  if (SKIP_EXTS.has(path.extname(base))) return true
  return normalized.split('/').some((part) => SKIP_DIRS.has(part))
}

export async function copyWorkspaceFiltered(sourceRoot: string, targetRoot: string): Promise<void> {
  const realSource = await fs.promises.realpath(sourceRoot)
  await fs.promises.mkdir(targetRoot, { recursive: true })

  async function copyDir(sourceDir: string, targetDir: string, relativeDir: string): Promise<void> {
    await fs.promises.mkdir(targetDir, { recursive: true })
    const dirents = await fs.promises.readdir(sourceDir, { withFileTypes: true })
    for (const dirent of dirents) {
      const relativePath = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name
      if (shouldSkip(relativePath, dirent.name)) continue

      const sourcePath = path.join(sourceDir, dirent.name)
      const targetPath = path.join(targetDir, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        await copyDir(sourcePath, targetPath, relativePath)
        continue
      }
      if (!dirent.isFile()) continue
      const stat = await fs.promises.stat(sourcePath).catch(() => null)
      if (!stat || stat.size > MAX_COPY_FILE_BYTES) continue
      const realFile = await fs.promises.realpath(sourcePath).catch(() => sourcePath)
      if (!isPathInside(realSource, realFile)) continue
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.promises.copyFile(sourcePath, targetPath)
    }
  }

  await copyDir(realSource, targetRoot, '')
}

export function extractChangedPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (match) {
      paths.add(match[2])
      continue
    }
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileMatch && fileMatch[1] !== '/dev/null') paths.add(fileMatch[1])
  }
  return Array.from(paths)
}

export function validatePatchPaths(root: string, changedPaths: string[]): void {
  for (const changedPath of changedPaths) {
    if (!changedPath || path.isAbsolute(changedPath)) throw new Error(`补丁路径非法：${changedPath}`)
    const normalized = changedPath.replace(/\\/g, '/')
    if (normalized.split('/').some((part) => part === '..')) throw new Error(`补丁路径越界：${changedPath}`)
    const target = path.resolve(root, changedPath)
    if (!isPathInside(root, target)) throw new Error(`补丁路径越过工作区：${changedPath}`)
  }
}

