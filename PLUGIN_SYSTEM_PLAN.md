# CipherTalk 插件系统设计方案

> 目标：让第三方插件扩展 UI（侧边栏入口、设置 tab、聊天工具栏按钮、主区域页面、独立窗口）并使用数据查询能力。
> 两条硬约束：**不影响主进程性能（零卡顿）**、**不允许危险操作**。

## 0. 核心决策

### 决策一：首期采用「浏览器扩展模型」，插件无 Node 权限

插件 = `manifest.json` + 纯前端资源（HTML/JS/CSS），运行在 **sandboxed iframe** 中，
只能通过 postMessage RPC 调用宿主提供的 `PluginAPI`。

理由：
- **安全边界是真实的**。iframe 沙箱 + 独立 origin + CSP 是 Chromium 强制执行的隔离，
  不是靠约定。插件没有 fs / child_process / shell / require，"危险操作"从根上不存在，
  不需要靠代码审计兜底。
- **性能边界也是真实的**。插件 JS 跑在 iframe 自己的上下文里，死循环最多卡自己的 iframe，
  不卡主进程、不卡宿主渲染进程的核心交互。
- 对比方案（VS Code 式 Node 插件宿主）自由度更高，但在"聊天记录"这种敏感数据场景下，
  任意 Node 代码 + 数据读取权限 = 潜在的数据窃取器。列为三期再评估（见 §10）。

### 决策二：主进程零插件代码，只做路由与权限校验

主进程新增的唯一逻辑是一个轻量 RPC 路由器（校验 pluginId + 权限 → 转发给现有服务），
每次调用开销在微秒级。数据查询实际执行继续走现有 wcdb utilityProcess
（`electron/services/wcdbService.ts` 代理模式），本来就不在主进程算。

插件目录扫描、manifest 解析放在 `app.whenReady` 之后空闲时执行，不加启动耗时。

### 决策三：UI 贡献点声明式渲染，插件代码懒激活

菜单项、tab、按钮的渲染只读 manifest（一段 JSON），**不执行任何插件代码**。
只有用户真正打开插件视图时才创建 iframe（懒激活）。装 10 个插件不打开，
成本≈多解析 10 个 JSON 文件。

## 1. 插件形态与目录

```
<userData>/plugins/
  <plugin-id>/
    manifest.json
    dist/
      index.html        # 各视图入口（可多个 html）
      panel.html
      assets/...
```

开发模式：设置里允许添加"本地插件目录"（symlink 语义），改完刷新 iframe 即生效。

插件资源通过自定义协议 `ct-plugin://<plugin-id>/...` 提供（在
`electron/main/protocols.ts` 注册，仅允许读取该插件自己的目录，路径穿越直接拒绝）。
每个插件因此拥有独立 origin，天然互相隔离。

## 2. manifest.json

```jsonc
{
  "id": "com.example.word-stats",
  "name": "词频统计",
  "version": "1.0.0",
  "description": "统计会话高频词",
  "apiVersion": 1,                    // PluginAPI 主版本，宿主不兼容则拒绝加载
  "permissions": [
    "messages:read",                  // 见 §4 权限表
    "sessions:read"
  ],
  "contributes": {
    "sidebarMenus": [
      { "id": "main", "label": "词频统计", "icon": "chart-bar", "view": "index" }
    ],
    "settingsTabs": [
      { "id": "settings", "label": "词频统计", "view": "settings" }
    ],
    "chatToolbarButtons": [
      { "id": "analyze", "label": "分析本会话", "icon": "sparkles", "view": "panel" }
    ],
    "views": {
      "index":    { "entry": "dist/index.html" },
      "settings": { "entry": "dist/settings.html" },
      "panel":    { "entry": "dist/panel.html", "presentation": "drawer" }
    }
  }
}
```

- `icon` 用内置图标名（宿主的 lucide 图标集），不执行插件提供的代码来渲染图标。
- `view` 引用 `views` 里的 key；一个视图可被多个贡献点复用。

## 3. 进程与通信模型

```
┌─ 插件 iframe (sandboxed, origin: ct-plugin://<id>) ─┐
│  插件 JS ──(SDK)── postMessage / MessageChannel      │
└──────────────────────────┬──────────────────────────┘
                           │ 宿主渲染进程 PluginHost 组件
                           │  · 按 iframe 来源绑定 pluginId（不可伪造）
                           │  · 转发 RPC，透传插件上下文
                           ▼
              window.electronAPI.plugin.invoke(pluginId, method, args)
                           │ IPC
                           ▼
┌─ 主进程 pluginRouter（electron/main/ipc/pluginHandlers.ts）─┐
│  · 校验插件已启用 + method 所需权限已授予                     │
│  · 参数 schema 校验、配额/限流                               │
│  · 转发到现有服务（chatService / wcdbService / ...）          │
└─────────────────────────────────────────────────────────────┘
```

关键点：
- iframe 拿不到 `electronAPI`（sandbox + 跨 origin），所有能力必经宿主中转，
  pluginId 由宿主按 iframe 实例绑定，插件无法冒充别人。
- 每个 iframe 一条独立 `MessageChannel`，避免广播风暴。
- 提供一个小 SDK 包（`ciphertalk-plugin-sdk`，就是 postMessage 的类型化封装），
  插件开发者 `import { connect } from 'ciphertalk-plugin-sdk'` 即可，带完整 TS 类型。

## 4. 权限模型

> 原则：**软件的全部功能都开放给插件**，但每类能力对应一个权限项，由用户启用时授予。
> 沙箱限制的是"绕过宿主直接碰系统"，不限制"经宿主使用软件功能"。

| 权限 | 授予的能力 | 期数 |
|---|---|---|
| `sessions:read` | 会话列表、会话详情 | 一期 |
| `contacts:read` | 联系人、群成员、头像 | 一期 |
| `messages:read` | 消息查询（按会话/时间/关键词/发送者） | 一期 |
| `media:read` | 图片解密与缩略图、语音数据、表情、视频信息 | 二期 |
| `stt:use` | 语音转写（含读取已缓存转写文本） | 二期 |
| `search:use` | 全文搜索 | 二期 |
| `stats:read` | 统计分析（消息量、活跃度等现有统计能力） | 二期 |
| `export:use` | 调用导出（会话/联系人导出到用户选择的目录） | 二期 |
| `sns:read` | 朋友圈时间线与媒体 | 三期 |
| `ai:use` | 调用宿主已配置的 AI 能力（对话/嵌入，走用户自己的 key，插件不可见 key 本身） | 三期 |
| `notify:send` | 系统通知 | 二期 |
| `clipboard:write` | 写剪贴板 | 一期 |
| `window:create` | 打开独立插件窗口 | 二期 |
| `network` | iframe 允许外联 | 三期（默认禁，**CSP 强制**） |

无对应权限的 RPC 一律拒绝。权限粒度按"能力类别"而不是按单个方法，避免清单爆炸。

- 安装/启用插件时展示权限清单，用户确认后才启用；权限变更（升级后新增）需重新确认。
- **`network` 权限用 CSP 执行**，不是靠 RPC 拦截：无该权限的插件视图响应头带
  `Content-Security-Policy: default-src 'ct-plugin://<id>'`，连 `fetch` 外网都发不出去。
  这条是"数据不外泄"的真防线——就算插件读了聊天记录，也传不出去。
- 敏感数据（解密密钥、账号凭据、AI API key）**不设权限项**，任何插件都拿不到。

## 5. PluginAPI（全能力接口面，按期落地）

目标是把软件基本功能全部映射进来（对应现有 `chat:*` / `image:*` / `stt:*` /
`export:*` / `sns:*` / `video:*` / AI 等 IPC 能力），但**不透传内部通道**，
而是收敛成面向插件语义的稳定接口，内部重构不破坏插件。

```ts
// 全部异步，全部经 RPC。方法只加不删，破坏性变更升 apiVersion。
interface PluginAPI {
  // ===== 一期 =====
  data: {
    sessions: {
      list(opts?: Page): Promise<SessionSummary[]>
      get(sessionId: string): Promise<SessionDetail | null>
    }
    contacts: {
      list(opts?: Page): Promise<ContactSummary[]>
      get(wxid: string): Promise<ContactSummary | null>
      getAvatar(wxid: string): Promise<string | null>        // ct-plugin 可用的 URL
      getGroupMembers(chatroomId: string): Promise<ContactSummary[]>
    }
    messages: {
      query(opts: {
        sessionId: string
        startTime?: number; endTime?: number
        senderId?: string
        keyword?: string
        types?: MessageType[]
        limit?: number        // 上限 2000，默认 500
        cursor?: string       // 强制游标分页
      }): Promise<{ rows: PluginMessage[]; nextCursor?: string }>
      get(sessionId: string, messageId: string): Promise<PluginMessage | null>
      getDatesWithMessages(sessionId: string): Promise<string[]>
    }
  }
  ui: {
    toast(text: string, opts?: { type?: 'success' | 'error' }): void
    navigate(viewId: string): void
    openChat(sessionId: string, messageId?: string): Promise<void>  // 跳转宿主聊天页定位消息
  }
  storage: {                                 // 插件私有 KV，落在插件自己的数据目录
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  context: {                                 // 视图被打开时宿主注入的上下文
    current(): Promise<PluginContext>        // chatToolbarButton 打开的视图能拿到
  }                                          // { sessionId, sessionName, ... }
  clipboard: { write(text: string): Promise<void> }

  // ===== 二期 =====
  media: {
    getImage(msgRef: MessageRef, opts?: { thumbnail?: boolean }): Promise<string | null>  // 解密后 URL
    getVoice(msgRef: MessageRef): Promise<{ url: string; durationMs: number } | null>
    getEmoji(msgRef: MessageRef): Promise<string | null>
    getVideoInfo(msgRef: MessageRef): Promise<VideoInfo | null>
  }
  stt: {
    transcribe(msgRef: MessageRef): Promise<{ text: string }>       // 复用宿主 STT 配置与队列
    getCachedTranscript(msgRef: MessageRef): Promise<string | null>
  }
  search: {
    query(keyword: string, opts?: { sessionId?: string; limit?: number; cursor?: string }):
      Promise<{ rows: SearchHit[]; nextCursor?: string }>
  }
  stats: {
    messageCounts(opts: { sessionId?: string; groupBy: 'day' | 'month' | 'sender' }):
      Promise<StatRow[]>
  }
  export: {
    exportSession(sessionId: string, opts: ExportOptions): Promise<{ taskId: string }>
    onProgress(taskId: string, handler: (p: Progress) => void): () => void
  }
  notify: { send(title: string, body: string): Promise<void> }
  window: {
    open(viewId: string, opts?: { width?: number; height?: number }): Promise<void>
  }
  events: {
    on(event: 'sessionChanged' | 'newMessages' | 'themeChanged',
       handler: (e: unknown) => void): () => void
  }

  // ===== 三期 =====
  sns: {
    getTimeline(opts?: { wxid?: string; cursor?: string }): Promise<SnsPage>
  }
  ai: {
    // 走宿主已配置的模型与 key；插件只拿到结果，拿不到 key
    complete(opts: { prompt: string; system?: string }): Promise<{ text: string }>
    embed(texts: string[]): Promise<number[][]>
  }
}
```

- `PluginMessage` 等是专为插件定义的裁剪结构，不透传内部完整行。
- 媒体统一返回 `ct-plugin-media://` 一次性 URL（带 token、限本插件 origin 使用），
  避免把大二进制走 postMessage 序列化。
- `export` 沿用现有 exportProcessService 的 utilityProcess，插件只是发起方。

## 6. 插件 UI：与宿主同观感

iframe 隔离决定了插件不能直接 import 宿主运行时的组件实例，但观感一致性
不靠共享运行时，靠**共享组件库 + 共享 design tokens**（VS Code Webview 同款思路）：

1. **统一样式库由宿主注入**。握手时宿主把 `.ct-*` 组件样式（按钮/表单/卡片/
   表格等）注入插件页，插件写语义化 HTML + `.ct-*` 类即与宿主观感一致，零依赖。
2. **主题 tokens 由宿主注入**。连接时注入当前主题变量（色板、字体、圆角、
   暗/亮模式），用户切换主题时宿主实时推送 `theme` 消息，SDK 自动应用到插件页
   `:root`——无需插件开发者写一行适配代码。
3. **SDK 内置 UI 组件库**（`ciphertalk-plugin-sdk/ui` 子路径导出）：
   `.ct-*` 类的 React 薄封装（Button / Dialog / DataTable / LazyList 等，
   react 为可选 peer 依赖），让"做一个和宿主原生观感无差别的插件页"
   成为默认体验而不是高级技巧。
4. 插件也可以完全不用这套，自带任意框架（Vue/Svelte/原生）——tokens 仍然可用，
   只是组件得自己写。生态上不强绑技术栈。

## 7. 开发者工作流与分发

对标 Chrome 扩展 / Figma 插件的成熟流程：

```
npx ciphertalk-plugin init my-plugin --vite   # 脚手架：Vite + TS + SDK + 类型 + 示例视图
cd my-plugin && npm run dev    # 本地开发，HMR 热更新
npm run build                  # 产出 dist/ + manifest 校验
npm run pack                   # 打包成 <id>-1.0.0.ctp（zip）
```

- **开发模式**：设置 → 插件 → 「加载本地插件」指向项目目录。
  开发模式下 manifest 可声明 `devServer: "http://localhost:5173"`，
  PluginHost 直接加载 Vite dev server，**改代码即时热更新**，不用反复构建。
  （devServer 仅在用户显式开启"插件开发者模式"时允许，正式安装的插件忽略该字段。）
- **安装**：`.ctp` 文件拖入插件管理页或文件选择安装 = 校验 manifest + 解压到
  `<userData>/plugins/`。卸载 = 删目录 + 清权限与私有存储。
- **SDK 与文档**：`ciphertalk-plugin-sdk` 单包发布到 npm（类型化 API +
  `/ui` 组件库 + 脚手架 CLI）；官方文档含 quickstart、API reference、2~3 个完整示例插件
  （词频统计、会话导出增强、自定义面板），示例即模板。
- **版本兼容**：manifest `apiVersion` + SDK 内置运行时能力探测
  （`api.capabilities()` 返回宿主支持的方法集），插件可优雅降级。
- **分发**（三期）：插件市场 + zip 签名校验；在此之前社区通过 GitHub Release 分发
  `.ctp` 文件即可跑起来。

## 8. 性能防护（逐条对应"不卡顿"）

| 风险 | 防护 |
|---|---|
| 插件查询拖慢数据库 | 查询走 wcdb utilityProcess 现有队列；**每插件并发 ≤ 2**；单次查询超时 10s；宿主自身查询优先级高于插件 |
| 单次返回数据过大 | `limit` 硬上限 2000 行 + 序列化后 ≤ 4MB，超出截断并返回游标 |
| RPC 洪水 | 每插件 RPC 频率限制（如 50 次/秒），超限降速并告警 |
| 事件广播放大 | 事件按订阅分发（无订阅零成本）；`sessionChanged` 等高频事件节流 200ms |
| 插件 JS 卡 UI | 插件代码只在自己的 iframe 上下文执行；主区域插件页卡死不影响侧边栏/其他页面，提供"重载插件视图"按钮 |
| 启动变慢 | manifest 扫描延后到 ready 之后空闲期；渲染贡献点仅消费 JSON；iframe 懒创建 |
| 内存膨胀 | 离开插件视图 5 分钟后回收其 iframe（storage 持久化不受影响）；同时存活的插件 iframe 数量设上限 |

## 9. 宿主侧改造点（现有代码锚点）

| 贡献点 | 改造位置 | 方式 |
|---|---|---|
| 侧边栏菜单 | `src/components/Sidebar.tsx:82` `navItems` | 追加插件项（route 类型），路由至 `/plugin/:pluginId/:viewId` |
| 主区域视图 | `src/App.tsx:834` Routes | 新增 `<Route path="/plugin/:pluginId/:viewId" element={<PluginViewPage />} />`（内含 PluginHost iframe） |
| 设置 tab | `src/components/settings/SettingsLayout.tsx:33` `tabs` | tabs 数组拼接插件 tab，内容区渲染 PluginHost |
| 聊天工具栏 | `src/pages/chat/components/ChatHeader.tsx` | 头部追加插件按钮；点击打开 drawer 形态的 PluginHost，注入当前会话上下文 |
| 独立窗口 | `electron/main/windows/windowManager.ts:421` | 新增 `createPluginWindow(pluginId, viewId)`，沿用现有 `contextIsolation: true` 配置，加载 PluginHost 壳页面 |
| IPC | `electron/main/ipc/register.ts` + 新增 `pluginHandlers.ts` | 单一 `plugin:invoke` 通道 + 路由表，不逐 API 开 IPC 通道 |
| 协议 | `electron/main/protocols.ts` | 注册 `ct-plugin://`，含路径穿越防护与 CSP 头 |
| 管理入口 | 设置页新增「插件」tab | 列表/启用/禁用/卸载/权限查看，安装 = 解压到插件目录 |

新增模块：
- `electron/services/pluginManagerService.ts` — 扫描、manifest 校验、启用状态、权限存储
- `src/features/plugins/` — PluginHost 组件、RPC 桥、插件管理 UI
- `packages/plugin-sdk/`（或独立仓库）— 插件侧类型化 SDK

## 10. 分期计划

**第一期（骨架 + 数据全读取）**
1. pluginManagerService + `ct-plugin://` 协议 + 权限存储 → 验证：放置示例插件目录，启用后 manifest 被解析、未声明权限的 RPC 被拒
2. `plugin:invoke` 路由 + `data.*`（sessions/contacts/messages 全量读取）+ storage + toast + clipboard → 验证：示例插件查询消息并渲染，limit/超时/并发限制生效
3. 侧边栏菜单 + 主区域视图（PluginHost iframe 懒加载） → 验证：菜单出现、点击进入插件页、禁用后消失
4. 设置页「插件」管理 tab → 验证：启用/禁用/卸载/权限展示全流程
5. DX 基线：`create-ciphertalk-plugin` 脚手架 + SDK + `theme.css` 主题注入 + 开发者模式（本地目录 / devServer 热更新）+ 开发文档与示例插件 → 验证：按文档从零写出一个观感与宿主一致、支持 HMR 开发的插件

**第二期（功能能力开放 + 全部贡献点）**
- 贡献点补齐：设置 tab、聊天工具栏按钮 + 会话上下文注入、独立窗口
- 能力开放：`media`（图/语音/表情/视频）、`stt`、`search`、`stats`、`export`、
  `notify`、`events`、媒体一次性 URL 协议
- 验证：示例插件完成"选中会话 → 批量转写语音 → 统计词频 → 导出报告"完整链路

**第三期（生态与高阶能力）**
- `sns`、`ai` 能力开放；`network` 权限（默认禁，用户显式授予）
- 插件市场/分发签名
- 后端脚本能力（独立 utilityProcess + Node permission model 加固——仅当纯前端模型确实不够用时才做）

## 11. 与 skills / MCP 的关系

- **skills / MCP**：面向 AI Agent 的能力扩展（给模型用的工具）。
- **插件**：面向用户的 UI 与功能扩展（给人用的界面）。
- 互通留到三期：插件可在 manifest 声明注册 MCP 工具，桥接到现有 `mcpClientService`。
