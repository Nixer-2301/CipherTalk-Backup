const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')
const baseDir = path.join(rootDir, 'resources', 'wedecrypt')
const addonName = 'ciphertalk-image-native'

function resolvePlatformDir(value = process.platform) {
  if (value === 'win32') return 'win32'
  if (value === 'darwin' || value === 'macos') return 'macos'
  if (value === 'linux') return 'linux'
  throw new Error(`Unsupported platform: ${value}`)
}

function resolveArchDir(value = process.arch) {
  if (value === 'x64') return 'x64'
  if (value === 'arm64') return 'arm64'
  throw new Error(`Unsupported arch: ${value}`)
}

function main() {
  const platformDir = resolvePlatformDir(process.env.CIPHERTALK_IMAGE_NATIVE_PLATFORM || process.platform)
  const archDir = resolveArchDir(process.env.CIPHERTALK_IMAGE_NATIVE_ARCH || process.arch)
  const addonPath = path.join(baseDir, `${addonName}-${platformDir}-${archDir}.node`)

  console.log(`[image-native-check] target: ${platformDir}/${archDir}`)
  console.log(`[image-native-check] addon path: ${addonPath}`)

  if (!fs.existsSync(addonPath)) {
    console.error('[image-native-check] missing image native addon')
    process.exit(2)
  }

  const stat = fs.statSync(addonPath)
  if (!stat.isFile() || stat.size <= 0) {
    console.error('[image-native-check] invalid image native addon')
    process.exit(3)
  }

  console.log(`[image-native-check] ok (${stat.size} bytes)`)
}

main()
