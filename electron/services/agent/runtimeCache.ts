import type { AgentMcpToolDescriptor, AgentScope, AgentSkillContextItem } from './types'

const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry<T> = {
  value: T
  expiresAt: number
}

const startupMemoryCache = new Map<string, CacheEntry<string>>()
const startupMemoryWarmups = new Map<string, Promise<void>>()
const skillSelectionCache = new Map<string, CacheEntry<AgentSkillContextItem[]>>()
const mcpSelectionCache = new Map<string, CacheEntry<AgentMcpToolDescriptor[]>>()
const mcpToolDescriptorCache = new Map<string, CacheEntry<AgentMcpToolDescriptor[]>>()
let memoryCacheEpoch = 0

function now(): number {
  return Date.now()
}

function getEntry<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function setEntry<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS })
}

function normalizeQuery(query: string): string {
  return String(query || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 800)
}

function scopeKey(scope?: AgentScope): string {
  if (!scope || scope.kind === 'global') return 'global'
  return `${scope.kind}:${scope.sessionId}`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)]),
  )
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(stableValue(value))
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

export function getCachedStartupMemory(scope: AgentScope): string | null {
  return getEntry(startupMemoryCache, scopeKey(scope))
}

export function setCachedStartupMemory(scope: AgentScope, content: string): void {
  setEntry(startupMemoryCache, scopeKey(scope), content || '')
}

export function warmStartupMemory(scope: AgentScope, loader: () => Promise<string>): void {
  const key = scopeKey(scope)
  if (startupMemoryWarmups.has(key)) return
  const epoch = memoryCacheEpoch
  // buildMemoryContext does synchronous DB/Markdown reads before resolving; defer it away from the first-token path.
  const task = new Promise<void>((resolve) => {
    setTimeout(resolve, 5_000)
  })
    .then(loader)
    .then((content) => {
      if (epoch === memoryCacheEpoch) setEntry(startupMemoryCache, key, content || '')
    })
    .catch(() => {})
    .finally(() => { startupMemoryWarmups.delete(key) })
  startupMemoryWarmups.set(key, task)
}

export function invalidateMemoryCache(scope?: AgentScope): void {
  memoryCacheEpoch += 1
  if (!scope) {
    startupMemoryCache.clear()
    startupMemoryWarmups.clear()
    return
  }
  startupMemoryCache.delete(scopeKey(scope))
  startupMemoryWarmups.delete(scopeKey(scope))
  startupMemoryCache.delete('global')
  startupMemoryWarmups.delete('global')
}

function selectionKey(query: string, version: string): string {
  return `${version}:${normalizeQuery(query)}`
}

export function getCachedSkillSelection(query: string, version: string): AgentSkillContextItem[] | null {
  return getEntry(skillSelectionCache, selectionKey(query, version))
}

export function setCachedSkillSelection(query: string, version: string, skills: AgentSkillContextItem[]): void {
  setEntry(skillSelectionCache, selectionKey(query, version), skills)
}

export function invalidateSkillSelectionCache(): void {
  skillSelectionCache.clear()
}

export function getCachedMcpSelection(query: string, version: string): AgentMcpToolDescriptor[] | null {
  return getEntry(mcpSelectionCache, selectionKey(query, version))
}

export function setCachedMcpSelection(query: string, version: string, tools: AgentMcpToolDescriptor[]): void {
  setEntry(mcpSelectionCache, selectionKey(query, version), tools)
}

export function invalidateMcpToolCache(): void {
  mcpSelectionCache.clear()
  mcpToolDescriptorCache.clear()
}

export function getCachedMcpToolDescriptors(version: string): AgentMcpToolDescriptor[] | null {
  return getEntry(mcpToolDescriptorCache, version)
}

export function setCachedMcpToolDescriptors(version: string, tools: AgentMcpToolDescriptor[]): void {
  setEntry(mcpToolDescriptorCache, version, tools)
}

export function fingerprintSkills(skills: Array<{ name: string; version: string; description?: string; builtin?: boolean }>): string {
  return stableHash(skills
    .map((skill) => ({
      name: skill.name,
      version: skill.version,
      description: skill.description || '',
      builtin: skill.builtin === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)))
}

export function fingerprintMcpToolSchemas(servers: unknown): string {
  return stableHash(servers)
}
