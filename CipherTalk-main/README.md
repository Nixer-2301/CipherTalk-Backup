<div align="center">

<img src="welcome.jpg" alt="密语 CipherTalk" width="100%" />

# 🔐 密语 CipherTalk

**一款现代化的微信聊天记录查看与分析工具**

[![License](https://img.shields.io/badge/license-CC--BY--NC--SA--4.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2026.7.20-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows)]()
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron)]()
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Group-26A5E4.svg?logo=telegram)](https://t.me/CipherTalk)

[![使用教程](https://img.shields.io/badge/使用教程-阅读文档-000000?style=for-the-badge&logo=notion&logoColor=white)](https://ilovebinglu.notion.site/ciphertalk)

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [技术栈](#️-技术栈) • [贡献指南](#-贡献指南) • [许可证](#-许可证) • 
[Verified on MseeP](https://mseep.ai/app/d00c9dc5-12ec-4594-895c-342550430b11)

[MseeP.ai Security Assessment Badge](https://mseep.ai/app/ilovebinglu-ciphertalk)

[![oosmetrics 分析加速排名前 5](https://api.oosmetrics.com/api/v1/badge/achievement/c3d78809-e411-40e7-ba11-cc1d5ba76259.svg)](https://oosmetrics.com/repo/ILoveBingLu/CipherTalk)

---

</div>

## 💖 赞助支持

如果这个项目对你有帮助，欢迎通过爱发电支持我们的开发工作！

<div align="center">

<a href="https://afdian.com/a/ILoveBingLu">
  <img src="aifadian.jpg" alt="爱发电" width="300" />
</a>

你的支持是我们持续更新的动力 ❤️

</div>

---

## 开发者愿景

> 这不是一个只会读取聊天记录的工具。
>
> 我希望它能替人留住爱，提取证据，也守住每个人自己的数字人生。

### 1. 为思念留下可以触摸的温度

当亲人离世后，曾经的点点滴滴往往都留在逝者的手机里，手机也成了继续思念的唯一入口。我希望这款软件能把这些记录整理为真正属于家人的 **数字资产**: 一段反复叮嘱的文字，一条“儿子（闺女），爸（妈）想你了，啥时候回家呀，回来给你做你爱吃的！”的语音，一次平凡却再也无法重来的问候。

正如《寻梦环游记》中那句话所说：**死亡不是生命的终点，遗忘才是。** 愿技术能替你留住一点声音、一点温度，也留住一点未曾说完的爱。

### 2. 为不公保留足够有力的证据

当您遭遇不公、不平、不正，甚至被聊天中的恶意、羞辱、威胁反复消耗时，您不该只能忍受。我希望这款软件能帮您从海量记录中快速找出关键证据，把零散对话整理成清晰、完整、可追溯的 **事实链**，让每一句伤害都有据可查，让每一次压迫都有证可举。

人可以善良，但不该没有反击的凭据。

### 3. 让聊天记录真正回到用户手中

我也希望这款软件能帮助更多普通人重新掌握自己的 **数字人生**。聊天记录不该只是被困在某台设备里的碎片，它也可以是记忆的档案、关系的注脚、成长的年轮。

无论是回望过去、整理生活、备份重要信息，还是在关键时刻还原事实、保护自己，这些数据都应该真正属于用户，而不是在设备更换、账号异常或时间流逝中悄然消失。

---

## 🚀 快速开始

### 📋 环境要求

- **Node.js**: 22.12.0 或更高版本
- **操作系统**: Windows 10/11
- **内存**: 建议 4GB 以上

### 📦 安装依赖

```bash
npm install
```

### 🔧 开发模式

启动开发服务器（支持热重载）：

```bash
npm run dev
```

### 🧰 命令行子项目

`CipherTalk-CLI/` 是密语仓库内的独立 CLI 子项目，提供 `miyu` 命令骨架和基础数据链路。它属于同一个 Git 仓库，但拥有自己的 `package.json`、锁文件、依赖、测试、构建产物和单独发布工作流，不参与桌面端 Electron 构建。

**直接安装使用：**

## npm：

```bash
npm install -g ciphertalk-cli
miyu status
```

国内用户可使用 npmmirror 镜像加速：

```bash
npm install -g ciphertalk-cli --registry https://registry.npmmirror.com
```

更新：

```bash
npm install -g ciphertalk-cli@latest
```

卸载：

```bash
npm uninstall -g ciphertalk-cli
```

## pnpm：

```bash
pnpm add -g ciphertalk-cli
miyu status
```

更新：

```bash
pnpm update -g ciphertalk-cli
```

卸载：

```bash
pnpm remove -g ciphertalk-cli
```

桌面端打包配置已显式排除 `CipherTalk-CLI/**/*`，CLI 只通过自己的工作流单独构建和发布。

**参与开发：**

```bash
npm run cli:install
npm run cli -- status
npm run cli:typecheck
npm run cli:test
```

### 📦 构建应用

构建生产版本：

```bash
# 构建完整安装包
npm run build
```

构建产物位于 `release/` 目录。

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！无论是报告 Bug、提出新功能建议，还是提交代码改进。

---

## 📄 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证  
（知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议）

<div>

### ❌ 严格禁止

- 销售本软件或其修改版本
- 用于任何商业服务或产品
- 通过本软件获取商业利益

</div>

查看 [LICENSE](LICENSE) 文件了解完整协议内容。

---

## ⚠️ 免责声明

> **重要提示**
> 
> - 本项目仅供**学习和研究**使用
> - 请遵守相关**法律法规**和用户协议
> - 使用本项目产生的任何后果由**用户自行承担**
> - 请勿将本项目用于任何**非法用途**

---

## 🙏 致谢

感谢所有为开源社区做出贡献的开发者们！

特别感谢：
- **[WeFlow](https://github.com/hicccc77/WeFlow)** - 提供了部分功能参考
- **所有贡献者** - 感谢每一位为本项目做出贡献的开发者

## 🤝 Contributors
感谢所有贡献者

<a href="https://github.com/ILoveBingLu/CipherTalk/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ILoveBingLu/CipherTalk" />
</a>

---

## 📈 Star History

<div align="center">

<a href="https://www.star-history.com/#ILoveBingLu/CipherTalk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&legend=top-left" />
 </picture>
</a>

---

<sub>一鲸落，万物生 · 愿每一段对话都被温柔以待</sub>

<sub>❤️ by the CipherTalk</sub>

</div>


