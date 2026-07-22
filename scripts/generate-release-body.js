const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const contextPath = path.join(releaseDir, 'release-context.json')
const outputPath = path.join(releaseDir, 'release-body.md')

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
      console.log(`[ReleaseBody] Loaded local env file: ${path.basename(filePath)}`)
    } catch (e) {
      console.warn(`[ReleaseBody] Failed to read local env file: ${filePath}`, String(e))
    }
  }
  return merged
}

const localSecrets = loadLocalSecretEnv()
const aiApiKey = process.env.AI_API_KEY || localSecrets.AI_API_KEY || ''
const aiApiUrl = process.env.AI_API_URL || localSecrets.AI_API_URL || 'https://api.openai.com/v1/chat/completions'
const aiModel = process.env.AI_MODEL || localSecrets.AI_MODEL || 'gpt-5.4'
const PRODUCT_NAME = 'CipherTalk'

const PRIMARY_AUTHOR_LOGINS = new Set(['ILoveBingLu'])
const PRIMARY_AUTHOR_NAMES = new Set(['ILoveBingLu', 'BingLu', 'ILoveBinglu'])

function isPrimaryAuthor(person) {
  if (!person) return false
  const login = String(person.authorLogin || '').trim()
  const name = String(person.authorName || '').trim()
  return PRIMARY_AUTHOR_LOGINS.has(login) || PRIMARY_AUTHOR_NAMES.has(name)
}

function classifyCommit(subject) {
  const normalized = String(subject || '').toLowerCase()
  if (normalized.startsWith('feat')) return '新增'
  if (normalized.startsWith('fix')) return '修复'
  return '调整'
}

function buildThanks(context) {
  const lines = []

  for (const pr of context.pullRequests || []) {
    if (!isPrimaryAuthor({ authorLogin: pr.authorLogin, authorName: pr.authorName })) {
      lines.push(`- 感谢 @${pr.authorLogin} 提交 PR #${pr.number}《${pr.title}》`)
    }
  }

  const prNumbers = new Set((context.pullRequests || []).map((pr) => pr.number))
  for (const commit of context.commits || []) {
    const hasPrRef = /#(\d+)/.test(commit.subject || '')
    if (hasPrRef) continue
    if (!isPrimaryAuthor(commit)) {
      lines.push(`- 感谢 ${commit.authorName} 提交改动《${commit.subject}》`)
    }
  }

  return Array.from(new Set(lines))
}

function buildReferences(context) {
  const lines = []
  for (const pr of context.pullRequests || []) {
    lines.push(`- PR #${pr.number}: [${pr.title}](${pr.url})`)
  }
  for (const commit of context.commits || []) {
    lines.push(`- Commit [${commit.shortSha}](${commit.url}): ${commit.subject}`)
  }
  return lines
}

function inferReleaseTone(context) {
  const subjects = (context.commits || []).map((commit) => String(commit.subject || '').toLowerCase())
  if (subjects.some((subject) => subject.startsWith('feat'))) return '新功能开始成型'
  if (subjects.some((subject) => subject.startsWith('fix'))) return '这次重点在修整体验'
  if (subjects.some((subject) => subject.includes('release') || subject.includes('workflow') || subject.includes('ci'))) {
    return '发布链路做了一轮收口'
  }
  if ((context.commits || []).length >= 5) return '这一版主要在做内部打磨'
  return '这次更新以稳定和整理为主'
}

function buildReleaseTitle(context) {
  return `${PRODUCT_NAME} v${context.version} · ${inferReleaseTone(context)}`
}

function buildFallbackBody(context) {
  const groups = {
    新增: [],
    修复: [],
    调整: []
  }

  for (const commit of context.commits || []) {
    groups[classifyCommit(commit.subject)].push(`- ${commit.subject}（${commit.shortSha}）`)
  }

  const thanks = buildThanks(context)
  const references = buildReferences(context)
  const blockedVersions = context.forceUpdate?.blockedVersions || []
  const hasUpgradeReminder = Boolean(context.forceUpdate?.minimumSupportedVersion || blockedVersions.length > 0)
  const totalCommits = (context.commits || []).length
  const totalPrs = (context.pullRequests || []).length
  const touchedAreas = Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([name]) => name)
  const summary = touchedAreas.length
    ? `这次共整理了 ${totalCommits} 条提交${totalPrs ? `、${totalPrs} 个 PR` : ''}，重点落在 ${touchedAreas.join(' / ')}。`
    : `这次共整理了 ${totalCommits} 条提交${totalPrs ? `、${totalPrs} 个 PR` : ''}，整体以维护性调整为主。`

  return [
    `## ${buildReleaseTitle(context)}`,
    '',
    `> ${summary}`,
    '',
    '### 这次更新',
    `- ${inferReleaseTone(context)}。`,
    `- ${summary}`,
    '',
    '### 变更明细',
    '',
    '#### 新增',
    ...(groups.新增.length ? groups.新增 : ['- 本次没有单独拎出来的新功能提交']),
    '',
    '#### 修复',
    ...(groups.修复.length ? groups.修复 : ['- 本次没有明确归类为缺陷修复的提交']),
    '',
    '#### 调整',
    ...(groups.调整.length ? groups.调整 : ['- 本次主要是零散维护项']),
    '',
    ...(hasUpgradeReminder ? [
      '### 升级提醒',
      ...(context.forceUpdate.minimumSupportedVersion ? [`- 最低安全版本：${context.forceUpdate.minimumSupportedVersion}`] : []),
      ...(blockedVersions.length ? [`- 封禁版本：${blockedVersions.join(', ')}`] : []),
      ''
    ] : []),
    '### 感谢贡献者',
    ...(thanks.length ? thanks : ['- 本版本无新增外部贡献']),
    '',
    '### 相关提交与 PR',
    ...(references.length ? references : ['- 无']),
    ''
  ].join('\n')
}

function isValidAiBody(body) {
  if (!body) return false
  return body.includes(`## ${PRODUCT_NAME}`) && body.includes('### 感谢贡献者') && body.includes('### 相关提交与 PR')
}

function logAiConfig() {
  console.log('[ReleaseBody] AI config:')
  console.log(`  apiUrl=${aiApiUrl}`)
  console.log(`  model=${aiModel}`)
  console.log(`  apiKeyConfigured=${Boolean(aiApiKey)}`)
  console.log(`  usingDefaultApiUrl=${!process.env.AI_API_URL}`)
  console.log(`  usingDefaultModel=${!process.env.AI_MODEL}`)
}

async function generateAiBody(context) {
  if (!aiApiKey) {
    throw new Error('AI_API_KEY 未配置')
  }

  logAiConfig()

  const systemPrompt = [
    '你是一个发布说明撰写助手。',
    '只能基于输入中的 commits 和 pull requests 生成，不得编造任何功能或修复。',
    '输出必须是中文 Markdown，风格要自然，像真实产品版本说明，不要写成死板模板。',
    '标题必须包含软件名，不能只写版本号。',
    '第一行使用格式：## CipherTalk vX.Y.Z · 一句简短版本名',
    '第二段使用一行引用块（>）写一句导语，概括这次更新的重心。',
    '正文优先使用以下结构：',
    '### 这次更新',
    '### 变更明细',
    '#### 新增',
    '#### 修复',
    '#### 调整',
    '### 感谢贡献者',
    '### 相关提交与 PR',
    '如果上方有些内容没有，即可用一些涩话来填充，不要显得很死板或机械。',
    '如果存在最低安全版本或封禁版本，增加 ### 升级提醒 章节。',
    '分类建议：可参考提交标题前缀 feat/fix 做粗分类到 新增/修复；其余放到 调整（如果标题无法判断，就放到 调整）。',
    '如果某个分类为空，不要反复写“无/未检测到”这种机械表达，可以改成更自然但仍然克制的表述。',
    '如果这次主要是 chore、ci、release、workflow、refactor，也要把这些工程改动翻译成用户能理解的影响，比如“发布链路更稳”“版本分发更顺”“维护成本更低”，但不能编造功能。',
    '引用规则：',
    '有 PR 时优先引用 PR 标题；没有 PR 时才引用 commit 标题。',
    '列表尽量短：最多每类列出 5 条最关键的标题；其余可在导语或“这次更新”里用一句话说明总量。',
    '感谢规则：只有非主作者的 PR/commit 才出现在感谢段；主作者按代码中的逻辑是 ILoveBingLu（及其大小写/拼写变体）相关。',
    '不要写猜测：如果输入里没有足够信息，就明确说这次以内部整理、稳定性、发布链路或工程维护为主。',
    '不要输出代码块，不要输出 JSON，不要套娃标题。'
  ].join('\n')

  const userPrompt = [
    `请根据以下发布上下文，为 ${PRODUCT_NAME} ${context.tag} 生成一份更有辨识度的发布说明。`,
    '附加要求：',
    `- 标题必须带 ${PRODUCT_NAME} 和版本号，并给这次版本起一个简短名字。`,
    '- 不要每次都复用同一套句式。',
    '- 如果提交主要是发布流程、CI、脚本、环境变量之类的工程项，也要写出它们对发版和分发稳定性的意义。',
    '- 保留“感谢贡献者”和“相关提交与 PR”章节。',
    '- 你是一个类似伤感者的文案大师，写出来的东西要有温度和辨识度，不要死板无趣。',
    '',
    JSON.stringify(context, null, 2)
  ].join('\n')
  const startedAt = Date.now()
  console.log(`[ReleaseBody] AI request start for ${context.tag}`)

  const response = await fetch(aiApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aiApiKey}`
    },
    body: JSON.stringify({
      model: aiModel,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  })

  const durationMs = Date.now() - startedAt
  console.log(`[ReleaseBody] AI response received status=${response.status} durationMs=${durationMs}`)

  if (!response.ok) {
    const raw = await response.text()
    console.error(`[ReleaseBody] AI response error body=${raw}`)
    throw new Error(`AI 请求失败: ${response.status}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  console.log(`[ReleaseBody] AI content length=${typeof content === 'string' ? content.length : 0}`)
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI 返回内容为空')
  }

  const body = content.trim()
  if (!isValidAiBody(body)) {
    console.error('[ReleaseBody] AI output preview:')
    console.error(body.slice(0, 1000))
    throw new Error('AI 返回内容不符合格式要求')
  }

  console.log('[ReleaseBody] AI output validated successfully')

  return body
}

async function main() {
  if (!fs.existsSync(contextPath)) {
    throw new Error(`未找到 release context: ${contextPath}`)
  }

  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'))

  let body
  try {
    body = await generateAiBody(context)
    console.log('✅ 已生成 AI Release Body')
  } catch (error) {
    console.warn('⚠️ AI 生成失败，回退到模板正文：', String(error))
    body = buildFallbackBody(context)
    console.log(`[ReleaseBody] Fallback body length=${body.length}`)
  }

  fs.writeFileSync(outputPath, `${body.trim()}\n`, 'utf8')
  console.log(`✅ release-body.md 已生成: ${outputPath}`)
  console.log(`[ReleaseBody] Final body length=${body.trim().length}`)
}

main().catch((error) => {
  console.error('❌ 生成 release-body.md 失败:', error)
  process.exit(1)
})
