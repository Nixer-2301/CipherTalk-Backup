const pkg = require('../package.json')
const fs = require('fs')
const path = require('path')

const target = process.env.CIPHERTALK_BUILD_TARGET
const base = pkg.build || {}

function appendUnique(items = [], extras = []) {
  return [...new Set([...(items || []), ...extras])]
}

function withoutItems(items = [], values = []) {
  const blacklist = new Set(values)
  return (items || []).filter(item => !blacklist.has(item))
}

function getExtraResources(buildTarget) {
  const common = [
    {
      from: 'electron/assets/',
      to: 'assets/',
      filter: ['**/*']
    },
    {
      from: '.tmp/release-announcement.json',
      to: 'release-announcement.json'
    },
    {
      from: 'public/miyuji',
      to: 'builtin-pets/miyuji',
      filter: ['**/*']
    }
  ]

  if (buildTarget === 'mac') {
    return [
      {
        from: 'resources/macos/',
        to: 'resources/macos/',
        filter: ['**/*']
      },
      {
        // 图片解密原生插件，运行时按 process.resourcesPath/resources/wedecrypt 查找；mac 之前没拷这层导致解密失败
        from: 'resources/wedecrypt/',
        to: 'resources/wedecrypt/',
        filter: ['**/*']
      },
      ...common
    ]
  }

  if (buildTarget === 'win') {
    const winResources = [
      {
        from: 'resources/',
        to: 'resources/',
        // *.dll = 顶层 WCDB/wcdb_api/wx_key；wedecrypt/** = 图片解密原生插件(.node)，
        // 之前只写 *.dll 把 wedecrypt 漏掉了，导致发布版图片解密全失败。非当前平台的 .node 由 afterPack 裁剪。
        filter: ['*.dll', 'wedecrypt/**/*']
      },
      ...common,
      {
        from: 'public/icon.ico',
        to: 'icon.ico'
      }
    ]

    if (fs.existsSync(path.join(__dirname, '..', 'public', 'xinnian.ico'))) {
      winResources.push({
        from: 'public/xinnian.ico',
        to: 'xinnian.ico'
      })
    }

    return winResources
  }

  return base.extraResources || []
}

function getExtraFiles(buildTarget) {
  if (buildTarget === 'win') {
    return base.extraFiles || []
  }

  if (buildTarget === 'mac') {
    return [
      {
        from: 'scripts/ciphertalk-mcp',
        to: 'MacOS/ciphertalk-mcp'
      },
      {
        from: 'scripts/ciphertalk-mcp-bootstrap.cjs',
        to: 'MacOS/ciphertalk-mcp-bootstrap.cjs'
      }
    ]
  }

  return []
}

function getFiles(buildTarget) {
  const baseFiles = Array.isArray(base.files) ? [...base.files] : []
  const commonFiles = [
    'package.json',
    '!node_modules/.vite/**/*',
    // electron-builder 会在默认 app 文件集合上叠加 filter；这些工作区目录必须显式排除，
    // 否则临时目录、源码、原生编译目录会混进 app.asar，把安装包撑大。
    '!.agents/**/*',
    '!.claude/**/*',
    '!.tmp/**/*',
    '!.tmp-*/**/*',
    '!.vscode/**/*',
    '!CipherTalk-CLI/**/*',
    '!Docs/**/*',
    '!evaluation/**/*',
    '!examples/**/*',
    '!electron/**/*',
    '!message/**/*',
    '!native/**/*',
    '!native-dlls/**/*',
    '!output/**/*',
    '!plugin-sdk/**/*',
    '!plugin-workspace/**/*',
    '!public/**/*',
    '!release/**/*',
    '!resources/**/*',
    '!src/**/*',
    '!tools/**/*',
    '!wcdb_api/**/*',
    '!*.tsbuildinfo',
    '!build_log.txt',
    '!syntax_check.bat'
  ]

  if (buildTarget === 'win') {
    const patterns = appendUnique(
      withoutItems(baseFiles, ['node_modules/koffi/build/**/*']),
      [
        ...commonFiles,
        '!node_modules/**/{darwin,mac}/**/*',
        '!node_modules/**/*.dylib',
        '!node_modules/sherpa-onnx-node/bin/!(win-x64)/**/*',
        '!node_modules/ffmpeg-static/bin/!(win32-x64)/**/*',
        'node_modules/koffi/build/koffi/win32_x64/**/*'
      ]
    )
    return [{ from: '.', filter: patterns }]
  }

  if (buildTarget === 'mac') {
    const patterns = appendUnique(
      withoutItems(baseFiles, [
        'node_modules/koffi/build/**/*',
        '!node_modules/sherpa-onnx-node/bin/!(win-x64)/**/*',
        '!node_modules/ffmpeg-static/bin/!(win32-x64)/**/*'
      ]),
      [
        ...commonFiles,
        '!node_modules/sherpa-onnx-win-*/**/*',
        '!node_modules/sherpa-onnx-linux-*/**/*',
        'node_modules/sherpa-onnx-darwin-*/**/*',
        '!node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-win-*/**/*',
        '!node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-linux-*/**/*',
        'node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-darwin-*/**/*',
        'node_modules/koffi/build/koffi/darwin_*/**/*'
      ]
    )
    return [{ from: '.', filter: patterns }]
  }

  return [{ from: '.', filter: appendUnique(baseFiles, commonFiles) }]
}

function getAsarUnpack(buildTarget) {
  const baseAsarUnpack = Array.isArray(base.asarUnpack) ? [...base.asarUnpack] : []

  if (buildTarget === 'win') {
    return appendUnique(
      withoutItems(baseAsarUnpack, ['node_modules/koffi/**/*', 'resources/**/*']),
      ['node_modules/koffi/build/koffi/win32_x64/**/*']
    )
  }

  if (buildTarget === 'mac') {
    return appendUnique(
      withoutItems(baseAsarUnpack, ['node_modules/koffi/**/*']),
      ['node_modules/koffi/build/koffi/darwin_*/**/*']
    )
  }

  return baseAsarUnpack
}

function getDmg(buildTarget) {
  if (buildTarget === 'mac') {
    return {
      ...(base.dmg || {}),
      writeUpdateInfo: false
    }
  }

  return base.dmg
}

module.exports = {
  ...base,
  win: target === 'win' ? { ...(base.win || {}), files: [] } : base.win,
  mac: target === 'mac' ? { ...(base.mac || {}), files: [] } : base.mac,
  files: getFiles(target),
  asarUnpack: getAsarUnpack(target),
  dmg: getDmg(target),
  extraResources: getExtraResources(target),
  extraFiles: getExtraFiles(target)
}
