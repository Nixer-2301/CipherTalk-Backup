# CipherTalk 插件开发指南

CipherTalk 插件是纯前端应用（HTML/JS/CSS），运行在独立沙箱 iframe 中，
通过 SDK 调用宿主能力（数据查询、媒体、转写、搜索、导出、AI 等）。
任何框架都可以用（React/Vue/Svelte/原生），构建产物是静态文件即可。

## 目录

1. [五分钟上手](#1-五分钟上手)
2. [脚手架 CLI](#2-脚手架-cli)
3. [manifest 完整参考](#3-manifest-完整参考)
4. [权限清单](#4-权限清单)
5. [API 完整参考](#5-api-完整参考)
6. [统一 UI 组件](#6-统一-ui-组件)
7. [主题与暗色模式](#7-主题与暗色模式)
8. [开发热更新](#8-开发热更新devserver)
9. [打包与分发](#9-打包与分发ctp)
10. [限额与安全模型](#10-限额与安全模型)
11. [故障排查 FAQ](#11-故障排查-faq)
12. [示例](#12-示例)

## 1. 五分钟上手

```bash
node plugin-sdk/cli.cjs init my-plugin   # 交互式创建骨架（开发者名称必填）
```

生成的最小结构：

```
my-plugin/
  manifest.json               # 插件声明（id、开发者、权限、贡献点）
  index.html                  # 视图入口（沙箱 CSP 禁止内联 <script>）
  main.js                     # 外部脚本
  ciphertalk-plugin-sdk.js    # SDK（自动复制）
  ciphertalk-plugin-sdk.d.ts  # TS 类型（可选，编辑器提示用）
```

**main.js：**

```js
import { connect } from './ciphertalk-plugin-sdk.js'

const api = await connect()
const { sessions } = await api.data.sessions.list({ limit: 50 })
document.body.textContent = `共 ${sessions.length} 个会话`
```

**加载调试：** CipherTalk 设置 → 插件 → 打开「插件开发者模式」→
「加载本地插件目录」选中 `my-plugin/`，启用（确认权限）后侧边栏出现菜单入口。

## 2. 脚手架 CLI

CLI 位于 `plugin-sdk/cli.cjs`，零依赖（Node 18+）；发布 npm 后等价 `npx ciphertalk-plugin`：

| 命令 | 作用 |
|---|---|
| `init <目录>` | 纯静态骨架（询问 id、名称、**开发者名称（必填）**、邮箱），自动复制 SDK |
| `init <目录> --vite` | Vite + TypeScript 工程（`import from 'ciphertalk-plugin-sdk'`，热更新 + 构建） |
| `init <目录> --react` | React 19 + HeroUI v3 工程（真 HeroUI 组件，主题随宿主自动切换） |
| `pack [目录]` | 校验 manifest（与宿主同一套规则）+ 检查视图入口文件存在 → 打包为 `<id>-<version>.ctp` |

`pack` 自动排除 `node_modules`、`.git`、`.map`、已有的 `.ctp`。
校验不过会直接报错并指出字段，**不会产出坏包**。

### 三种起步方式

| | 纯静态（默认） | Vite + TS（`--vite`） | React + HeroUI（`--react`） |
|---|---|---|---|
| 结构 | HTML/JS + 相对路径引 SDK | npm 工程，`src/` + `dist/` | npm 工程，React + Tailwind v4 |
| UI | `.ct-*` 类 | `.ct-*` 类 | **真正的 HeroUI 组件** |
| 开发 | 改完在宿主里刷新 | `npm run dev` 热更新 | `npm run dev` 热更新 |
| 打包 | `pack` 直接打 | `npm run pack` | `npm run pack` |
| 适合 | 小工具、快速验证 | 有 TS/依赖的插件 | 想要与宿主同款 HeroUI 观感的插件 |

> **为什么是「插件自带 HeroUI」而不是「调用宿主的 HeroUI」**：插件在隔离 iframe
> 里，拿不到宿主的 React 组件实例（那需要拆掉沙箱）。所以 `--react` 模板让插件
> 把 HeroUI 打进自己的 bundle；宿主握手时注入了全套主题变量，自带的 HeroUI 观感
> 与宿主一致、随宿主切换暗色。想用别的组件库同理——自带 bundle + 取宿主 CSS 变量。

### 安装 SDK

```bash
npm install ciphertalk-plugin-sdk        # Vite 模板已在依赖里声明
```

纯静态模板由 CLI 自动把 SDK 文件拷进目录，无需 npm。SDK 依赖浏览器 API
（`window`、`MessageChannel`），只在插件页/打包器环境使用，不用于纯 Node。

### 版本与兼容

- **`manifest.apiVersion` 必须等于宿主支持的主版本**（当前 `1`），不符拒绝加载。
  SDK 导出 `API_VERSION` 常量可对照。
- **能力探测降级**：宿主可能比插件新/旧，用 `capabilities()` 判断某方法是否可用：

  ```ts
  const caps = await api.capabilities()
  if (caps.includes('sns.getTimeline')) {
    /* 用朋友圈能力 */
  } else {
    /* 老宿主：优雅降级 */
  }
  ```

- SDK 遵循语义化版本：补丁/次版本向后兼容；`apiVersion` 提升（破坏性变更）时，
  旧插件需更新 `manifest.apiVersion` 并按迁移说明适配后重新打包。
- `connect()` 返回值带 `apiVersion` / `sdkVersion`，便于日志与问题上报。

### 发布 SDK 到 npm（维护者）

```bash
cd plugin-sdk && npm publish        # files 白名单只发 SDK/CLI/README/LICENSE
```

## 3. manifest 完整参考

```jsonc
{
  // ===== 必填 =====
  "id": "com.you.my-plugin",       // 唯一标识：小写字母/数字/点/连字符，2-64 位，
                                   // 建议反域名式；正式安装时目录名必须与 id 一致
  "name": "我的插件",               // 显示名称
  "version": "1.0.0",              // 版本号（打包文件名会用到）
  "apiVersion": 1,                 // 插件 API 主版本；宿主不兼容时拒绝加载
  "author": {                      // 开发者身份标识
    "name": "张三",                 //   必填，最多 64 字符；展示在插件列表与启用确认弹窗
    "email": "zhangsan@example.com", // 选填，格式校验；用户联系渠道
    "url": "https://github.com/zhangsan/my-plugin" // 选填，须为 http(s)
  },

  // ===== 选填 =====
  "description": "一句话描述",
  "permissions": ["sessions:read", "messages:read"],  // 见 §4；未声明的调用一律被拒
  "contributes": {
    // 侧边栏菜单：点击在主区域打开整页视图
    "sidebarMenus": [
      { "id": "main", "label": "我的插件", "icon": "sparkles", "view": "index" }
    ],
    // 设置页新增 tab
    "settingsTabs": [
      { "id": "settings", "label": "我的插件", "view": "settings" }
    ],
    // 聊天界面右上角按钮：点击打开右侧抽屉，api.context 带当前会话
    "chatToolbarButtons": [
      { "id": "analyze", "label": "分析本会话", "icon": "chart-bar", "view": "panel" }
    ],
    // 视图表：entry 是插件目录内的 HTML 相对路径（禁止 .. 与绝对路径）
    "views": {
      "index":    { "entry": "index.html" },
      "settings": { "entry": "settings.html" },
      "panel":    { "entry": "panel.html", "presentation": "drawer" }
    }
  },
  "devServer": "http://localhost:5173"  // 仅开发者模式下的本地插件生效，见 §8
}
```

**图标名**（`icon`）从宿主内置集合选择，缺省 `puzzle`：
`bar-chart` `book-open` `calendar` `clock` `database` `download` `file-text`
`globe` `heart` `image` `message-square` `mic` `puzzle` `search` `smile`
`sparkles` `star` `tag` `users` `zap`

**校验失败的常见原因**：id 含大写/下划线、apiVersion 不是 1、
**缺 author.name**、permissions 里有拼错的权限名、views entry 指向不存在的文件、
贡献点引用了未定义的 view。

## 4. 权限清单

manifest 里声明什么，启用时用户就确认什么；未声明的调用一律被拒。
**升级时新增权限会导致插件被自动禁用**，用户重新启用时确认新清单。

| 权限 | 解锁的 API | 敏感度 |
|---|---|---|
| `sessions:read` | `api.data.sessions.*` | 低 |
| `contacts:read` | `api.data.contacts.*`（含群成员、头像） | 中 |
| `messages:read` | `api.data.messages.*`、`newMessages` 事件 | 高 |
| `media:read` | `api.media.*`（解密图片/语音/表情/视频） | 高 |
| `stt:use` | `api.stt.*`（语音转写） | 中 |
| `search:use` | `api.search.*`（全文搜索） | 高 |
| `stats:read` | `api.stats.*` | 中 |
| `export:use` | `api.export.*`（输出位置由用户确认） | 中 |
| `sns:read` | `api.sns.*`（朋友圈） | 高 |
| `ai:use` | `api.ai.*`（花用户的 API 额度，20 次/分钟预算） | 中 |
| `notify:send` | `api.notify.*` | 低 |
| `clipboard:write` | `api.clipboard.*` | 低 |
| `window:create` | `api.window.*` | 低 |
| `network` | iframe 允许外联（fetch/img 等） | **极高** |

**网络默认被禁止**：没有 `network` 权限的插件，CSP 在响应头层面阻止一切外联，
读到的数据传不出去。声明 `network` 会在启用弹窗中以红色警告展示
（"数据可能被发送到外部"）——非必要不申请，否则用户不敢启用。

无需权限的能力：`ui.*`、`storage.*`、`onThemeChanged()`、`capabilities()`。

## 5. API 完整参考

所有方法均为异步（Promise），失败时 reject 一个带中文错误信息的 `Error`。
建议统一 `try/catch` 并把 `e.message` 展示给用户。

### 连接与元信息

```ts
const api = await connect()   // 等待宿主握手（幂等，可重复调用）

api.pluginId                  // 本插件 id
api.viewId                    // 当前视图 id
api.context                   // 视图上下文；聊天工具栏抽屉里为
                              //   { sessionId: string, sessionName?: string }，其余场景为 {}
await api.capabilities()      // string[]，宿主支持的方法名集合——
                              //   用于探测宿主版本差异并优雅降级
```

### 数据（data）

**列表默认用懒加载**：每个列表接口都配有 `iterate()`，返回异步迭代器，
自动翻页、遍历多少拉多少——通常不需要自己碰 `offset` / `cursor`：

```ts
for await (const s of api.data.sessions.iterate()) render(s)      // 会话
for await (const c of api.data.contacts.iterate()) render(c)      // 联系人
for await (const m of api.data.messages.iterate({ sessionId })) … // 消息（最新→旧）
for await (const p of api.sns.iterate()) …                        // 朋友圈
// 参数与对应 list/query/getTimeline 相同，limit 作为每页大小；随时 break 停止拉取
```

底层的分页接口仍然可用（需要精确控制单页时）：

```ts
// 会话列表（sessions:read）
await api.data.sessions.list({ limit?: number /*≤2000*/, offset?: number })
// → { sessions: [{ sessionId, type, displayName, summary, lastTimestamp,
//                  avatarUrl, isPinned, isWeCom, isOfficialAccount }], hasMore }

// 联系人（contacts:read）
await api.data.contacts.list({ limit?, offset? })
// → { contacts: [{ username, displayName, remark, nickname, type, avatarUrl }], hasMore }
await api.data.contacts.get(username)          // → ContactSummary | null
await api.data.contacts.getAvatar(username)    // → { avatarUrl?, displayName? } | null
await api.data.contacts.getGroupMembers(chatroomId)
// → [{ username, displayName, avatarUrl? }]

// 消息查询（messages:read）——从最新往旧翻的游标分页
await api.data.messages.query({
  sessionId: string,          // 必填
  startTime?: number,         // Unix 秒；过滤下界（含）
  endTime?: number,           // 过滤上界（含）
  senderId?: string,          // 按发送者 wxid 过滤
  keyword?: string,           // 内容包含过滤
  limit?: number,             // 单页扫描量，默认 500，上限 2000
  cursor?: string,            // 上一页返回的 nextCursor
})
// → { rows: PluginMessage[], nextCursor?: string }
//
// PluginMessage: { localId, serverId, type /*微信 localType，1=文本 34=语音*/,
//                  createTime /*Unix 秒*/, sortSeq, isSend, senderUsername,
//                  content, imageMd5?, videoDuration?, voiceDuration?,
//                  fileName?, fileSize? }
//
// ⚠ 分页约定：带过滤条件时单页返回可能少于 limit（本页扫完了但命中少），
//   只要有 nextCursor 就还有数据。`iterate()` 已内置这套翻页逻辑，
//   手动 query 时才需要自己循环 cursor。

await api.data.messages.get(sessionId, localId)                    // 单条
await api.data.messages.getDatesWithMessages(sessionId, year, month) // → ['2026-07-01', ...]
```

### 媒体（media，需 media:read）

返回的 `url` 是宿主签发的**短时效地址（5 分钟）**，绑定本插件，用完即取，
不要持久化存储。

```ts
await api.media.getImage({ sessionId?, imageMd5?, imageDatName?, createTime?, thumbnail? })
// → { url, isThumb }        // 直接 <img src=url>
await api.media.getVoice({ sessionId, localId, createTime?, serverId? })
// → { wavBase64 }           // new Audio(`data:audio/wav;base64,${wavBase64}`)
await api.media.getEmoji({ sessionId, localId })      // → { url }
await api.media.getVideoInfo(videoMd5)                // → { exists, url?, coverUrl?, thumbUrl? }
```

### 语音转写（stt，需 stt:use）

```ts
await api.stt.transcribe({ sessionId, localId, createTime, serverId?, force? })
// → { text, fromCache }     // 复用宿主转写引擎与缓存；命中缓存不重复转写
await api.stt.getCachedTranscript(sessionId, createTime)   // → string | null
```

### 全文搜索（search，需 search:use）

```ts
await api.search.query({ sessionId, query, limit? /*≤200*/, matchMode? /*'substring'|'exact'*/,
                         startTime?, endTime?, senderId? })
// → { hits: [{ message: PluginMessage, excerpt, score }], indexComplete, truncated }
// 首次搜索某会话会触发建索引，可能较慢（数十秒），之后增量极快
```

### 统计（stats，需 stats:read）

```ts
await api.stats.messageCounts({ sessionId, groupBy: 'day' | 'month' | 'sender',
                                startTime?, endTime? })
// → { counts: [{ key, count }], scanned, truncated }
// 单次扫描上限 5 万条 / 8 秒；truncated=true 表示还有更早数据未计入
```

### 导出（export，需 export:use）

```ts
const off1 = api.events.on('exportProgress', (p) => { /* { taskId, ... } */ })
const off2 = api.events.on('exportDone', (p) => { /* { taskId, success?, outputPath?, error? } */ })
await api.export.exportSession({ sessionId,
  format: 'json' | 'html' | 'txt' | 'excel' | 'sql' | 'chatlab' | 'chatlab-jsonl',
  startTime?, endTime? })
// → { taskId, outputPath } 或 { canceled: true }
// 保存位置由用户在系统对话框中确认——插件不能指定任意路径
```

### 朋友圈（sns，需 sns:read）

```ts
await api.sns.getTimeline({ limit? /*≤100*/, offset?, usernames?, keyword?,
                            startTime?, endTime? })
// → { posts: [{ id, username, nickname, createTime, content, type,
//               media: [{ url, thumbUrl, width?, height? }],
//               likes: string[], comments: [{ nickname, content, refNickname? }] }],
//     hasMore }
// 媒体 URL 为微信 CDN 地址——加载图片本体需要 network 权限
```

### AI（ai，需 ai:use）

走用户在宿主里配置的模型与 API Key（**key 对插件不可见**）。
花的是用户额度，预算 **20 次/分钟**，超出报错——请合并请求。

```ts
await api.ai.complete({ prompt /*≤32k 字符*/, system? /*≤8k*/ })   // → { text }
await api.ai.embed(texts /*≤64 条，单条 ≤8k*/)                     // → { embeddings: number[][] }
```

### UI 与交互（ui，无需权限）

```ts
api.ui.toast('已完成', { type: 'success' | 'error' })  // 宿主层全局提示，勿自造浮动提示
api.ui.navigate('other-view')                           // 跳到本插件其它主区域视图
await api.ui.pickOption(anchorEl, { options: [{ value, label }], selected? })
// → 选中值 | null（用户取消）
// 宿主渲染的下拉选择（应用内同款组件）。注意：<select class="ct-select">
// 会被 SDK 自动接管走此通道，一般无需手动调用；此方法用于自定义触发器。
```

### 存储（storage，无需权限）

插件私有 KV，落在宿主的插件数据目录，卸载时清除。
单值 ≤256KB，总量 ≤5MB。

```ts
await api.storage.get(key)          // → unknown | null
await api.storage.set(key, value)   // value 须可 JSON 序列化
await api.storage.delete(key)
```

### 实时事件（events）

宿主用**推送**告知插件「有变化」，不是插件轮询。要点：事件只带**信号**、
**不含消息内容**——收到后自己再拉最新数据。这样既实时，又不会把全部数据
无差别推给每个插件。

```ts
// 订阅，返回退订函数
const off = api.events.on('newMessages', ({ sessionId, count }) => { /* … */ })
off()                                          // 退订

api.events.on('exportProgress', (p) => {})     // { taskId, ... }，仅发给发起导出的插件
api.events.on('exportDone', (p) => {})         // { taskId, success?, outputPath?, error? }
api.onThemeChanged((theme) => {})              // 主题变化（SDK 已自动应用，通常无需监听）
```

**`newMessages`**（需 `messages:read`）：某会话时间线前进且有未读时推送，payload
`{ sessionId, count }`（`count` 为该会话当前未读数），同一会话约 500ms 合并一次。
事件是**全局**的，自己按 `sessionId` 筛。**收到后要用 `messages.query` 拉最新内容**——
典型「来消息就处理」写法（防抖，避免连发重复触发）：

```ts
let timer
api.events.on('newMessages', ({ sessionId }) => {
  if (sessionId !== targetSession) return       // 事件是全局的，先筛出自己关心的会话
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const { rows } = await api.data.messages.query({ sessionId, limit: 20 })
    const lastFromFriend = [...rows].reverse().find((m) => !m.isSend)
    if (lastFromFriend) handle(lastFromFriend)   // 拉到的才是真正的新内容
  }, 3000)                                        // 静默 3 秒再处理
})
```

### 其它

```ts
await api.clipboard.write(text)                          // 需 clipboard:write
await api.notify.send(title, body)                       // 需 notify:send
await api.window.open(viewId, { width?, height? })       // 需 window:create
```

## 6. 统一 UI 组件

**不要自己画控件。** 宿主在连接时注入统一组件样式库（SDK 自动应用），
写语义化 HTML + `ct-*` 类即为宿主同款控件：

```html
<h3 class="ct-title">标题</h3>
<p class="ct-hint">辅助说明文字</p>
<label class="ct-label">字段标签</label>

<button class="ct-btn">普通按钮</button>
<button class="ct-btn ct-btn-primary">主按钮</button>
<button class="ct-btn ct-btn-ghost">幽灵按钮</button>
<button class="ct-btn ct-btn-danger">危险按钮</button>
<button class="ct-btn ct-btn-block">撑满一行</button>

<input class="ct-input" placeholder="输入框" />
<textarea class="ct-textarea"></textarea>

<!-- 下拉框：SDK 自动接管，弹出层由宿主用应用内组件渲染（与设置页完全一致） -->
<select class="ct-select">
  <option value="a">选项 A</option>
</select>

<label class="ct-switch"><input type="checkbox" /><span></span> 开关</label>
<label class="ct-checkbox"><input type="checkbox" /> 复选框</label>

<!-- 弹窗：原生 dialog，JS 调 showModal()/close() -->
<dialog class="ct-dialog" id="dlg">
  <h4 class="ct-dialog-title">确认操作</h4>
  <p class="ct-hint">说明文字</p>
  <div class="ct-dialog-actions">
    <button class="ct-btn" onclick="dlg.close()">取消</button>
    <button class="ct-btn ct-btn-primary">确定</button>
  </div>
</dialog>

<!-- 下拉菜单：原生 details，零 JS -->
<details class="ct-menu">
  <summary class="ct-btn">操作</summary>
  <div class="ct-menu-panel">
    <button class="ct-menu-item">菜单项</button>
  </div>
</details>

<div class="ct-tabs"><button class="ct-tab active">全部</button><button class="ct-tab">图片</button></div>
<progress class="ct-progress" value="40" max="100"></progress>
<span class="ct-spinner"></span>
<div class="ct-skeleton" style="height:20px;width:60%"></div>
<span class="ct-badge">3</span> <span class="ct-dot ct-dot-success"></span>
<span class="ct-chip">标签</span> <span class="ct-chip ct-chip-accent">强调标签</span>
<div class="ct-card">卡片</div>
<div class="ct-list"><div class="ct-list-item">列表项</div></div>
<div class="ct-empty">暂无数据</div>
<hr class="ct-divider" />
<pre class="ct-code">代码/日志块</pre>
<div class="ct-scroll">统一滚动条容器</div>

<!-- 表格：可直接手写，DataTable 组件也产出同款结构 -->
<div class="ct-table-wrap">
  <table class="ct-table">
    <thead><tr><th class="ct-th-sortable">列名 <span class="ct-th-arrow">▲</span></th></tr></thead>
    <tbody><tr><td>单元格</td></tr></tbody>
  </table>
</div>

<!-- 柱状图：每根柱子一个 .ct-chart-col，柱高用百分比 -->
<div class="ct-chart" style="height:180px">
  <div class="ct-chart-col"><span class="ct-chart-value">120</span>
    <div class="ct-chart-bar" style="height:60%"></div><span class="ct-chart-label">周一</span></div>
</div>
```

浮动提示用 `api.ui.toast()`（显示在宿主层，全局统一），不要自造。
组件库样式插在 `<head>` 最前，插件自己的样式可覆盖。

**完整活文档**：示例插件 `examples/plugins/ui-gallery` 把上述每个组件都渲染出来
（含表格排序、柱状图、弹窗、Tabs 交互），开发模式加载该目录即可对照抄用。

### 6.1 React 组件库（ciphertalk-plugin-sdk/ui）

用 React 写插件时，不必手拼 `.ct-*` 类——SDK 包自带 UI 组件库（`/ui` 子路径导出，
无需另装包），它是这些类的**薄封装**（不自带 CSS，观感仍由宿主注入），并额外提供
`LazyList`（滚动懒加载）、`DataTable`（排序 + 分页）与 `BarChart`：

```jsx
import { connect } from 'ciphertalk-plugin-sdk'
import { Button, Card, LazyList, ListItem, DataTable, BarChart } from 'ciphertalk-plugin-sdk/ui'

const api = await connect()           // connect 负责注入 .ct-* 样式

<Card>
  <Button variant="primary" onClick={() => api.ui.toast('已保存')}>保存</Button>
  {/* 列表默认懒加载：接上 SDK 的 iterate()，滚动到底自动取下一批 */}
  <LazyList source={() => api.data.sessions.iterate()}
            renderItem={(s) => <ListItem key={s.sessionId}>{s.displayName}</ListItem>} />
  <DataTable pageSize={10} columns={[
    { key: 'name', title: '联系人', sortable: true },
    { key: 'count', title: '消息数', sortable: true, align: 'right' },
  ]} rows={rows} />
  <BarChart height={200} data={[{ label: '周一', value: 120 }]} />
</Card>
```

组件清单与用法见该包 README。

### 6.2 图标

组件库不含图标。推荐 [`@gravity-ui/icons`](https://gravity-ui.com/icons)（与宿主同款风格），
自行安装引入：

```bash
npm i @gravity-ui/icons
```

```jsx
import { Magnifier } from '@gravity-ui/icons'
<Button variant="primary"><Magnifier width={16} height={16} /> 搜索</Button>
```

非 React 插件可用 Gravity UI Icons 的静态 SVG（复制 SVG 内联即可）。

## 7. 主题与暗色模式

宿主在连接时注入全部主题 CSS 变量并在用户切换主题时**实时更新**，
`ct-*` 组件自动适配。需要自定义样式时直接用变量：

```css
.my-box {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}
.my-accent { color: var(--accent); }
```

常用变量：`--bg-primary` `--bg-secondary` `--bg-tertiary` `--bg-hover`
`--text-primary` `--text-secondary` `--text-tertiary` `--border-color`
`--accent`（HeroUI 全套 tokens 均可用）。
暗色模式下 `<html>` 会带 `dark` class：`.dark .my-box { ... }`。

## 8. 开发热更新（devServer）

用 Vite 等工具开发时，manifest 加：

```json
{ "devServer": "http://localhost:5173" }
```

开发者模式下宿主直接从 dev server 加载视图（保存即热更新）。
仅对「加载本地插件目录」的插件生效且仅允许 localhost，正式安装的插件忽略此字段。

## 9. 打包与分发（.ctp）

```bash
node plugin-sdk/cli.cjs pack my-plugin
# ✓ 已打包 6 个文件 → my-plugin 同级目录/com.you.my-plugin-1.0.0.ctp
```

- `pack` 先跑与宿主一致的 manifest 校验 + 视图入口文件存在性检查，不过不出包
- 产物命名 `<id>-<version>.ctp`；自动排除 `node_modules`、`.git`、`.map`、旧 `.ctp`
- 用户侧安装：设置 → 插件 → 「安装插件」选择 `.ctp` 文件
- **升级规则**：同 id 覆盖安装；新版声明了新增权限时插件被自动禁用，
  用户重新启用时确认新权限清单
- 分发渠道推荐 GitHub Release 附件；插件市场与签名校验在规划中

## 10. 限额与安全模型

| 限制 | 值 | 说明 |
|---|---|---|
| RPC 频率 | 50 次/秒/插件 | 超出直接报错 |
| 并发调用 | 2 路/插件 | 排队自己控制，超出报错 |
| 调用超时 | 默认 10s | 媒体 30s、搜索 60s、AI/导出发起 120s、转写 180s |
| 消息单页 | ≤2000 行 | 强制游标分页 |
| AI 预算 | 20 次/分钟/插件 | 花的是用户 API 额度 |
| 存储 | 单值 256KB / 总量 5MB | 卸载时清除 |
| 媒体 URL | 5 分钟时效 | 绑定签发插件，勿持久化 |

安全边界（你写的代码逃不出去，也不用自己操心）：

- 插件运行在独立 origin 的沙箱 iframe，没有 Node、没有文件系统，
  所有能力经宿主 RPC 且受权限约束
- 无 `network` 权限时 CSP 阻止一切外联
- 解密密钥、账号凭据、AI API Key 永远不会暴露给插件
- 插件崩溃/死循环只影响自己的 iframe，宿主提供「重试」恢复

## 11. 故障排查 FAQ

### 如何调试插件

宿主的 DevTools 只在**从源码运行的开发版**（`npm run dev` 起的 CipherTalk）里可用；
**正式安装版禁用了 DevTools**（F12 / 右键「检查」都没有，与「插件开发者模式」无关）。
所以按场景选调试方式：

- **纯 UI / 样式 / 前端逻辑** → 用 `--vite` / `--react` 模板的独立 dev server：
  `npm run dev` 后浏览器直接打开它，Chrome DevTools 全功能断点、实时改样式。
  局限：`connect()` 依赖宿主握手，浏览器里不会 resolve，涉及 `api.*` 的代码会一直
  等待——把它们放在「已连接才执行」分支里，或先用假数据 mock。
- **完整联调（含 `api.*` 真实数据）** → 需要开发版宿主：从 CipherTalk 源码
  `npm run dev` 启动，`F12` 或 `Ctrl+Shift+I` 开 DevTools，在 Console / Sources
  顶部的 frame（iframe）下拉里切到插件帧（`localhost:5173` 或 `ct-plugin://…`）断点。
- **正式安装版里排错** → 没有 DevTools，用 `api.ui.toast()` 或直接在页面上渲染
  中间值来观察；关键状态可写进 `storage` 事后取。

配合 devServer 热更新（§8），第一条效率最高。

### 常见问题

**插件列表里显示"异常"** → 鼠标看红字原因：多为 manifest 校验失败
（缺 author.name、权限拼错、entry 文件不存在）。改完点「重新扫描」。

**页面空白 / 脚本不执行** → 沙箱 CSP 禁止内联 `<script>`，必须用
`<script type="module" src="./main.js">` 外部文件；脚本报错的排查见上方「如何调试插件」。

**调用报"缺少权限：xxx"** → manifest `permissions` 里没声明，或用户启用时
的清单是旧的——禁用后重新启用即可重新授权。

**调用报"调用频率超限/并发超限"** → 合并批量请求，不要循环逐条调；
消息用 `query` 的 limit+cursor 而不是逐条 `get`。

**fetch 外部接口失败** → 没有 `network` 权限（CSP 拦截，报错通常是
`Refused to connect`）。确认真的需要再申请。

**图片 `<img>` 不显示** → `media.getImage` 的 url 超时效（5 分钟）了，重新获取；
朋友圈/头像的 http CDN 地址需要 `network` 权限才能加载。

**下拉框弹出的是系统样式** → 没用 SDK 的 `connect()`（自动接管需要先握手），
或 select 上没有 `ct-select` 类。

**升级后插件被禁用了** → 新版本声明了新增权限，属预期行为，重新启用确认即可。

## 12. 示例

官方示例插件见 [`examples/plugins/ui-gallery/`](examples/plugins/ui-gallery/) —— **组件画廊**：

- `index.html` / `main.js` —— 把全部 `.ct-*` 组件渲染在一页：按钮 / 表单 /
  下拉（宿主接管弹层）/ 卡片 / 标签 / 骨架 / 进度 / Tabs / 菜单 / 弹窗，
  以及表格排序与柱状图，并用 `api.ui.toast()` 演示宿主交互。

零构建，照抄即用。把该目录作为本地插件加载（开发者模式 → 加载本地插件目录），
或 `node plugin-sdk/cli.cjs pack examples/plugins/ui-gallery` 打包后安装体验。

另有 [`examples/plugins/heroui-starter/`](examples/plugins/heroui-starter/) —— **HeroUI 示例**：
React 19 + Vite + HeroUI v3，用真正的 HeroUI 组件、主题随宿主自动切换（等价 `init --react`
产出的工程）。需 `npm install && npm run dev`，见该目录 README。
