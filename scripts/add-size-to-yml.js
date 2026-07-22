const fs = require('fs')
const path = require('path')

const releaseDir = path.join(__dirname, '../release')

function getArtifactName(content) {
  const pathMatch = content.match(/path:\s*(.+\.(exe|dmg))/)
  if (pathMatch) {
    return pathMatch[1].trim()
  }

  const urlMatch = content.match(/-\s+url:\s*(.+\.(exe|dmg))/)
  if (urlMatch) {
    return urlMatch[1].trim()
  }

  return null
}

function finalizeFileItem(itemLines, size) {
  if (itemLines.length === 0) return itemLines

  const cleanedLines = itemLines.filter((line) => !line.trim().startsWith('size:'))
  const shaIndex = cleanedLines.findIndex((line) => line.trim().startsWith('sha512:'))
  const itemIndent = `${cleanedLines[0].match(/^\s*/)?.[0] || '  '}  `
  const sizeLine = `${itemIndent}size: ${size}`

  if (shaIndex >= 0) {
    cleanedLines.splice(shaIndex + 1, 0, sizeLine)
  } else {
    cleanedLines.push(sizeLine)
  }

  return cleanedLines
}

function normalizeLatestYml(content, size, fileName) {
  const lines = content.split(/\r?\n/)
  const filesIndex = lines.findIndex((line) => line.trim() === 'files:')
  if (filesIndex === -1) {
    return { changed: false, content, message: '未找到 files 块' }
  }

  let blockEnd = lines.length
  for (let i = filesIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      blockEnd = i
      break
    }
  }

  const before = lines.slice(0, filesIndex + 1)
  const fileBlock = lines.slice(filesIndex + 1, blockEnd)
  const after = lines.slice(blockEnd)

  const normalizedBlock = []
  let currentItem = []
  let handledFirstItem = false

  const flushItem = () => {
    if (currentItem.length === 0) return
    normalizedBlock.push(...(handledFirstItem ? currentItem : finalizeFileItem(currentItem, size)))
    handledFirstItem = true
    currentItem = []
  }

  for (const line of fileBlock) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      flushItem()
      currentItem.push(line)
      continue
    }

    if (currentItem.length > 0) {
      currentItem.push(line)
    } else {
      normalizedBlock.push(line)
    }
  }

  flushItem()

  const nextContent = [...before, ...normalizedBlock, ...after].join('\n')
  return {
    changed: nextContent !== content,
    content: nextContent,
    message: nextContent !== content ? `已规范 ${fileName} 中的 size 字段为 ${size}` : `${fileName} 中的 size 字段已正确`
  }
}

for (const fileName of ['latest.yml', 'latest-mac.yml']) {
  const ymlPath = path.join(releaseDir, fileName)

  if (!fs.existsSync(ymlPath)) {
    console.log(`${fileName} 不存在，跳过`)
    continue
  }

  const content = fs.readFileSync(ymlPath, 'utf-8')
  const artifactName = getArtifactName(content)

  if (!artifactName) {
    console.log(`${fileName} 未找到安装包文件名`)
    continue
  }

  const artifactPath = path.join(releaseDir, artifactName)
  if (!fs.existsSync(artifactPath)) {
    console.log(`安装包不存在: ${artifactName}`)
    continue
  }

  const size = fs.statSync(artifactPath).size
  const result = normalizeLatestYml(content, size, fileName)

  if (result.changed) {
    fs.writeFileSync(ymlPath, result.content)
  }

  console.log(result.message)
}
