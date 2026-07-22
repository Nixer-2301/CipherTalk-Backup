const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const crateRoot = path.join(projectRoot, 'native', 'image-decrypt')
const releaseDir = path.join(crateRoot, 'target', 'release')
const addonName = 'ciphertalk-image-native'

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = '1'
      continue
    }
    parsed[key] = next
    i += 1
  }
  return parsed
}

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

function resolveBuiltLibrary(platformDir, customLibPath) {
  if (customLibPath) {
    return path.resolve(projectRoot, customLibPath)
  }
  if (platformDir === 'win32') {
    return path.join(releaseDir, 'ciphertalk_image_native.dll')
  }
  if (platformDir === 'macos') {
    return path.join(releaseDir, 'libciphertalk_image_native.dylib')
  }
  if (platformDir === 'linux') {
    return path.join(releaseDir, 'libciphertalk_image_native.so')
  }
  throw new Error(`Unsupported platform: ${platformDir}`)
}

function removeLegacyOutput(platformDir, archDir, outputName) {
  const legacyDir = path.join(projectRoot, 'resources', 'wedecrypt', platformDir, archDir)
  const legacyPath = path.join(legacyDir, outputName)
  if (fs.existsSync(legacyPath)) {
    fs.rmSync(legacyPath, { force: true })
  }
  if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) {
    fs.rmSync(legacyDir, { recursive: true, force: true })
  }
  const platformDirPath = path.join(projectRoot, 'resources', 'wedecrypt', platformDir)
  if (fs.existsSync(platformDirPath) && fs.readdirSync(platformDirPath).length === 0) {
    fs.rmSync(platformDirPath, { recursive: true, force: true })
  }
}

function buildManifest() {
  const baseDir = path.join(projectRoot, 'resources', 'wedecrypt')
  const matrix = [
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['macos', 'x64'],
    ['macos', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64']
  ]

  const activeBinaries = {}
  const platforms = []
  for (const [platformDir, archDir] of matrix) {
    const filePath = path.join(baseDir, `${addonName}-${platformDir}-${archDir}.node`)
    if (!fs.existsSync(filePath)) continue
    const key = `${platformDir}-${archDir}`
    activeBinaries[key] = 'self-built-from-repo-source'
    platforms.push(key)
  }

  const manifest = {
    name: addonName,
    version: 'source-present-selfbuilt',
    vendor: 'CipherTalk',
    source: 'native/image-decrypt',
    activeBinaries,
    platforms
  }

  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(path.join(baseDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const platformDir = resolvePlatformDir(args.platform || process.env.CIPHERTALK_IMAGE_NATIVE_PLATFORM || process.platform)
  const archDir = resolveArchDir(args.arch || process.env.CIPHERTALK_IMAGE_NATIVE_ARCH || process.arch)
  const builtLibrary = resolveBuiltLibrary(platformDir, args.lib || process.env.CIPHERTALK_IMAGE_NATIVE_LIB)

  if (!fs.existsSync(builtLibrary)) {
    throw new Error(`Built library not found: ${builtLibrary}`)
  }

  const outputDir = path.join(projectRoot, 'resources', 'wedecrypt')
  const outputName = `${addonName}-${platformDir}-${archDir}.node`
  const outputPath = path.join(outputDir, outputName)

  fs.mkdirSync(outputDir, { recursive: true })
  fs.copyFileSync(builtLibrary, outputPath)
  removeLegacyOutput(platformDir, archDir, outputName)
  buildManifest()

  console.log(`[sync-image-native] synced ${builtLibrary} -> ${outputPath}`)
}

main()
