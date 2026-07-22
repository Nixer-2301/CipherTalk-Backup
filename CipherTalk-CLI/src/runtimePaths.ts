import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function getConfigHome(): string {
  return process.env.MIYU_HOME || join(homedir(), '.miyu')
}

export function getUserDataPath(): string {
  return getConfigHome()
}

export function getTempPath(): string {
  return tmpdir()
}

export function getNativeRoot(): string {
  if (process.env.MIYU_NATIVE_ROOT) return resolve(process.env.MIYU_NATIVE_ROOT)

  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '..', 'native'),
    resolve(here, '..', '..', 'native'),
    resolve(process.cwd(), 'native')
  ]

  return candidates.find((candidate) => existsSync(candidate)) || candidates[1]
}

export function getPlatformNativeDir(): string {
  const platformKey = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}`
  return join(getNativeRoot(), platformKey)
}

export function getCacheDir(): string {
  return process.env.MIYU_CACHE_DIR || join(getConfigHome(), 'cache')
}

export function inferWxid(inputPath?: string): string | undefined {
  if (!inputPath) return undefined
  const normalized = inputPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.find((part) => /^wxid_/i.test(part))
}
