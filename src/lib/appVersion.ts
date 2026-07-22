/**
 * 内部构建版本 → 软件内展示版本。
 *
 * 内部版本（package.json / 更新源）形如 `2026.721.0`：
 * 年.月日.当日构建序号，月日段不带前导零（semver 不允许前导零，
 * 带零会让 electron-updater 启动即抛错）。
 * 展示为 `v2026.7.21-构建版本号v0`。
 *
 * 旧格式（如 2026.7.20）或无法识别的版本，原样加 v 前缀返回。
 */
export function formatDisplayVersion(version?: string | null): string {
  const raw = String(version ?? '').trim().replace(/^v/i, '')
  if (!raw) return ''
  const match = raw.match(/^(\d{4})\.(\d{3,4})\.(\d+)$/)
  if (!match) return `v${raw}`
  const mmdd = Number(match[2])
  const month = Math.floor(mmdd / 100)
  const day = mmdd % 100
  if (month < 1 || month > 12 || day < 1 || day > 31) return `v${raw}`
  return `v${match[1]}.${month}.${day}-构建版本号v${match[3]}`
}
