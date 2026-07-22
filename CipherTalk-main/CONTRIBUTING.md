# 贡献指南

感谢你对密语 CipherTalk 项目的关注！我们欢迎社区贡献，让这个项目变得更好。

## 🤝 如何贡献

### 贡献领域

#### ✅ 欢迎贡献的领域

- **前端界面优化**
  - React 组件改进
  - UI/UX 优化
  - 响应式设计
  - 无障碍访问性改进

- **样式和主题**
  - 新主题色彩方案
  - CSS 动画效果
  - 图标和视觉元素
  - 深色模式优化

- **用户体验**
  - 交互流程优化
  - 错误提示改进
  - 加载状态优化
  - 快捷键支持

- **文档完善**
  - README 文档
  - 代码注释
  - 使用教程
  - API 文档

- **国际化**
  - 多语言支持
  - 本地化适配
  - 文本翻译

- **性能优化**
  - 组件渲染优化
  - 内存使用优化
  - 打包体积优化

## 📋 贡献流程

### 1. 准备工作

```bash
# Fork 项目到你的 GitHub 账号
# 克隆你的 fork
git clone https://github.com/ILoveBingLu/miyu.git
cd miyu

# 安装依赖
npm install

# 创建新分支
git checkout -b feature/your-feature-name
```

### 2. 开发环境

```bash
# 启动开发服务器
npm run dev

# 运行类型检查
npx tsc --noEmit

# 运行代码格式化
npx prettier --write src/
```

### 3. 提交代码

```bash
# 添加修改的文件
git add .

# 提交代码（请使用有意义的提交信息）
git commit -m "feat: 添加新的主题色彩方案"

# 推送到你的 fork
git push origin feature/your-feature-name
```

### 4. 创建 Pull Request

1. 在 GitHub 上打开你的 fork
2. 点击 "New Pull Request"
3. 选择目标分支（通常是 `main`）
4. 填写 PR 描述，说明你的修改内容
5. 提交 PR 等待审核

## 📝 代码规范

### TypeScript 规范

- 使用 TypeScript 严格模式
- 为所有函数和变量提供类型注解
- 使用接口定义复杂对象类型
- 避免使用 `any` 类型

```typescript
// ✅ 好的示例
interface UserInfo {
  id: string
  name: string
  avatar?: string
}

const getUserInfo = (userId: string): Promise<UserInfo> => {
  // 实现
}

// ❌ 避免的写法
const getUserInfo = (userId: any): any => {
  // 实现
}
```

### React 组件规范

- 使用函数组件和 Hooks
- 组件名使用 PascalCase
- Props 接口以组件名 + Props 命名
- 使用 memo 优化性能关键组件

```typescript
// ✅ 好的示例
interface ChatMessageProps {
  message: string
  timestamp: number
  sender: string
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message, timestamp, sender }) => {
  return (
    <div className="chat-message">
      <span className="sender">{sender}</span>
      <p className="content">{message}</p>
      <time className="timestamp">{new Date(timestamp).toLocaleString()}</time>
    </div>
  )
}

export default React.memo(ChatMessage)
```

### CSS/SCSS 规范

- 使用 BEM 命名规范
- 优先使用 CSS 变量
- 避免深层嵌套（最多 3 层）
- 使用语义化的类名

```scss
// ✅ 好的示例
.chat-message {
  padding: var(--spacing-md);
  border-radius: var(--border-radius);
  
  &__sender {
    font-weight: bold;
    color: var(--color-primary);
  }
  
  &__content {
    margin: var(--spacing-sm) 0;
    line-height: 1.5;
  }
  
  &--highlighted {
    background-color: var(--color-highlight);
  }
}
```

## 🐛 报告问题

### 提交 Issue 前请检查

1. 搜索现有 Issues，避免重复提交
2. 确保问题与开源部分相关
3. 提供详细的复现步骤
4. 包含系统环境信息

### Issue 模板

```markdown
## 问题描述
简要描述遇到的问题

## 复现步骤
1. 打开应用
2. 点击某个按钮
3. 看到错误信息

## 期望行为
描述你期望发生的情况

## 实际行为
描述实际发生的情况

## 环境信息
- 操作系统: Windows 11
- Node.js 版本: 18.17.0
- 应用版本: 1.0.1

## 截图
如果适用，请添加截图来帮助解释问题
```

## 🎯 优先级指南

我们特别欢迎以下类型的贡献：

### 高优先级
- 🐛 修复 UI 相关的 bug
- ♿ 无障碍访问性改进
- 🌍 国际化和本地化
- 📱 响应式设计优化

### 中优先级
- ✨ 新的 UI 组件
- 🎨 主题和样式改进
- 📖 文档完善
- 🔧 开发工具改进

### 低优先级
- 🧹 代码重构（需要充分理由）
- 📦 依赖更新
- 🎯 性能优化（需要基准测试）

## 📞 联系我们

如果你有任何问题或建议，可以通过以下方式联系我们：

- 🐛 GitHub Issues

## 🙏 致谢

感谢所有贡献者的努力！你们的贡献让这个项目变得更好。

---

再次感谢你的贡献！让我们一起打造更好的密语 CipherTalk！