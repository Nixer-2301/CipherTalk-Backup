import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultUpstream = resolve(here, '..', '..')
const upstream = resolve(process.argv[2] || defaultUpstream)
const servicesPath = join(upstream, 'electron', 'services')

if (!existsSync(servicesPath)) {
  console.error('用法: tsx scripts/sync-from-upstream.ts <密语项目路径>')
  console.error(`未找到 electron/services 目录: ${upstream}`)
  process.exitCode = 1
} else {
  console.log('人工同步目标:', upstream)
  console.log('数据层服务目录:', servicesPath)
  console.log('请审阅 electron/services 的变更，并将非 Electron 数据层更新移植到 CipherTalk-CLI/src/services。')
}
