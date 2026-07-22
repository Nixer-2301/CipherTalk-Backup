import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'
import type { ConfigService } from './config'

/**
 * AI 宠物服务 —— 兼容 petdex 宠物包格式（同 Codex Pets）。
 * 宠物包 = pet.json + spritesheet.webp/png（8 列 × 9 行精灵图，每帧 192×208）。
 * 用户宠物存放在 cachePath/pets/<slug>/，内置宠物从应用资源目录只读加载。
 */

export interface InstalledPet {
  slug: string
  displayName: string
  description: string
  builtin?: boolean
}

export interface ManifestPet {
  slug: string
  displayName: string
  kind?: string
  submittedBy?: string
  spritesheetUrl: string
  petJsonUrl: string
}

const PETDEX_MANIFEST_URL = 'https://www.petdex.dev/api/manifest'
const BUILTIN_PET_SLUG = 'miyuji'
// 与 petdex CLI 一致：只信任官方资源域，防止 manifest 被塞入恶意 URL
const TRUSTED_ASSET_HOSTS = new Set(['assets.petdex.dev'])

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

let manifestCache: { pets: ManifestPet[]; fetchedAt: number } | null = null
const MANIFEST_TTL_MS = 10 * 60 * 1000

function petsDir(configService?: ConfigService | null): string {
  const cacheBasePath = configService?.getCacheBasePath() || path.join(app.getPath('userData'), 'CipherTalk')
  return path.join(cacheBasePath, 'pets')
}

function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug)
}

function isTrustedAssetUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && TRUSTED_ASSET_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function findSpriteFile(dir: string): string | null {
  for (const name of ['spritesheet.webp', 'spritesheet.png']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

function isBuiltinPetSlug(slug: string): boolean {
  return slug === BUILTIN_PET_SLUG
}

function getBuiltinPetDir(slug: string): string | null {
  if (!isBuiltinPetSlug(slug)) return null
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'builtin-pets', slug)]
    : [
      path.join(process.cwd(), 'public', slug),
      path.join(app.getAppPath(), 'public', slug),
    ]

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'pet.json')) && findSpriteFile(dir)) return dir
  }
  return null
}

export function hasBuiltinPet(slug = BUILTIN_PET_SLUG): boolean {
  return Boolean(getBuiltinPetDir(slug))
}

function readInstalledPet(petDir: string, slug: string, builtin = false): InstalledPet {
  let displayName = slug
  let description = ''
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8'))
    if (typeof meta?.displayName === 'string' && meta.displayName.trim()) displayName = meta.displayName.trim()
    if (typeof meta?.description === 'string') description = meta.description
  } catch {
    // pet.json 缺失或损坏时按目录名兜底，仍可展示
  }
  return { slug, displayName, description, ...(builtin ? { builtin: true } : {}) }
}

export function listInstalledPets(configService?: ConfigService | null): InstalledPet[] {
  const pets: InstalledPet[] = []
  const builtinDir = getBuiltinPetDir(BUILTIN_PET_SLUG)
  if (builtinDir) {
    pets.push(readInstalledPet(builtinDir, BUILTIN_PET_SLUG, true))
  }

  const dir = petsDir(configService)
  if (!fs.existsSync(dir)) return pets
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue
    if (isBuiltinPetSlug(entry.name)) continue
    const petDir = path.join(dir, entry.name)
    if (!findSpriteFile(petDir)) continue
    pets.push(readInstalledPet(petDir, entry.name))
  }
  return pets
}

export function getPetSpriteDataUrl(slug: string, configService?: ConfigService | null): string | null {
  if (!isValidSlug(slug)) return null
  const builtinDir = getBuiltinPetDir(slug)
  const file = builtinDir
    ? findSpriteFile(builtinDir)
    : findSpriteFile(path.join(petsDir(configService), slug))
  if (!file) return null
  return `local-image://${encodeURIComponent(file)}`
}

export async function fetchPetManifest(force = false): Promise<ManifestPet[]> {
  if (!force && manifestCache && Date.now() - manifestCache.fetchedAt < MANIFEST_TTL_MS) {
    return manifestCache.pets
  }
  const res = await fetch(PETDEX_MANIFEST_URL, { headers: { Referer: 'https://www.petdex.dev' } })
  if (!res.ok) throw new Error(`petdex manifest 请求失败：${res.status}`)
  const data = (await res.json()) as { pets?: ManifestPet[] }
  const pets = (data.pets ?? []).filter(
    (pet) => isValidSlug(pet.slug) && isTrustedAssetUrl(pet.spritesheetUrl) && isTrustedAssetUrl(pet.petJsonUrl)
  )
  manifestCache = { pets, fetchedAt: Date.now() }
  return pets
}

export async function installPet(slug: string, configService?: ConfigService | null): Promise<InstalledPet> {
  if (!isValidSlug(slug)) throw new Error('无效的宠物 slug')
  if (isBuiltinPetSlug(slug)) throw new Error('内置宠物不能被覆盖')
  const manifest = await fetchPetManifest()
  const pet = manifest.find((item) => item.slug === slug)
  if (!pet) throw new Error(`petdex 宠物库里找不到 ${slug}`)

  const download = async (url: string): Promise<Buffer> => {
    const res = await fetch(url, { headers: { Referer: 'https://www.petdex.dev' } })
    if (!res.ok) throw new Error(`下载失败 ${url} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const [petJson, spritesheet] = await Promise.all([
    download(pet.petJsonUrl),
    download(pet.spritesheetUrl),
  ])

  const dir = path.join(petsDir(configService), slug)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const ext = pet.spritesheetUrl.endsWith('.png') ? 'png' : 'webp'
  fs.writeFileSync(path.join(dir, 'pet.json'), petJson)
  fs.writeFileSync(path.join(dir, `spritesheet.${ext}`), spritesheet)

  let displayName = pet.displayName || slug
  let description = ''
  try {
    const meta = JSON.parse(petJson.toString('utf8'))
    if (typeof meta?.displayName === 'string' && meta.displayName.trim()) displayName = meta.displayName.trim()
    if (typeof meta?.description === 'string') description = meta.description
  } catch {
    // 元数据解析失败不阻塞安装
  }
  return { slug, displayName, description }
}

export function removePet(slug: string, configService?: ConfigService | null): void {
  if (!isValidSlug(slug)) throw new Error('无效的宠物 slug')
  if (isBuiltinPetSlug(slug)) throw new Error('内置宠物不能删除')
  const dir = path.join(petsDir(configService), slug)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

type ZipEntry = { entryName: string; isDirectory: boolean; getData(): Buffer }
type AdmZipReader = InstanceType<typeof AdmZip> & { getEntries(): ZipEntry[] }

/** 把任意字符串归一成合法 slug（pet.json 没有 id 时用文件名兜底） */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || `pet-${Date.now().toString(36)}`
}

/**
 * 从本地压缩包导入宠物（petdex 下载的 zip 或自制宠物包）。
 * 包内任意层级找 pet.json + spritesheet.webp/png，校验后落到 cachePath/pets/<slug>/。
 */
export function importPetZip(zipPath: string, configService?: ConfigService | null): InstalledPet {
  const zip = new AdmZip(zipPath) as AdmZipReader
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  if (entries.length === 0) throw new Error('压缩包是空的')

  const baseName = (entry: ZipEntry) => entry.entryName.split('/').pop() ?? ''
  const petJsonEntry = entries.find((entry) => baseName(entry) === 'pet.json')
  const spriteEntry = entries.find((entry) => {
    const name = baseName(entry).toLowerCase()
    return name === 'spritesheet.webp' || name === 'spritesheet.png' || name === 'sprite.webp' || name === 'sprite.png'
  })
  if (!petJsonEntry) throw new Error('压缩包里找不到 pet.json')
  if (!spriteEntry) throw new Error('压缩包里找不到精灵图（spritesheet.webp/png）')

  const petJson = petJsonEntry.getData()
  const spritesheet = spriteEntry.getData()
  if (spritesheet.length === 0) throw new Error('精灵图是空文件')

  let meta: { id?: unknown; displayName?: unknown; description?: unknown }
  try {
    meta = JSON.parse(petJson.toString('utf8'))
  } catch {
    throw new Error('pet.json 不是合法的 JSON')
  }

  const rawId = typeof meta.id === 'string' && meta.id.trim() ? meta.id.trim() : path.basename(zipPath, '.zip')
  const slug = isValidSlug(rawId) ? rawId : slugify(rawId)
  if (isBuiltinPetSlug(slug)) throw new Error('内置宠物不能被覆盖')
  const ext = baseName(spriteEntry).toLowerCase().endsWith('.png') ? 'png' : 'webp'

  const dir = path.join(petsDir(configService), slug)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pet.json'), petJson)
  fs.writeFileSync(path.join(dir, `spritesheet.${ext}`), spritesheet)

  return {
    slug,
    displayName: typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : slug,
    description: typeof meta.description === 'string' ? meta.description : '',
  }
}
