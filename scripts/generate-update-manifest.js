const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const pkg = require('../package.json')

const releaseDir = path.join(__dirname, '..', 'release')
const inputTarget = process.argv[2]

const targetMap = {
  win: {
    artifactName: `CipherTalk-${pkg.version}-Setup.exe`,
    manifestName: 'latest.yml'
  },
  mac: {
    artifactName: `CipherTalk-${pkg.version}-Setup.dmg`,
    manifestName: 'latest-mac.yml'
  }
}

function toSha512Base64(filePath) {
  const fileBuffer = fs.readFileSync(filePath)
  return crypto.createHash('sha512').update(fileBuffer).digest('base64')
}

function formatManifest({ version, artifactName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
}

function generateManifest(target) {
  const { artifactName, manifestName } = targetMap[target]
  const artifactPath = path.join(releaseDir, artifactName)

  if (!fs.existsSync(artifactPath)) {
    return false
  }

  const sha512 = toSha512Base64(artifactPath)
  const size = fs.statSync(artifactPath).size
  const releaseDate = new Date().toISOString()
  const content = formatManifest({
    version: pkg.version,
    artifactName,
    sha512,
    size,
    releaseDate
  })

  fs.writeFileSync(path.join(releaseDir, manifestName), content, 'utf8')
  console.log(`✅ ${manifestName} 已生成`)
  return true
}

if (inputTarget) {
  if (!targetMap[inputTarget]) {
    console.error('Usage: node scripts/generate-update-manifest.js [win|mac]')
    process.exit(1)
  }

  if (!generateManifest(inputTarget)) {
    console.error(`Artifact not found for target: ${inputTarget}`)
    process.exit(1)
  }
  process.exit(0)
}

const generatedCount = Object.keys(targetMap).filter(generateManifest).length
if (generatedCount === 0) {
  console.error('No supported artifacts found in release directory')
  process.exit(1)
}
