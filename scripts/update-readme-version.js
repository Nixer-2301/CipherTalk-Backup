const fs = require('fs')
const path = require('path')

const packageJsonPath = path.join(__dirname, '../package.json')
const readmePath = path.join(__dirname, '../README.md')

// 读取 package.json 获取版本号
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
const version = packageJson.version

if (!version) {
  console.error('未找到版本号')
  process.exit(1)
}

// 读取 README.md
let readmeContent = fs.readFileSync(readmePath, 'utf-8')

// 使用正则表达式替换版本号
// 匹配 [![Version](https://img.shields.io/badge/version-1.0.1-green.svg)](package.json)
const versionPattern = /(\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-)([0-9]+\.[0-9]+\.[0-9]+)(-green\.svg\)\]\(package\.json\))/

if (versionPattern.test(readmeContent)) {
  readmeContent = readmeContent.replace(versionPattern, `$1${version}$3`)
  fs.writeFileSync(readmePath, readmeContent, 'utf-8')
  console.log(`✅ 已更新 README.md 中的版本号为: ${version}`)
} else {
  console.error('❌ 未找到版本号徽章，请检查 README.md 格式')
  process.exit(1)
}
