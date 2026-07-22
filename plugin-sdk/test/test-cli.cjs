/**
 * CLI 纯逻辑测试：manifest 校验（与宿主同规则）+ ZIP 往返 + 文件收集排除规则。
 * 运行：node plugin-sdk/test/test-cli.cjs
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

// adm-zip 来自主项目 node_modules（仅测试用，宿主侧也是它读取安装包）
const projectRequire = Module.createRequire(path.join(__dirname, '..', '..', 'package.json'))
const AdmZip = projectRequire('adm-zip')
const { validateManifest, writeZip, collectFiles } = require('../cli.cjs')

const base = { id: 'com.a.b', name: 'X', version: '1.0.0', apiVersion: 1, author: { name: 'Dev' } }

// —— validateManifest 各分支 ——
assert.strictEqual(validateManifest(base), null, '合法 manifest 应通过')
assert.match(validateManifest({ ...base, id: 'Bad_ID' }), /id/, '大写/下划线 id 应拒')
assert.match(validateManifest({ ...base, apiVersion: 2 }), /apiVersion/, 'apiVersion 不符应拒')
assert.match(validateManifest({ ...base, author: undefined }), /author\.name/, '缺 author 应拒')
assert.match(validateManifest({ ...base, author: { name: '' } }), /author\.name/, '空 author.name 应拒')
assert.match(validateManifest({ ...base, author: { name: 'D', email: 'bad' } }), /email/, '坏邮箱应拒')
assert.match(validateManifest({ ...base, author: { name: 'D', url: 'ftp://x' } }), /url/, '非 http url 应拒')
assert.strictEqual(validateManifest({ ...base, author: { name: 'D', email: 'a@b.co', url: 'https://x' } }), null, '合法 email/url 应通过')
assert.match(validateManifest({ ...base, permissions: ['x:y'] }), /不支持/, '未知权限应拒')
assert.match(validateManifest({ ...base, contributes: { views: { a: { entry: '../e' } } } }), /相对路径/, 'entry 穿越应拒')
// 回归：多个 view 时第二个非法也要被抓（旧版只校验首个）
assert.match(
  validateManifest({ ...base, contributes: { views: { a: { entry: 'ok.html' }, b: { entry: '/abs' } } } }),
  /相对路径/, '第二个 view 非法应被抓',
)
// 贡献点引用未定义视图
assert.match(
  validateManifest({ ...base, contributes: { sidebarMenus: [{ id: 'm', label: 'L', view: 'nope' }], views: {} } }),
  /不存在的视图/, '悬空视图引用应拒',
)

// —— writeZip 往返（宿主 AdmZip 读回，校验文件名/内容/CRC） ——
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cli-'))
const zipPath = path.join(tmp, 't.ctp')
writeZip(zipPath, [
  { name: 'manifest.json', data: Buffer.from('{"x":1}') },
  { name: 'sub/a.txt', data: Buffer.from('hello world '.repeat(50)) }, // 够大触发 deflate
])
const zip = new AdmZip(zipPath)
assert.strictEqual(zip.getEntries().length, 2, '应含 2 个条目')
assert.strictEqual(zip.readAsText('manifest.json'), '{"x":1}', 'store 内容应一致')
assert.strictEqual(zip.readFile(zip.getEntry('sub/a.txt')).toString(), 'hello world '.repeat(50), 'deflate 内容应一致（CRC 校验通过）')

// —— collectFiles 排除规则 ——
const proj = path.join(tmp, 'proj')
fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true })
fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
fs.writeFileSync(path.join(proj, 'manifest.json'), '{}')
fs.writeFileSync(path.join(proj, 'index.html'), 'x')
fs.writeFileSync(path.join(proj, 'main.js'), 'x')
fs.writeFileSync(path.join(proj, 'main.js.map'), 'x')
fs.writeFileSync(path.join(proj, 'old.ctp'), 'x')
fs.writeFileSync(path.join(proj, 'node_modules', 'junk.js'), 'x')
fs.writeFileSync(path.join(proj, '.git', 'config'), 'x')
const names = collectFiles(proj).map((f) => f.name).sort()
assert.deepStrictEqual(names, ['index.html', 'main.js', 'manifest.json'], `排除 node_modules/.git/.map/.ctp；实际 ${names}`)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('✅ CLI 逻辑测试全部通过')
