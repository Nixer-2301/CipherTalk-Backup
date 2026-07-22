# 📦 发布说明

## 触发方式

当前仓库不再使用本地 `npm run tuisong` 发布。

正式发布方式改为：

1. 修改 `package.json` 中的版本号（内部构建版本，规则见下方「版本号规则」）
2. 提交代码并推送到 `main`
3. 推送一个与版本号完全一致的 Git tag，例如：

```bash
git tag v2026.721.0
git push origin v2026.721.0
```

只有推送 `v*` 标签时，GitHub Actions 才会自动构建和发布。

## 本地测试（不提交密钥）

发布相关脚本支持从本地私有环境文件读取密钥与模型配置，读取顺序为：

1. 进程环境变量（例如手动 `set` / CI 注入）
2. 仓库根目录 `.release.local.env`
3. 仓库根目录 `.env.local`

可用键（按需填写）：

- `AI_API_KEY`
- `AI_API_URL`
- `AI_MODEL`
- `GH_TOKEN`

示例（文件不会被提交）：

```env
AI_API_KEY=sk-xxxx
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_MODEL=gpt-5.4
GH_TOKEN=ghp_xxxx
```

## GitHub Actions 会做什么

`.github/workflows/release.yml` 会在 `v*` 标签触发后执行：

当前工作流已拆成串并行 job：

- `prepare-meta`
- `build-windows`
- `generate-release-body`
- `publish-github-release`
- `mirror-r2`
- `notify-telegram-success`
- `notify-failure`

其中：

1. `prepare-meta` 生成 `force-update.json` 和 `release-context.json`
2. `build-windows` 负责构建安装包和 `latest.yml`
3. `generate-release-body` 负责 AI / 模板版发布说明
4. `publish-github-release` 汇总产物并创建 GitHub Release
5. `mirror-r2` 与 `notify-telegram-success` 在发布成功后并行执行

GitHub Release 上传内容：

- 安装包
- `latest.yml`
- `force-update.json`

Cloudflare R2 同步内容：

- 安装包
- `latest.yml`
- `force-update.json`

Telegram 通知：

- 成功时发送 AI 摘要通知
- 失败时发送失败通知

GitHub Release 资产包括：
   - 安装包
   - `latest.yml`
   - `force-update.json`
10. 向 Telegram 频道/群发送发布通知（AI 摘要 + 强制更新提醒）

## Windows 全量更新

当前 Windows 自动更新统一使用全量安装包下载。

依赖产物为：

- `CipherTalk-x.y.z-Setup.exe`
- `latest.yml`

工作流会在构建与发布阶段校验安装包和 `latest.yml` 的哈希是否一致，避免元数据与真实安装包不匹配。

说明：

- 当前仍是未签名发布
- 公开分发时稳定性仍可能受 SmartScreen / 杀软 / 系统策略影响
- 当前已禁用差分更新，客户端始终下载完整安装包

## 版本号规则

自 2026.7.21 起，内部构建版本与软件内展示版本分离：

### 内部构建版本（package.json / Git tag / 更新源）

格式：`年.月日.当日构建序号`，月日段**不带前导零**：

- 2026 年 7 月 21 日当天第一个版本：`2026.721.0`
- 同一天再发一个版本：`2026.721.1`
- 10 月 21 日的第一个版本：`2026.1021.0`

序号从 `0` 开始，跨天归零。

> ⚠️ 月日段不能写成 `0721`：semver 不允许数字段带前导零，
> `2026.0721.0` 会让 electron-updater 启动时直接抛
> "App version is not a valid semver version"，自动更新整体失效。
> 数值排序上 `721` 与 `0721` 等价（月份先行，天然有序），无需前导零。

### 软件内展示版本

由 `src/lib/appVersion.ts` 的 `formatDisplayVersion()` 从内部版本解析生成：

- 内部 `2026.721.0` → 展示 `v2026.7.21-构建版本号v0`
- 旧格式（如 `2026.7.20`）原样展示为 `v2026.7.20`

展示版本只在 UI 层使用；更新检查、latest.yml、force-update.json、
Git tag 一律使用内部构建版本。

## 版本要求

标签名必须与 `package.json.version` 完全对应：

- `package.json.version = 2026.721.0`
- Git tag 必须是 `v2026.721.0`

如果不一致，工作流会直接失败。

## 强制更新策略

工作流会调用：

```bash
npm run build:force-update-manifest
```

默认情况下不会触发强制更新。只有在仓库 Variables / Secrets 中提供以下值时，生成的 `force-update.json` 才会带上对应策略：

- `FORCE_UPDATE_MIN_VERSION`
- `FORCE_UPDATE_BLOCKED_VERSIONS`
- `FORCE_UPDATE_TITLE`
- `FORCE_UPDATE_MESSAGE`
- `FORCE_UPDATE_RELEASE_NOTES`

## Secrets / Variables

### Cloudflare R2 Secrets

需要在 GitHub 仓库配置以下 Secrets：

- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

### 可选强制更新 Variables / Secrets

可以按需配置：

- `FORCE_UPDATE_MIN_VERSION`
- `FORCE_UPDATE_BLOCKED_VERSIONS`
- `FORCE_UPDATE_TITLE`
- `FORCE_UPDATE_MESSAGE`
- `FORCE_UPDATE_RELEASE_NOTES`

不配置时，`force-update.json` 仍会生成，但只包含当前版本信息，不会强制用户升级。

### AI Release Body 配置

发布工作流会自动生成标准化 Release body。

需要在 GitHub Environment `软件发布` 中配置：

- `AI_API_KEY`
- `AI_API_URL`（可选）
- `AI_MODEL`（可选）

用途：
- 默认会调用当前配置的 AI 模型生成中文 Release 说明
- 自动生成中文 Release 说明
- 若 AI 不可用，会自动降级为模板正文，不影响发版

默认值：

- `AI_API_URL`: `https://api.openai.com/v1/chat/completions`
- `AI_MODEL`: `gpt-5.4`

### Telegram 通知配置

如果需要自动发 Telegram 通知，请在 GitHub Environment `软件发布` 中配置：

- Secret:
  - `TELEGRAM_BOT_TOKEN`

- Variable:
  - `TELEGRAM_CHAT_IDS`
  - `TELEGRAM_RELEASE_COVER_URL`（可选）

说明：
- `TELEGRAM_CHAT_IDS` 支持多个目标，用英文逗号分隔
- 可填写频道用户名或群/频道 chat_id
- 成功发布时会发送 AI 摘要版通知
- 发布失败时会发送失败通知

## 当前更新源角色

- **Cloudflare R2**：主更新源，负责客户端优先读取安装包、`latest.yml` 与 `force-update.json`
- **GitHub Release**：发布归档源 + 更新回退源
- **force-update.json**：R2 优先，GitHub 回退
