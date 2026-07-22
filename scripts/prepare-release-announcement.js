const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const tempDir = path.join(rootDir, '.tmp')
const bodyPath = path.join(releaseDir, 'release-body.md')
const forceUpdatePath = path.join(releaseDir, 'force-update.json')
const outputPath = path.join(tempDir, 'release-announcement.json')
const packageJsonPath = path.join(rootDir, 'package.json')

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.warn(`[ReleaseAnnouncement] 读取 JSON 失败: ${filePath}`, String(error))
    return null
  }
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return ''
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch (error) {
    console.warn(`[ReleaseAnnouncement] 读取文本失败: ${filePath}`, String(error))
    return ''
  }
}

function buildFallbackBody(version, releaseNotes) {
  const normalizedNotes = String(releaseNotes || '').trim()
  const overview = normalizedNotes
    ? normalizedNotes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.startsWith('-') || line.startsWith('*') ? line : `- ${line}`))
        .join('\n')
    : '- 本次版本已完成发布，详细内容将在后续发布说明中补充。'

  return [
    `## CipherTalk v${version}`,
    '',
    '### 概览',
    overview,
    '',
    '### 感谢贡献者',
    '- 感谢每一位使用与反馈的用户',
    '',
    '### 相关提交与 PR',
    '- 详见本次发布记录',
    ''
  ].join('\n')
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const version = String(pkg.version || '').trim()
  if (!version) {
    throw new Error('package.json 中未找到 version')
  }

  const releaseBody = readTextIfExists(bodyPath)
  const forceUpdate = readJsonIfExists(forceUpdatePath) || {}
  const releaseNotes = String(forceUpdate.releaseNotes || '').trim()

  const payload = {
    version,
    releaseBody: releaseBody || buildFallbackBody(version, releaseNotes),
    releaseNotes: releaseNotes || releaseBody || '',
    generatedAt: new Date().toISOString()
  }

  fs.mkdirSync(tempDir, { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`[ReleaseAnnouncement] 已生成 ${outputPath}`)
}

main()
