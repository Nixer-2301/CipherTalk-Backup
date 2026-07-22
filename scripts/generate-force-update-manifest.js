const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const pkg = require(path.join(rootDir, 'package.json'))

const parseList = (value) => {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const manifest = {
  schemaVersion: 1,
  latestVersion: pkg.version,
  minimumSupportedVersion: process.env.FORCE_UPDATE_MIN_VERSION || undefined,
  blockedVersions: parseList(process.env.FORCE_UPDATE_BLOCKED_VERSIONS),
  title: process.env.FORCE_UPDATE_TITLE || '',
  message: process.env.FORCE_UPDATE_MESSAGE || '',
  releaseNotes: process.env.FORCE_UPDATE_RELEASE_NOTES || '',
  publishedAt: new Date().toISOString()
}

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true })
}

const outputPath = path.join(releaseDir, 'force-update.json')
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`✅ force-update.json 已生成: ${outputPath}`)
