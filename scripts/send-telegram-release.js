const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const contextPath = path.join(releaseDir, 'release-context.json')
const releaseBodyPath = path.join(releaseDir, 'release-body.md')

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_IDS = String(process.env.TELEGRAM_CHAT_IDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const TELEGRAM_RELEASE_COVER_URL = process.env.TELEGRAM_RELEASE_COVER_URL || ''
const mode = process.env.TELEGRAM_NOTIFY_MODE || 'success'

class TelegramSendError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'TelegramSendError'
    this.details = details
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function guessFileNameFromUrl(url, contentType) {
  try {
    const pathname = new URL(url).pathname
    const baseName = path.basename(pathname) || 'release-cover'
    if (path.extname(baseName)) {
      return baseName
    }
    if (/png/i.test(contentType || '')) return `${baseName}.png`
    if (/webp/i.test(contentType || '')) return `${baseName}.webp`
    if (/gif/i.test(contentType || '')) return `${baseName}.gif`
    return `${baseName}.jpg`
  } catch {
    if (/png/i.test(contentType || '')) return 'release-cover.png'
    if (/webp/i.test(contentType || '')) return 'release-cover.webp'
    if (/gif/i.test(contentType || '')) return 'release-cover.gif'
    return 'release-cover.jpg'
  }
}

// 从 release-body.md 的一级标题 (## CipherTalk vX.X.X · 副标题) 中拿出副标题
function extractSubtitle(markdown) {
  const m = String(markdown || '').match(/^##\s+CipherTalk\s+v\S+\s*[·•:\|\-]\s*(.+)$/m)
  return m ? m[1].trim() : ''
}

// 解析 ### 变更明细 下的 #### 新增 / #### 修复 / #### 调整 段，转为干净的 items
function extractChangeSections(markdown) {
  const lines = String(markdown || '').split('\n')
  const sections = { added: [], fixed: [], changed: [] }
  let current = null
  for (const line of lines) {
    const h4 = line.match(/^####\s+(.+?)\s*$/)
    if (h4) {
      const title = h4[1].trim()
      if (title === '新增') current = 'added'
      else if (title === '修复') current = 'fixed'
      else if (title === '调整' || title === '其他') current = 'changed'
      else current = null
      continue
    }
    if (/^#{1,3}\s/.test(line)) { current = null; continue }
    if (!current) continue
    const item = line.match(/^-\s+(.+)$/)
    if (!item) continue
    let text = item[1].trim()
    // 跳过占位说明
    if (/本次没有/.test(text) || /本版本无/.test(text)) continue
    // 去掉尾部 (短sha) 或（短sha）
    text = text.replace(/\s*[（(]\s*[a-f0-9]{6,}\s*[）)]\s*$/i, '')
    // 去掉 conventional commit 前缀 (feat:/fix:/chore:/...) 让正文更直白
    text = text.replace(/^(feat|fix|chore|docs|refactor|style|perf|test|build|ci|release)(\([^)]*\))?\s*:\s*/i, '')
    if (text) sections[current].push(text)
  }
  return sections
}

function getContext() {
  if (!fs.existsSync(contextPath)) return null
  return JSON.parse(fs.readFileSync(contextPath, 'utf8'))
}

function getReleaseBody() {
  if (!fs.existsSync(releaseBodyPath)) return ''
  return fs.readFileSync(releaseBodyPath, 'utf8')
}

function buildButtons(version) {
  return {
    inline_keyboard: [
      [
        { text: '下载', url: `https://github.com/ILoveBingLu/CipherTalk/releases/tag/v${encodeURIComponent(version)}` },
        { text: '官网', url: 'https://miyu.aiqji.com' }
      ],
      [
        { text: '使用教程', url: 'https://ilovebinglu.notion.site/ciphertalk' }
      ]
    ]
  }
}

function buildSuccessMessage(context, releaseBody) {
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const subtitle = extractSubtitle(releaseBody)
  const sections = extractChangeSections(releaseBody)
  const commitCount = Array.isArray(context?.commits) ? context.commits.length : 0
  const date = context?.generatedAt
    ? new Date(context.generatedAt).toISOString().slice(0, 10)
    : ''

  // 标题区：产品名 + 用 <code> 包装的版本号（"代码感"）+ 副标题
  const lines = [
    `<b>CipherTalk</b>  <code>v${escapeHtml(version)}</code>`
  ]
  if (subtitle) lines.push(`<i>${escapeHtml(subtitle)}</i>`)

  // 详细变更：用 <blockquote expandable> 折叠
  // 让 blockquote 自身的左竖线作为分组视觉，分类用粗体标签 + › 列表 bullet
  const block = []
  const appendSection = (label, items) => {
    if (!items.length) return
    if (block.length) block.push('')
    block.push(`<b>${label}</b>`)
    for (const it of items) block.push(`  › ${escapeHtml(it)}`)
  }
  appendSection('新增', sections.added)
  appendSection('修复', sections.fixed)
  appendSection('调整', sections.changed)

  if (block.length) {
    lines.push('', `<blockquote expandable><b>更新内容</b>\n\n${block.join('\n')}</blockquote>`)
  }

  // 底部元信息：提交数 · 发布日期
  const meta = []
  if (commitCount) meta.push(`${commitCount} commits`)
  if (date) meta.push(date)
  if (meta.length) lines.push('', `<i>${meta.join('  ·  ')}</i>`)

  // sendPhoto 的 caption 上限 1024 字符，超出时把可展开块截断并补全闭合标签
  let text = lines.join('\n')
  if (text.length > 1000) {
    text = text.slice(0, 980).replace(/\s+$/, '') + '…'
    const opens = (text.match(/<blockquote[^>]*>/g) || []).length
    const closes = (text.match(/<\/blockquote>/g) || []).length
    if (opens > closes) text += '</blockquote>'
  }
  return text
}

function buildFailureMessage() {
  const workflowUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : ''
  const version = process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME || 'unknown'
  const lines = [
    `<b>CipherTalk ${escapeHtml(version)} · 发布失败</b>`,
    '',
    '请查看 Actions 运行日志定位原因。'
  ]
  if (workflowUrl) {
    lines.push('', `<a href="${workflowUrl}">打开运行日志</a>`)
  }
  return lines.join('\n')
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const messagePayload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup
  }

  const photoPayload = {
    chat_id: chatId,
    photo: TELEGRAM_RELEASE_COVER_URL,
    caption: text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }

  if (!TELEGRAM_RELEASE_COVER_URL) {
    await callTelegramApi('sendMessage', chatId, messagePayload)
    return
  }

  try {
    const formData = await buildPhotoFormData(photoPayload)
    await callTelegramApi('sendPhoto', chatId, formData, { bodyType: 'form' })
  } catch (error) {
    const description = String(error?.details?.description || error?.message || '')
    const shouldFallback =
      !(error instanceof TelegramSendError) ||
      error?.details?.endpoint === 'sendPhoto' ||
      error?.details?.stage === 'download_cover'

    if (!shouldFallback) {
      throw error
    }

    console.warn('⚠️ Telegram 封面图发送失败，改为纯文本发送', {
      chatId,
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      description
    })

    await callTelegramApi('sendMessage', chatId, messagePayload)
  }
}

async function buildPhotoFormData(photoPayload) {
  const downloadResponse = await fetch(TELEGRAM_RELEASE_COVER_URL, {
    redirect: 'follow'
  })

  const contentType = downloadResponse.headers.get('content-type') || ''

  if (!downloadResponse.ok) {
    const raw = await downloadResponse.text()
    const details = {
      stage: 'download_cover',
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      status: downloadResponse.status,
      statusText: downloadResponse.statusText,
      description: `封面图下载失败 (${downloadResponse.status})`,
      raw
    }
    console.error('❌ Telegram 封面图下载失败', details)
    throw new TelegramSendError(details.description, details)
  }

  if (!/^image\//i.test(contentType)) {
    const raw = await downloadResponse.text()
    const details = {
      stage: 'download_cover',
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      status: downloadResponse.status,
      statusText: downloadResponse.statusText,
      description: `封面图 content-type 不是图片: ${contentType || 'unknown'}`,
      raw
    }
    console.error('❌ Telegram 封面图内容类型错误', details)
    throw new TelegramSendError(details.description, details)
  }

  const arrayBuffer = await downloadResponse.arrayBuffer()
  const fileName = guessFileNameFromUrl(TELEGRAM_RELEASE_COVER_URL, contentType)
  const formData = new FormData()

  formData.append('chat_id', photoPayload.chat_id)
  formData.append('photo', new Blob([arrayBuffer], { type: contentType }), fileName)
  formData.append('caption', photoPayload.caption)
  formData.append('parse_mode', photoPayload.parse_mode)
  if (photoPayload.reply_markup) {
    formData.append('reply_markup', JSON.stringify(photoPayload.reply_markup))
  }

  return formData
}

async function callTelegramApi(endpoint, chatId, payload, options = {}) {
  const bodyType = options.bodyType || 'json'
  const requestOptions = {
    method: 'POST',
    body: bodyType === 'form' ? payload : JSON.stringify(payload)
  }

  if (bodyType === 'json') {
    requestOptions.headers = {
      'Content-Type': 'application/json'
    }
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, requestOptions)

  const raw = await response.text()
  const parsed = tryParseJson(raw)

  if (!response.ok || parsed?.ok === false) {
    const description = parsed?.description || raw
    const errorCode = parsed?.error_code
    const details = {
      endpoint,
      chatId,
      status: response.status,
      statusText: response.statusText,
      description,
      errorCode,
      raw
    }

    console.error('❌ Telegram API 返回错误', details)
    throw new TelegramSendError(
      `Telegram 发送失败 (${response.status}${errorCode ? `/${errorCode}` : ''}): ${description}`,
      details
    )
  }

  return parsed
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    console.log('ℹ️ Telegram 未配置，跳过通知')
    return
  }

  const context = getContext()
  const releaseBody = getReleaseBody()
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const text = mode === 'failure'
    ? buildFailureMessage()
    : buildSuccessMessage(context, releaseBody)
  const replyMarkup = mode === 'failure' ? undefined : buildButtons(version)

  for (const chatId of TELEGRAM_CHAT_IDS) {
    await sendTelegramMessage(chatId, text, replyMarkup)
  }

  console.log(`✅ 已发送 Telegram 通知到 ${TELEGRAM_CHAT_IDS.length} 个目标`)
}

main().catch((error) => {
  console.error('❌ Telegram 通知失败:', error?.message || error)
  if (error?.details) {
    console.error('❌ Telegram 错误详情:', error.details)
  }
  process.exit(1)
})
