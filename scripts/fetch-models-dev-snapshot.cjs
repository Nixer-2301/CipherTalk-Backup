const fs = require('fs')
const path = require('path')

// 发版时刷新随包的 models.dev 快照。客户端被墙/离线时靠它兜底模型列表。
// 抓取失败不阻断发布：保留仓库里已有的快照即可。
const SOURCE = (process.env.CIPHERTALK_MODELS_URL || 'https://models.dev').replace(/\/+$/, '')
const OUTPUT_PATH = path.join(__dirname, '../electron/assets/models-dev.json')
const TIMEOUT_MS = 30000
const MIN_PROVIDERS = 50

async function main() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${SOURCE}/api.json`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CipherTalk' }
    })
    if (!response.ok) {
      throw new Error(`models.dev 请求失败: ${response.status}`)
    }
    const data = await response.json()
    const providers = data?.providers || data
    const count = providers && typeof providers === 'object' ? Object.keys(providers).length : 0
    if (count < MIN_PROVIDERS) {
      throw new Error(`models.dev 返回的服务商数量异常(${count})，疑似数据残缺`)
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data), 'utf-8')
    const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2)
    console.log(`✅ 已刷新 models.dev 快照: ${count} 家服务商, ${sizeMB}MB`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (fs.existsSync(OUTPUT_PATH)) {
      console.warn(`⚠️ 刷新 models.dev 快照失败，保留已有快照: ${message}`)
    } else {
      console.error(`❌ 刷新 models.dev 快照失败且无已有快照可用: ${message}`)
      process.exit(1)
    }
  } finally {
    clearTimeout(timeout)
  }
}

main()
