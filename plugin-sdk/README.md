# ciphertalk-plugin-sdk

[CipherTalk（密语）](https://github.com/ILoveBingLu/CipherTalk) 插件开发套件——
一个包装齐全部开发所需：

| 入口 | 内容 |
|---|---|
| `ciphertalk-plugin-sdk` | 数据 API：聊天数据查询、媒体解密、语音转写、全文搜索、统计、导出、朋友圈、AI 等 |
| `ciphertalk-plugin-sdk/ui` | React UI 组件库：与宿主同观感、随主题切换暗色（react 为可选 peer） |
| `npx ciphertalk-plugin` | 脚手架 CLI：初始化模板、校验打包 `.ctp` |

插件是运行在沙箱中的纯前端应用，通过本 SDK 调用宿主能力。

> 运行环境：浏览器 / 打包器（Vite、esbuild、Rollup）。SDK 依赖 `window`、
> `MessageChannel` 等浏览器 API，不用于纯 Node 环境。

## 安装

```bash
npm install ciphertalk-plugin-sdk
```

或用脚手架直接起步（无需先安装）：

```bash
npx ciphertalk-plugin init my-plugin           # 纯静态骨架
npx ciphertalk-plugin init my-plugin --vite     # Vite + TypeScript 模板
```

## 快速使用

```ts
import { connect } from 'ciphertalk-plugin-sdk'

const api = await connect()
const { sessions } = await api.data.sessions.list({ limit: 20 })
console.log(`共 ${sessions.length} 个会话`)

// 列表默认懒加载：iterate() 自动翻页，遍历多少拉多少，无需管 offset/cursor
for await (const msg of api.data.messages.iterate({ sessionId, keyword: '合同' })) {
  console.log(msg.content)
}
```

## UI 组件（`ciphertalk-plugin-sdk/ui`）

宿主 `.ct-*` 样式类的 **React 薄封装**。组件**不自带 CSS**：观感、暗色、主题
切换全部由宿主在 `connect()` 握手时注入的统一样式库提供，因此天然与宿主一致。

> 不用 React 的插件不需要此入口：直接写 `<button class="ct-btn ct-btn-primary">`
> 等语义化 HTML + `.ct-*` 类即可（见插件开发指南 §6）。

```jsx
import { connect } from 'ciphertalk-plugin-sdk'
import { Button, Card, LazyList, ListItem } from 'ciphertalk-plugin-sdk/ui'

const api = await connect()   // connect 负责注入 .ct-* 样式与主题

function App() {
  return (
    <Card>
      <Button variant="primary" onClick={() => api.ui.toast('已保存')}>保存</Button>
      {/* 列表默认懒加载：接上 iterate()，滚动到底自动取下一批 */}
      <LazyList
        source={() => api.data.sessions.iterate()}
        renderItem={(s) => <ListItem key={s.sessionId}>{s.displayName}</ListItem>}
      />
    </Card>
  )
}
```

| 分类 | 组件 |
| --- | --- |
| 排版 | `Title` `Hint` `Label` |
| 表单 | `Button` `Input` `Textarea` `Select` `Switch` `Checkbox` |
| 展示 | `Card` `Divider` `Chip` `Badge` `Dot` `Code` `Spinner` `Skeleton` `Progress` `List` `ListItem` `Empty` |
| 交互 | `Tabs` `Menu` `MenuItem` `Dialog` |
| 数据 | `LazyList`（滚动懒加载）`DataTable`（排序 + 可选分页）`BarChart`（柱状图） |

图标不内置，推荐 [`@gravity-ui/icons`](https://gravity-ui.com/icons)（与宿主同款风格）。

## CLI

| 命令 | 作用 |
|---|---|
| `ciphertalk-plugin init <目录> [--vite]` | 创建插件骨架（开发者名称必填），`--vite` 生成 Vite+TS 模板 |
| `ciphertalk-plugin pack [目录]` | 校验 manifest + 打包为 `<id>-<version>.ctp` |

## API 一览

`data`（会话/联系人/消息）、`media`、`stt`、`search`、`stats`、`export`、
`sns`、`ai`、`ui`、`storage`、`clipboard`、`notify`、`window`、`events`。
每类能力对应一个权限，在 `manifest.json` 声明、用户启用时确认。

完整参考（manifest 全字段、全 API、权限清单、UI 组件、限额、FAQ）见主仓库
[PLUGIN_DEV_GUIDE.md](https://github.com/ILoveBingLu/CipherTalk/blob/main/PLUGIN_DEV_GUIDE.md)。

## 版本

- `API_VERSION` — 本 SDK 实现的插件 API 主版本，须与 `manifest.apiVersion` 一致
- `SDK_VERSION` — SDK 语义化版本
- `await api.capabilities()` — 运行时探测宿主支持的方法集，用于优雅降级

## 许可

CC-BY-NC-SA-4.0，随主项目。
