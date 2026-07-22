# 设置界面重构 — 阶段 4~9 执行计划（交接文档）

> 本文档供另一个 AI（GPT）接手执行。阶段 0~3 已由前一个 AI 完成并通过 `tsc` 校验。
> 目标:把 3500 行的 `src/pages/SettingsPage.tsx` 按 tab 拆成独立组件,引入 zustand
> store 让每个 tab 只订阅自己的字段,消除"打字时整页重渲染"的卡顿。

---

## 0. 背景与痛点

`src/pages/SettingsPage.tsx` 原本是 3505 行单文件巨型组件,8 个 tab(外观/数据解密/
安全/语音转文字/AI/数据管理/激活/关于)的 UI 全部以内联 `render*Tab()` 函数写在同一组件里。

**卡顿主因**:组件持有 ~56 个 `useState`,`render*Tab()` 是闭包不是组件,React 无法跳过。
任意一次输入(打字)都会触发整个组件重渲染,重建所有 tab 的 JSX 子树。

**解决方案**:每个 tab 拆成独立组件;配置字段集中进 zustand store,各 tab 只用
**叶子选择器**订阅自己的字段 —— 打字时只有当前 tab 重渲染。

---

## 1. 已完成(阶段 0~3)—— 不要重复、不要破坏

已创建目录 `src/components/settings/`:

| 文件 | 说明 |
|------|------|
| `settingsStore.ts` | zustand store,**已写好但尚未接入**。含 37 字段的 `SettingsConfig`、`DEFAULT_SETTINGS_CONFIG`、`hydrate`/`setField`/`commit`/`reset`,以及逐字段浅比较的 dirty-check。 |
| `BackgroundFx.tsx` | 粒子背景,`React.memo` + 模块级数组,整页只渲染一次。已接入。 |
| `utils.ts` | `formatFileSize` / `formatSpeed`。 |
| `types.ts` | `UpdateInfo` 类型。 |
| `tabs/AboutTab.tsx` | 关于 tab。已接入。 |
| `tabs/ActivationTab.tsx` | 激活 tab,自带 `useActivationStore`。已接入。 |
| `tabs/SecurityTab.tsx` | 安全 tab,自带 `useAuthStore`,内部本地 `securityConfirm`。已接入。props:`isMac`、`showMessage`。 |

`SettingsPage.tsx` 已做的改动:
- 抽出 About / Activation / Security 三个 tab,粒子背景换成 `<BackgroundFx />`。
- `SettingsPage.scss` 加了 `@media (prefers-reduced-motion: reduce)` 关闭 aurora 动画。
- **重要**:`securityConfirm` 这个确认弹窗 state **保留在 SettingsPage 外壳层**(不是
  SecurityTab 的那个)。原因:`handleDeleteAccount`、`handleDeleteAccountWithLocalData`、
  `handleClearCurrentAccountConfig`、`handleClearAllAccountConfigs` 这 4 个数据库账号操作
  也在用它,且其弹窗 JSX 已被移到外壳层的 `return` 里(紧挨 `showClearDialog` 弹窗)。
  **阶段 7 抽 DatabaseTab 时,这个 state 要继续留在外壳或一并下放,见阶段 7。**

---

## 2. 核心架构:settingsStore

`src/components/settings/settingsStore.ts` 已定义好,直接用。关键 API:

```ts
import { useSettingsStore, type SettingsConfig, DEFAULT_SETTINGS_CONFIG } from '../settingsStore'

// 读单个字段(tab 组件里这样用 —— 只订阅叶子,实现 tab 间渲染隔离):
const decryptKey = useSettingsStore(s => s.config.decryptKey)
// 写:
const setField = useSettingsStore(s => s.setField)
setField('decryptKey', 'xxx')
// dirty 标记(浮动保存按钮用):
const hasUnsavedChanges = useSettingsStore(s => s.hasUnsavedChanges)
// 非响应式读取(在 handler / 保存函数里):
const config = useSettingsStore.getState().config
// 加载后:
useSettingsStore.getState().hydrate(fullConfigObject)
// 保存成功后:
useSettingsStore.getState().commit()
```

**绝对规则**:tab 组件**只能**订阅叶子字段 `s => s.config.xxx`,**绝不能**订阅整个
`s => s.config` 对象 —— 否则任意字段变化都会重渲染该组件,卡顿修复失效。

`SettingsConfig` 的 37 个字段(已在 store 里定义,与原 `initialConfig` 完全对应):

```
database 切片: decryptKey, dbPath, wxid, cachePath, imageXorKey, imageAesKey,
  editingAccountId, skipIntegrityCheck, autoUpdateDatabase, autoUpdateCheckInterval,
  autoUpdateMinInterval, autoUpdateDebounceTime
stt 切片: sttLanguages, sttModelType, sttMode, sttOnlineProvider, sttOnlineApiKey,
  sttOnlineBaseURL, sttOnlineModel, sttOnlineLanguage, sttOnlineTimeoutMs,
  sttOnlineMaxConcurrency
ai 切片: aiProvider, aiApiKey, aiModel, aiDefaultTimeRange, aiSummaryDetail,
  aiSystemPromptPreset, aiCustomSystemPrompt, aiEnableThinking, aiMessageLimit,
  aiAgentDecisionMaxTokens, aiAgentAnswerMaxTokens
appearance/misc 切片: quoteStyle, exportPath, exportDefaultDateRange,
  exportDefaultAvatars, closeToTray
```

---

## 3. 阶段 4:把 37 个配置字段整体迁入 store(关键阶段)

> 原计划是逐字段并行迁移,但实践中"旧 useEffect + 新 store dirty-check 并行"很容易出错。
> **推荐:一次性把全部 37 个 config 字段迁入 store**,再逐 tab 抽组件。中间态更少、更安全。

`SettingsPage.tsx` 里需要改的关键位置(行号会变,执行前先 `grep` 重新定位):

### 3.1 删除 37 个配置字段的 `useState`,改为 store

当前这些字段是组件内 `useState`(约 115~214 行附近)。把它们**全部删掉**,改成:

```ts
const config = useSettingsStore(s => s.config)
const setField = useSettingsStore(s => s.setField)
```

为了让现存的 `renderAppearanceTab` / `renderDatabaseTab` / `renderSttTab` /
`renderDataManagementTab` 以及大量 handler 不必逐行重写,**在组件内建立同名别名**:

```ts
const { decryptKey, dbPath, wxid, cachePath, imageXorKey, imageAesKey, exportPath,
  sttLanguages, sttModelType, sttMode, sttOnlineProvider, sttOnlineApiKey,
  sttOnlineBaseURL, sttOnlineModel, sttOnlineLanguage, sttOnlineTimeoutMs,
  sttOnlineMaxConcurrency, skipIntegrityCheck, autoUpdateDatabase,
  autoUpdateCheckInterval, autoUpdateMinInterval, autoUpdateDebounceTime,
  quoteStyle, exportDefaultDateRange, exportDefaultAvatars, aiProvider, aiApiKey,
  aiModel, aiDefaultTimeRange, aiSummaryDetail, aiSystemPromptPreset,
  aiCustomSystemPrompt, aiEnableThinking, aiMessageLimit, aiAgentDecisionMaxTokens,
  aiAgentAnswerMaxTokens, closeToTray, editingAccountId } = config
```

然后用包装函数顶替原 setter(**注意原 setter 命名**:STT/AI 字段的 setter 多带 `State`
后缀,如 `setAiProviderState`、`setSttLanguagesState`;其余如 `setDecryptKey`、
`setQuoteStyle` 无后缀。包装函数名要和现有调用点一致):

```ts
const setDecryptKey = (v: string) => setField('decryptKey', v)
const setQuoteStyle = (v: SettingsConfig['quoteStyle']) => setField('quoteStyle', v)
const setAiProviderState = (v: string) => setField('aiProvider', v)
const setSttLanguagesState = (v: string[]) => setField('sttLanguages', v)
// ……37 个字段全部照此包装,函数名严格对齐原 useState 的 setter 名
```

> 先 `grep` 出每个字段原本的 setter 名(`grep -n "set[A-Z]" src/pages/SettingsPage.tsx`),
> 逐一对照,避免漏改或改错名。

⚠️ `editingAccountId` 当前是独立 `useState`(约 92 行),也要并入 store。但它被
`setEditingAccountId` 在多处调用(账号切换),包装成 `setField('editingAccountId', v)`。

### 3.2 改写 `loadConfig`(约 304~443 行)

原 `loadConfig` 末尾用 `setInitialConfig({...37字段...})` 存基线。改为:
1. 中间那些 `setDecryptKey(...)`、`setSttModelType(...)` 等逐字段赋值**全部删掉**。
2. 末尾构造完整的 `SettingsConfig` 对象,调用 `useSettingsStore.getState().hydrate(cfg)`。
   `hydrate` 会同时设置 `config` 和 `initialConfig` 基线。
3. 保留非 config 的副作用:`setIsAccountVerified(...)`、`setDefaultExportPath` 等仍是
   普通 `useState`,不动。
4. ⚠️ 注意原逻辑里的条件赋值 `if (!editingAccount && savedKey) setDecryptKey(savedKey)`
   —— 含义是"有正在编辑的账号时,用账号里的密钥,否则才用全局保存值"。迁移到 store 时
   要保留这个优先级:hydrate 的对象里,这 6 个账号字段(decryptKey/dbPath/wxid/
   cachePath/imageXorKey/imageAesKey)取值应为 `editingAccount?.xxx ?? savedXxx ?? ''`。

### 3.3 `applyAccountToForm`(约 283~292 行)

这个函数切换账号时会写 6 个账号字段(`setDecryptKey` 等)。由于 setter 已被包装成
`setField`,函数体基本不用改,但要确认每个 `setXxx` 调用都走到了包装函数。

### 3.4 删除旧 dirty-check `useEffect`(约 455~512 行)

整个 `useEffect`(构造 `currentConfig` + `JSON.stringify` 比较 + `setHasUnsavedChanges`)
**整段删除**。dirty 检测现在由 store 的 `setField` 自动完成。

同时删除 `const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)` 和
`const [initialConfig, setInitialConfig] = useState<any>(null)`(约 196~197 行)。
浮动保存按钮改读 `const hasUnsavedChanges = useSettingsStore(s => s.hasUnsavedChanges)`。

### 3.5 改写 `handleSaveConfig`(约 1282~1403 行)

⚠️ **关键**:`handleSaveConfig` **并非**把 37 个字段全部 `configService.setXxx`。仔细对照
原函数,它实际做的是:
- 6 个账号字段(decryptKey/dbPath/wxid/cachePath/imageXorKey/imageAesKey)通过
  `buildAccountPayload()` + `configService.updateAccount/saveAccount` 保存,**不是**
  逐字段 setXxx。
- `sttModelType`、`sttLanguages` **没有**在 `handleSaveConfig` 里保存(它们在各自的
  切换 handler 里即时保存,见 `handleSttModelTypeChange` 等)。
- 其余字段才走 `configService.setXxx`。

**改法**:函数开头 `const config = useSettingsStore.getState().config` 一次性取值,把原本
读组件变量的地方改成读 `config.xxx`;末尾的 `setInitialConfig({...})` + `setHasUnsavedChanges(false)`
整体替换为 `useSettingsStore.getState().commit()`。**保持持久化字段集合与原函数完全一致**,
不要新增或删减保存项。

### 3.6 抽出 `AppearanceTab`

`renderAppearanceTab`(约 1405~1513 行)。新建 `src/components/settings/tabs/AppearanceTab.tsx`。
它用到:
- `themeMode` / `currentTheme` / `setThemeMode` / `setTheme` / `themes` —— 来自
  `useThemeStore`(`src/stores/themeStore.ts`),组件内直接 `import { useThemeStore, themes }`。
- `quoteStyle` / `closeToTray` —— 改为 store 叶子选择器 + `setField`。
- 图标 `Sun, Moon, Monitor, Check`（已迁移到 `@gravity-ui/icons` 对应图标）。

`AppearanceTab` 无需 props(全部自取 store)。`SettingsPage` 里 `renderAppearanceTab` 删除,
`{activeTab === 'appearance' && renderAppearanceTab()}` 换成 `<AppearanceTab />`。

阶段 4 完成后 `npx tsc --noEmit` 必须通过。

---

## 4. 阶段 5:AI tab 迁到 store

AI tab 当前直接渲染 `<AISummarySettings .../>`(在 `SettingsPage.tsx` 的 `return` 里,
约 3032~3058 行),通过约 26 个 prop 把状态和 setter 透传进去:

```
provider/setProvider, apiKey/setApiKey, model/setModel, defaultTimeRange/setDefaultTimeRange,
summaryDetail/setSummaryDetail, systemPromptPreset/setSystemPromptPreset,
customSystemPrompt/setCustomSystemPrompt, enableThinking/setEnableThinking,
messageLimit/setMessageLimit, agentDecisionMaxTokens/setAgentDecisionMaxTokens,
agentAnswerMaxTokens/setAgentAnswerMaxTokens, showMessage
```

**两种做法,推荐 B**:
- A. 保持 `AISummarySettings` 的 props 不变,继续从 `SettingsPage` 传(阶段 4 后这些值
  已来自 store 别名,能直接传)。改动最小,但 AI tab 仍随 SettingsPage 重渲染。
- B. 改 `src/components/ai/AISummarySettings.tsx`:删掉那 11 对 value/setter props,组件内
  改用 `useSettingsStore(s => s.config.aiXxx)` 叶子选择器 + `setField`。`showMessage` 仍作
  prop 传入。`SettingsPage` 里只剩 `<AISummarySettings showMessage={showMessage} />`。
  这样 AI tab 真正独立,符合卡顿修复目标。

注意 `AISummarySettings` 内部 prop 名没有 `ai` 前缀(如 `provider`),store 字段有(`aiProvider`),
做 B 时映射好即可。

---

## 5. 阶段 6:抽出 DataManagementTab

`renderDataManagementTab`(`grep -n "renderDataManagementTab"` 定位)。新建
`src/components/settings/tabs/DataManagementTab.tsx`。

涉及内容:导出设置、缓存大小卡片、日志查看器。
- **进 store 的字段**(已在 SettingsConfig):`exportPath`、`exportDefaultDateRange`、
  `exportDefaultAvatars`。组件内用叶子选择器。
- **留作本地 `useState`**(不参与 dirty-check,且体量大/瞬时):`cacheSize`、
  `isLoadingCacheSize`、`logFiles`、`selectedLogFile`、`logContent`、`isLoadingLogs`、
  `isLoadingLogContent`、`logSize`、`currentLogLevel`。这些以及它们的加载/清理 handler
  (`loadCacheSize`、`loadLogFiles`、`loadLogContent`、`handleClearLogs`、`handleClear*`
  缓存清理等)一并移入 `DataManagementTab`。
- `formatFileSize` 从 `../utils` import。
- 清理缓存的确认弹窗用的是 `showClearDialog`(外壳层 state)——见阶段 7 决策,
  建议把 `showClearDialog` + `confirmClear` 也一起下放或保留在外壳并传 props。
- `defaultExportPath`、`appVersion` 等若被用到,作 prop 传入或自行加载。

依赖较多,抽的时候逐个 handler 跟着搬,搬完 `grep` 确认 `SettingsPage` 里不再有悬空引用。

---

## 6. 阶段 7:抽出 DatabaseTab(最重之一)

`renderDatabaseTab`。新建 `src/components/settings/tabs/DatabaseTab.tsx`。

涉及:账号管理、缓存目录、解密密钥、wxid 扫描、图片密钥、账号验证。约 350 行 handler。
- **进 store**:6 个账号字段 + `editingAccountId` + `skipIntegrityCheck` +
  `autoUpdateDatabase` + 3 个 autoUpdate 高级参数。用叶子选择器。
- **留本地 `useState`**:`accountsList`、`activeAccountId`、`wxidOptions`、
  `showWxidDropdown`、`isScanningWxid`、`isAccountVerified`、`isVerifyingAccount`、
  `showDecryptKey`、`showXorKey`、`showAesKey`、`keyStatus`、`isGettingKey` 等。
- 相关 handler 全部搬入:`buildAccountPayload`、`applyAccountToForm`、
  `refreshAccountsState`、`handleSelectAccountForEdit`、`handleSwitchAccountAndReconnect`、
  `handleDeleteAccount`、`handleDeleteAccountWithLocalData`、`handleClearCurrentAccountConfig`、
  `handleClearAllAccountConfigs`、`handleVerifyAccountDirectory`、`handleGetKey`、
  `handleSelectDbPath`、`handleScanWxid` 等(`grep` 把数据库相关 handler 找全)。
- ⚠️ `securityConfirm`(外壳层那个,不是 SecurityTab 内的)被 `handleDeleteAccount` 等
  4 个 handler 使用。把这 4 个 handler 搬进 DatabaseTab 时,**把 `securityConfirm` state
  和它的弹窗 JSX 一并下放到 DatabaseTab**(它本就只服务账号操作)。下放后,从
  `SettingsPage` 外壳删掉 `securityConfirm` state 和那段弹窗 JSX。
- `handleSaveConfig` 里账号保存部分(`buildAccountPayload` + `updateAccount/saveAccount`)
  与 DatabaseTab 耦合 —— 见阶段 9 关于保存按钮的说明,这部分保存逻辑要么留在
  `useSettingsConfig` 统一 `saveConfig`,要么协调好。建议保存逻辑统一收口(阶段 9)。
- `isMac`、`platformInfo`、`userInfo`(`useAppStore`)按需 prop 传入或自取。

DatabaseTab 体量大,务必抽完后 `tsc` 通过再继续。

---

## 7. 阶段 8:抽出 SttTab(最重,~748 行)

`renderSttTab`。新建 `src/components/settings/tabs/SttTab.tsx`。
- **进 store**:`sttLanguages`、`sttModelType`、`sttMode`、`sttOnlineProvider`、
  `sttOnlineApiKey`、`sttOnlineBaseURL`、`sttOnlineModel`、`sttOnlineLanguage`、
  `sttOnlineTimeoutMs`、`sttOnlineMaxConcurrency`。叶子选择器。
- **留本地**:`showSttOnlineLanguageDropdown` + `sttOnlineLanguageRef`、模型下载相关的
  瞬时状态(`isDownloading`/进度/模型状态等)、`isTesting` 等。
- 搬入相关 handler:`handleSttModeChange`、`handleTestOnlineSttConfig`、
  `handleDownloadSttModel`、`handleSttLanguageToggle`、`handleSttModelTypeChange` 等。
- 模块级常量 `sttLanguageOptions`、`sttModelTypeOptions`、`sttOnlineLanguageOptions`、
  `sttOnlineProviderOptions`、`STT_ONLINE_DEFAULTS`(`SettingsPage.tsx` 顶部 33~74 行)
  移到 `SttTab.tsx` 或共享文件。
- 顶部那个监听点击外部关闭下拉的 `useEffect`(约 219~233 行,依赖
  `showSttOnlineLanguageDropdown`)一并移入 `SttTab`。

完成后:`SettingsPage.tsx` 里所有 `render*Tab` 函数应已全部删除。

---

## 8. 阶段 9:SettingsPage 瘦身 + 懒加载 + SCSS 拆分

### 8.1 统一保存逻辑

新建 `src/components/settings/useSettingsConfig.ts`,容纳 `loadConfig` 和 `saveConfig`
(即原 `handleSaveConfig` 主体)。`saveConfig` 从 `useSettingsStore.getState().config`
取值持久化,末尾 `commit()`。账号保存部分(`buildAccountPayload`)若已下放 DatabaseTab,
需协调:可让 `saveConfig` 也从 store 的账号字段构造 payload(store 已有这 6 个字段 +
`editingAccountId`),保持单一保存出口。

### 8.2 SettingsPage 变薄

最终 `SettingsPage.tsx`(或新建 `src/components/settings/SettingsLayout.tsx` 承载外壳,
`SettingsPage.tsx` 仅 `export default () => <SettingsLayout />`)只负责:
- tab 栏(`tabs` 数组 + 按钮)
- `<BackgroundFx />`
- `message` toast、`showClearDialog` 弹窗(若未下放)
- 浮动保存按钮:`onClick={saveConfig}`,`className` 读 `hasUnsavedChanges`
- tab body:`{activeTab === 'xxx' && <XxxTab />}`

### 8.3 懒加载

对重型 tab 用 `React.lazy` + 一个 `<Suspense fallback={...}>` 包住 tab body:
- 懒加载:`SttTab`、`DatabaseTab`、`DataManagementTab`、`AISummarySettings`。
- 保持 eager:`AppearanceTab`、`SecurityTab`、`ActivationTab`、`AboutTab`(体量小)。

```tsx
const SttTab = lazy(() => import('../components/settings/tabs/SttTab'))
// ...
<Suspense fallback={<div className="tab-content">加载中...</div>}>
  {activeTab === 'stt' && <SttTab />}
  {/* ... */}
</Suspense>
```

仓库目前无任何 `React.lazy`/`Suspense`,这是首次引入。

### 8.4 SCSS 拆分(可选,最后做)

`src/pages/SettingsPage.scss`(~3560 行)按 tab 拆成 `src/components/settings/styles/`
下的 partials:`_shared.scss`(页面外壳/tab 栏/按钮/表单/toast/弹窗/粒子+aurora)、
`_appearance.scss`、`_database.scss`、`_security.scss`、`_stt.scss`、`_data.scss`、
`_activation.scss`、`_about.scss`。**整块原样搬移、不改写选择器**。各 tab 组件 import
自己的 partial,外壳 import `_shared.scss`。若时间紧,这步可跳过,样式留在原文件也能正常工作。

---

## 9. 通用注意事项 / 坑

1. **行号会漂移**:每改一处行号都变。执行任何编辑前先 `grep -n` 重新定位目标。
2. **叶子选择器铁律**:tab 组件订阅 `s => s.config.xxx`,绝不订阅 `s => s.config`。
3. **setter 命名**:STT/AI 字段原 setter 多带 `State` 后缀;包装函数名必须和现存调用点
   逐一对齐,否则编译报错或漏改。
4. **保存字段集合不变**:`handleSaveConfig`/`saveConfig` 持久化的字段集合必须和原函数
   完全一致 —— 账号 6 字段走 account payload,`sttModelType`/`sttLanguages` 不在这里存。
   不要"顺手补全"。
5. **`securityConfirm` 有两个**:SecurityTab 内部有一个本地的(认证方式切换确认),
   SettingsPage 外壳有另一个(账号操作确认)。不要混淆。外壳那个在阶段 7 下放到 DatabaseTab。
6. **每个阶段结束跑 `npx tsc --noEmit`**,必须零错误再进下一阶段。命令在仓库根目录执行。
7. 仓库无自动化 UI 测试。每阶段后应由人工启动 Electron 应用(`npm run dev`)逐 tab 冒烟:
   打开每个 tab UI 正常;改字段→浮动按钮变"有改动"→保存→标记清除→重开值已持久化。
8. **不要改** `electron/` 下的主进程代码、`src/services/config.ts`(持久化层原样复用)、
   路由表。重构只在渲染层。
9. zustand 版本用 `create<T>()(...)` 写法(见 `src/stores/themeStore.ts`)。

---

## 10. 验收标准

- `npx tsc --noEmit` 零错误。
- `SettingsPage.tsx` 不再有任何 `render*Tab` 函数,行数从 3500 降到几百行以内。
- 8 个 tab 全部为独立组件文件,UI 与重构前一致。
- **卡顿验收**:打开语音转文字 tab,在 API Key 输入框快速打字,用 React DevTools
  Profiler 确认**只有 SttTab 重渲染**,DatabaseTab/DataManagementTab 不重渲染。
- 保存/未保存检测:每个 tab 各改一个字段都能正确触发浮动按钮、保存后持久化、
  改回原值后标记清除。
