# HeroUI 示例插件

用**真正的 HeroUI v3 组件**写 CipherTalk 插件的最小模板：React 19 + Vite 6 +
HeroUI v3 + Tailwind v4，主题（含暗色）随宿主自动切换。

> 插件跑在隔离 iframe 里，无法共享宿主的 React 组件实例——所以这里是插件
> **自带一份 HeroUI**（打进自己的 bundle）。宿主在握手时注入了全套主题变量，
> 因此自带的 HeroUI 观感与宿主一致。见 `src/styles.css` 的桥接说明。

## 开发

```bash
npm install
npm run dev           # http://localhost:5173，HMR 热更新
```

然后在 CipherTalk：设置 → 插件 → 打开「插件开发者模式」→ 加载本目录。
manifest 里声明了 `devServer`，开发模式会直接走 dev server，改代码即时热更新。

> vite base 按模式切换：dev 用 `/dist/`（对齐 manifest 的 `dist/index.html`
> 入口，HMR 才命中），build 用 `./`（走 ct-plugin 相对路径）。见 `vite.config.ts`。

## 打包安装

```bash
npm run pack          # tsc + vite build → dist/，再打包成 <id>-<version>.ctp
```

生成的 `.ctp` 在设置 → 插件 → 安装插件 导入即可。

## 主题一致的原理

1. `connect()`（`src/main.tsx`）完成宿主握手，宿主把 documentElement 上「当前
   主题算好的」全套 CSS 变量注入本 iframe，并打 `.dark` class、切主题时实时重注入。
2. `src/styles.css` 把 HeroUI 的语义色 `--color-*` 映射到这些宿主变量，并把
   dark variant 绑到 `.dark`。

于是 HeroUI 组件的颜色 = 宿主当前主题色，暗色自动跟随，无需插件写任何主题代码。

## 用别的组件库？

同理：任何前端库都可以打进插件自己的 bundle。要和宿主主题一致，用宿主注入的
CSS 变量取色即可（`var(--background)` / `var(--accent)` / `var(--foreground)` …）。

不想引 React/HeroUI 的轻量插件，可改用宿主注入的 `.ct-*` 类或 SDK 自带的组件库
`ciphertalk-plugin-sdk/ui`（见插件开发指南 §6）。
