const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'ILoveBingLu'
const repo = (process.env.GITHUB_REPOSITORY || `${owner}/CipherTalk`).split('/')[1] || 'CipherTalk'
const currentTag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || ''
const pkg = require(path.join(rootDir, 'package.json'))

function parseEnvText(content) {
  const result = {}
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadLocalSecretEnv() {
  const candidates = [
    path.join(rootDir, '.release.local.env'),
    path.join(rootDir, '.env.local')
  ]
  const merged = {}
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    try {
      const parsed = parseEnvText(fs.readFileSync(filePath, 'utf8'))
      Object.assign(merged, parsed)
      console.log(`[ReleaseContext] Loaded local env file: ${path.basename(filePath)}`)
    } catch (e) {
      console.warn(`[ReleaseContext] Failed to read local env file: ${filePath}`, String(e))
    }
  }
  return merged
}

const localSecrets = loadLocalSecretEnv()
const ghToken = process.env.GH_TOKEN || localSecrets.GH_TOKEN || ''

function runGit(command) {
  return execSync(command, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function getPreviousTag() {
  const tags = runGit('git tag --sort=-version:refname')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!currentTag) return tags[0] || null

  const currentIndex = tags.indexOf(currentTag)
  if (currentIndex === -1) return tags[0] || null
  return tags[currentIndex + 1] || null
}

function getCommitRange(previousTag, tag) {
  if (!tag) return 'HEAD'
  // 如果上一标签拿不到（例如 checkout 浅克隆/无 tags），则退化成取 tag 前最近 50 次提交，
  // 避免 release-context 里 commits/pullRequests 为空，导致后续 AI 发布说明内容很少。
  if (!previousTag) return `${tag}~50..${tag}`
  if (previousTag === tag) return tag
  return `${previousTag}..${tag}`
}

function extractPrNumbers(commits) {
  const prNumbers = new Set()
  for (const commit of commits) {
    const matches = commit.subject.match(/#(\d+)/g)
    if (!matches) continue
    for (const match of matches) {
      prNumbers.add(Number(match.slice(1)))
    }
  }
  return Array.from(prNumbers)
}

async function fetchPullRequest(prNumber) {
  if (!ghToken) return null

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ghToken}`,
      'User-Agent': 'CipherTalk-Release-Context'
    }
  })

  if (!response.ok) return null
  const data = await response.json()
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    authorLogin: data.user?.login || null,
    authorName: data.user?.login || null,
    mergedBy: data.merged_by?.login || null
  }
}

async function main() {
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true })
  }

  const previousTag = getPreviousTag()
  const commitRange = getCommitRange(previousTag, currentTag || 'HEAD')
  console.log(`[ReleaseContext] tag=${currentTag || `v${pkg.version}`}`)
  console.log(`[ReleaseContext] previousTag=${previousTag || 'none'}`)
  console.log(`[ReleaseContext] commitRange=${commitRange}`)
  console.log(`[ReleaseContext] ghTokenConfigured=${Boolean(ghToken)}`)

  const commitLines = runGit(`git log ${commitRange} --pretty=format:"%H|%h|%an|%ae|%s"`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const commits = commitLines.map((line) => {
    const [sha, shortSha, authorName, authorEmail, ...subjectParts] = line.split('|')
    return {
      sha,
      shortSha,
      url: `https://github.com/${owner}/${repo}/commit/${sha}`,
      authorName,
      authorEmail,
      subject: subjectParts.join('|')
    }
  })

  const prNumbers = extractPrNumbers(commits)
  const prs = []
  for (const prNumber of prNumbers) {
    const pr = await fetchPullRequest(prNumber)
    if (pr) prs.push(pr)
  }
  console.log(`[ReleaseContext] commits=${commits.length}`)
  console.log(`[ReleaseContext] detectedPrNumbers=${prNumbers.length}`)
  console.log(`[ReleaseContext] fetchedPullRequests=${prs.length}`)

  const context = {
    version: pkg.version,
    tag: currentTag || `v${pkg.version}`,
    previousTag,
    generatedAt: new Date().toISOString(),
    repository: {
      owner,
      repo
    },
    forceUpdate: {
      minimumSupportedVersion: process.env.FORCE_UPDATE_MIN_VERSION || null,
      blockedVersions: parseList(process.env.FORCE_UPDATE_BLOCKED_VERSIONS)
    },
    commits,
    pullRequests: prs
  }

  const outputPath = path.join(releaseDir, 'release-context.json')
  fs.writeFileSync(outputPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8')
  console.log(`✅ release-context.json 已生成: ${outputPath}`)
}

main().catch((error) => {
  console.error('❌ 生成 release-context.json 失败:', error)
  process.exit(1)
})
