// vite-plugin-electron 多 entry 共用 dist-electron 输出目录，emptyOutDir 被关闭，
// 该目录从不自清理，旧 hash 产物会无限累积并被打进 app.asar。构建/启动前清空一次。
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'dist-electron')

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true })
  console.log('已清空 dist-electron（移除累积的旧构建产物）')
}
