/**
 * PluginManagerService —— 插件系统核心（见 PLUGIN_SYSTEM_PLAN.md）。
 *
 * 职责：
 * - 扫描 <userData>/plugins 与开发者模式登记的本地目录，解析并校验 manifest.json
 * - 持久化启用状态与已授予权限（plugins-state.json）
 * - 为 ct-plugin:// 协议提供资源路径解析（含路径穿越防护）
 *
 * 插件代码不在主进程执行；本服务只处理元数据与文件路径。
 */
import AdmZip from 'adm-zip'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { getUserDataPath } from './runtimePaths'

export type PluginPermission =
  | 'sessions:read'
  | 'contacts:read'
  | 'messages:read'
  | 'clipboard:write'
  | 'media:read'
  | 'stt:use'
  | 'search:use'
  | 'stats:read'
  | 'export:use'
  | 'notify:send'
  | 'window:create'
  | 'sns:read'
  | 'ai:use'
  | 'network'

/** 宿主认识的全部权限名（manifest 出现未知权限视为校验失败，防拼写错误静默失效） */
const KNOWN_PERMISSIONS = new Set<PluginPermission>([
  'sessions:read', 'contacts:read', 'messages:read', 'clipboard:write',
  'media:read', 'stt:use', 'search:use', 'stats:read', 'export:use',
  'notify:send', 'window:create', 'sns:read', 'ai:use', 'network',
])

export const PLUGIN_API_VERSION = 1

export interface PluginViewDef {
  entry: string
  presentation?: 'page' | 'drawer'
}

export interface PluginSidebarMenu { id: string; label: string; icon?: string; view: string }
export interface PluginSettingsTab { id: string; label: string; view: string }
export interface PluginChatToolbarButton { id: string; label: string; icon?: string; view: string }

export interface PluginAuthor {
  /** 开发者名称（必填） */
  name: string
  /** 联系邮箱（选填，格式校验） */
  email?: string
  /** 主页/仓库地址（选填，须为 http(s)） */
  url?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  apiVersion: number
  author: PluginAuthor
  permissions?: PluginPermission[]
  contributes?: {
    sidebarMenus?: PluginSidebarMenu[]
    settingsTabs?: PluginSettingsTab[]
    chatToolbarButtons?: PluginChatToolbarButton[]
    views?: Record<string, PluginViewDef>
  }
  /** 仅开发者模式 + 本地插件时生效，正式安装的插件忽略 */
  devServer?: string
}

export interface InstalledPlugin {
  manifest: PluginManifest
  dir: string
  isDev: boolean
  enabled: boolean
  grantedPermissions: PluginPermission[]
  /** manifest 校验失败原因；有值时插件不可启用 */
  error?: string
}

interface PluginState {
  enabled: Record<string, boolean>
  granted: Record<string, PluginPermission[]>
  devDirs: string[]
  devModeEnabled: boolean
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/

function validateManifest(raw: unknown): { manifest?: PluginManifest; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'manifest.json 不是对象' }
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !PLUGIN_ID_RE.test(m.id)) {
    return { error: 'id 缺失或不合法（小写字母/数字/点/连字符，2-64 位）' }
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return { error: 'name 缺失' }
  if (typeof m.version !== 'string' || !m.version.trim()) return { error: 'version 缺失' }
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return { error: `apiVersion 不兼容（插件 ${String(m.apiVersion)}，宿主 ${PLUGIN_API_VERSION}）` }
  }

  // 开发者身份标识：author.name 必填；email / url 选填但校验格式
  const author = m.author as PluginAuthor | undefined
  if (!author || typeof author !== 'object' || typeof author.name !== 'string' || !author.name.trim()) {
    return { error: 'author.name（开发者名称）必填' }
  }
  if (author.name.trim().length > 64) return { error: 'author.name 过长（最多 64 字符）' }
  if (author.email !== undefined) {
    if (typeof author.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email)) {
      return { error: 'author.email 格式不合法' }
    }
  }
  if (author.url !== undefined) {
    if (typeof author.url !== 'string' || !/^https?:\/\//.test(author.url)) {
      return { error: 'author.url 须为 http(s) 地址' }
    }
  }

  const permissions = (m.permissions ?? []) as unknown
  if (!Array.isArray(permissions)) return { error: 'permissions 必须是数组' }
  const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.has(p as PluginPermission))
  if (unknown.length > 0) return { error: `包含宿主不支持的权限：${unknown.join(', ')}` }

  const contributes = (m.contributes ?? {}) as PluginManifest['contributes']
  const views = contributes?.views ?? {}
  for (const [key, view] of Object.entries(views)) {
    if (!view || typeof view.entry !== 'string') return { error: `views.${key} 缺少 entry` }
    const entry = view.entry.replace(/\\/g, '/')
    if (path.isAbsolute(entry) || entry.split('/').includes('..')) {
      return { error: `views.${key}.entry 必须是插件目录内的相对路径` }
    }
  }
  const refs: { kind: string; view: string }[] = []
  for (const item of contributes?.sidebarMenus ?? []) refs.push({ kind: 'sidebarMenus', view: item.view })
  for (const item of contributes?.settingsTabs ?? []) refs.push({ kind: 'settingsTabs', view: item.view })
  for (const item of contributes?.chatToolbarButtons ?? []) refs.push({ kind: 'chatToolbarButtons', view: item.view })
  for (const ref of refs) {
    if (!views[ref.view]) return { error: `${ref.kind} 引用了不存在的视图 "${ref.view}"` }
  }

  return { manifest: m as unknown as PluginManifest }
}

export class PluginManagerService extends EventEmitter {
  private plugins = new Map<string, InstalledPlugin>()
  private state: PluginState = { enabled: {}, granted: {}, devDirs: [], devModeEnabled: false }
  private initialized = false

  getPluginsRoot(): string {
    return path.join(getUserDataPath(), 'plugins')
  }

  getPluginDataRoot(): string {
    return path.join(getUserDataPath(), 'plugin-data')
  }

  private getStateFile(): string {
    return path.join(this.getPluginsRoot(), 'plugins-state.json')
  }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    fs.mkdirSync(this.getPluginsRoot(), { recursive: true })
    this.loadState()
    this.rescan()
  }

  private loadState(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.getStateFile(), 'utf-8')) as Partial<PluginState>
      this.state = {
        enabled: raw.enabled ?? {},
        granted: raw.granted ?? {},
        devDirs: Array.isArray(raw.devDirs) ? raw.devDirs : [],
        devModeEnabled: !!raw.devModeEnabled,
      }
    } catch {
      // 首次运行或文件损坏：使用默认空状态
    }
  }

  private saveState(): void {
    const file = this.getStateFile()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  }

  /** 重新扫描安装目录与开发者目录，全量重建插件表 */
  rescan(): void {
    this.plugins.clear()

    const root = this.getPluginsRoot()
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      this.loadPluginDir(path.join(root, entry.name), false, entry.name)
    }

    for (const devDir of this.state.devDirs) {
      this.loadPluginDir(devDir, true)
    }

    this.emit('changed')
  }

  private loadPluginDir(dir: string, isDev: boolean, expectedDirName?: string): void {
    const manifestPath = path.join(dir, 'manifest.json')
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (e) {
      // 无 manifest 的目录直接忽略（可能是残留文件）；解析失败的记录错误便于排查
      if (fs.existsSync(manifestPath)) {
        const id = expectedDirName ?? path.basename(dir)
        this.plugins.set(id, {
          manifest: { id, name: id, version: '0.0.0', apiVersion: PLUGIN_API_VERSION, author: { name: '未知' } },
          dir, isDev, enabled: false, grantedPermissions: [],
          error: `manifest.json 解析失败：${String(e)}`,
        })
      }
      return
    }

    const { manifest, error } = validateManifest(raw)
    if (!manifest) {
      const id = expectedDirName ?? path.basename(dir)
      this.plugins.set(id, {
        manifest: { id, name: id, version: '0.0.0', apiVersion: PLUGIN_API_VERSION, author: { name: '未知' } },
        dir, isDev, enabled: false, grantedPermissions: [],
        error,
      })
      return
    }

    // 正式安装的插件要求目录名与 id 一致，防止同 id 多目录互相覆盖
    if (!isDev && expectedDirName && expectedDirName !== manifest.id) {
      this.plugins.set(manifest.id, {
        manifest, dir, isDev, enabled: false, grantedPermissions: [],
        error: `目录名 "${expectedDirName}" 与 manifest.id "${manifest.id}" 不一致`,
      })
      return
    }
    // 开发者目录与正式安装同 id 时，开发者目录优先（便于本地调试已发布插件）
    if (this.plugins.has(manifest.id) && !isDev) return

    this.plugins.set(manifest.id, {
      manifest,
      dir,
      isDev,
      enabled: !!this.state.enabled[manifest.id],
      grantedPermissions: this.state.granted[manifest.id] ?? [],
    })
  }

  list(): InstalledPlugin[] {
    return Array.from(this.plugins.values())
  }

  get(id: string): InstalledPlugin | undefined {
    return this.plugins.get(id)
  }

  isEnabled(id: string): boolean {
    return !!this.plugins.get(id)?.enabled
  }

  hasPermission(id: string, permission: PluginPermission): boolean {
    const plugin = this.plugins.get(id)
    if (!plugin || !plugin.enabled) return false
    return plugin.grantedPermissions.includes(permission)
  }

  /** 启用插件并授予其 manifest 声明的全部权限（授予动作由用户在 UI 确认后触发） */
  enable(id: string): { success: boolean; error?: string } {
    const plugin = this.plugins.get(id)
    if (!plugin) return { success: false, error: '插件不存在' }
    if (plugin.error) return { success: false, error: `插件不可启用：${plugin.error}` }

    const granted = [...(plugin.manifest.permissions ?? [])]
    plugin.enabled = true
    plugin.grantedPermissions = granted
    this.state.enabled[id] = true
    this.state.granted[id] = granted
    this.saveState()
    this.emit('changed')
    return { success: true }
  }

  disable(id: string): { success: boolean; error?: string } {
    const plugin = this.plugins.get(id)
    if (!plugin) return { success: false, error: '插件不存在' }
    plugin.enabled = false
    this.state.enabled[id] = false
    this.saveState()
    this.emit('changed')
    return { success: true }
  }

  /** 卸载：删插件目录 + 权限状态 + 私有数据。开发者插件仅移除登记，不删源码目录。 */
  uninstall(id: string): { success: boolean; error?: string } {
    const plugin = this.plugins.get(id)
    if (!plugin) return { success: false, error: '插件不存在' }

    if (plugin.isDev) {
      this.state.devDirs = this.state.devDirs.filter((d) => d !== plugin.dir)
    } else {
      // 只删除位于插件根目录内的目录，绝不跟随其它路径
      const resolved = path.resolve(plugin.dir)
      if (!resolved.startsWith(path.resolve(this.getPluginsRoot()) + path.sep)) {
        return { success: false, error: '插件目录异常，拒绝删除' }
      }
      fs.rmSync(resolved, { recursive: true, force: true })
    }

    const dataDir = path.join(this.getPluginDataRoot(), id)
    fs.rmSync(dataDir, { recursive: true, force: true })

    delete this.state.enabled[id]
    delete this.state.granted[id]
    this.saveState()
    this.plugins.delete(id)
    this.emit('changed')
    return { success: true }
  }

  getDevModeEnabled(): boolean {
    return this.state.devModeEnabled
  }

  setDevModeEnabled(enabled: boolean): void {
    this.state.devModeEnabled = enabled
    this.saveState()
    this.rescan()
  }

  /**
   * 从 .ctplugin（zip）安装插件：校验 manifest → 解压到插件目录。
   * - 防 zip-slip：拒绝含 .. / 绝对路径的条目
   * - 兼容"单层根目录包裹"的打包习惯（自动剥离前缀）
   * - 覆盖安装已启用插件时，若权限声明有新增则自动禁用，用户须重新确认授权
   */
  installFromZip(zipPath: string): { success: boolean; pluginId?: string; name?: string; error?: string } {
    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch (e) {
      return { success: false, error: `无法读取插件包:${String(e)}` }
    }

    const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
    if (entries.length === 0) return { success: false, error: '插件包为空' }

    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/')
      if (path.isAbsolute(name) || name.split('/').includes('..')) {
        return { success: false, error: `插件包含非法路径:${entry.entryName}` }
      }
    }

    // manifest.json 在根，或所有文件都在同一个顶层目录里（剥掉这层前缀）
    let prefix = ''
    if (!entries.some((entry) => entry.entryName.replace(/\\/g, '/') === 'manifest.json')) {
      const tops = new Set(entries.map((entry) => entry.entryName.replace(/\\/g, '/').split('/')[0]))
      const top = tops.size === 1 ? [...tops][0] : null
      if (!top || !entries.some((entry) => entry.entryName.replace(/\\/g, '/') === `${top}/manifest.json`)) {
        return { success: false, error: '插件包根目录缺少 manifest.json' }
      }
      prefix = `${top}/`
    }

    let raw: unknown
    try {
      raw = JSON.parse(zip.readAsText(`${prefix}manifest.json`))
    } catch (e) {
      return { success: false, error: `manifest.json 解析失败:${String(e)}` }
    }
    const { manifest, error } = validateManifest(raw)
    if (!manifest) return { success: false, error }

    const targetDir = path.join(this.getPluginsRoot(), manifest.id)
    const existing = this.plugins.get(manifest.id)
    if (existing?.isDev) {
      return { success: false, error: `同 id 插件正以开发者模式加载（${existing.dir}），请先移除` }
    }

    // 覆盖安装：清空旧目录；若声明的权限超出已授予集合，禁用待用户重新确认
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.mkdirSync(targetDir, { recursive: true })
    for (const entry of entries) {
      const rel = entry.entryName.replace(/\\/g, '/').slice(prefix.length)
      if (!rel) continue
      const dest = path.join(targetDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, entry.getData())
    }

    const granted = this.state.granted[manifest.id]
    if (granted && (manifest.permissions ?? []).some((p) => !granted.includes(p))) {
      this.state.enabled[manifest.id] = false
      this.saveState()
    }

    this.rescan()
    return { success: true, pluginId: manifest.id, name: manifest.name }
  }

  addDevPlugin(dir: string): { success: boolean; error?: string } {
    if (!this.state.devModeEnabled) return { success: false, error: '请先开启插件开发者模式' }
    const resolved = path.resolve(dir)
    if (!fs.existsSync(path.join(resolved, 'manifest.json'))) {
      return { success: false, error: '该目录下没有 manifest.json' }
    }
    if (!this.state.devDirs.includes(resolved)) {
      this.state.devDirs.push(resolved)
      this.saveState()
    }
    this.rescan()
    return { success: true }
  }

  /**
   * ct-plugin:// 资源解析：返回插件目录内的绝对路径。
   * 未启用的插件、越界路径一律返回 null。
   */
  resolveResource(pluginId: string, urlPath: string): string | null {
    const plugin = this.plugins.get(pluginId)
    if (!plugin || !plugin.enabled || plugin.error) return null

    const cleaned = decodeURIComponent(urlPath).replace(/\\/g, '/').replace(/^\/+/, '')
    const base = path.resolve(plugin.dir)
    const resolved = path.resolve(base, cleaned)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
    return resolved
  }

  /** 插件视图的加载 URL；开发者模式下有 devServer 的本地插件直接走 dev server（HMR） */
  getViewUrl(pluginId: string, viewId: string): string | null {
    const plugin = this.plugins.get(pluginId)
    if (!plugin || !plugin.enabled || plugin.error) return null
    const view = plugin.manifest.contributes?.views?.[viewId]
    if (!view) return null

    if (plugin.isDev && this.state.devModeEnabled && plugin.manifest.devServer) {
      const devBase = plugin.manifest.devServer.replace(/\/+$/, '')
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(devBase)) {
        return `${devBase}/${view.entry.replace(/\\/g, '/')}`
      }
    }
    return `ct-plugin://${pluginId}/${view.entry.replace(/\\/g, '/')}`
  }

  /** 插件私有 KV 存储文件路径（由 RPC 层读写） */
  getStorageFile(pluginId: string): string {
    const dir = path.join(this.getPluginDataRoot(), pluginId)
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'storage.json')
  }
}

export const pluginManagerService = new PluginManagerService()
