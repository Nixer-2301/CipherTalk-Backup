# Ollama 本地 AI 使用指南

## 什么是 Ollama？

Ollama 是一个开源的本地大模型运行工具，可以在你的电脑上运行各种开源大模型，完全免费且数据不会上传到云端。

## 安装 Ollama

### Windows

1. 访问 [Ollama 官网](https://ollama.com/)
2. 下载 Windows 安装包
3. 运行安装程序
4. 安装完成后，Ollama 会自动在后台运行

### 验证安装

打开命令行（CMD 或 PowerShell），输入：

```bash
ollama --version
```

如果显示版本号，说明安装成功。

## 下载模型

Ollama 支持多种开源模型，推荐以下几个：

### 1. Qwen2.5（通义千问）- 推荐
```bash
ollama pull qwen2.5:latest
```

### 2. DeepSeek R1（深度求索）
```bash
ollama pull deepseek-r1:latest
```

### 3. Llama 3.3（Meta）
```bash
ollama pull llama3.3:latest
```

### 4. Gemma 2（Google）
```bash
ollama pull gemma2:latest
```

## 在密语中配置 Ollama

1. 打开密语设置页面
2. 切换到「AI 接入」标签
3. 选择「Ollama (本地)」提供商
4. 配置项说明：
   - **API 密钥**：本地服务无需密钥，可留空或随意填写
   - **服务地址**：默认为 `http://localhost:11434/v1`，通常无需修改
   - **选择模型**：从下拉列表选择已下载的模型，或手动输入模型名称

5. 点击「测试连接」按钮验证配置
6. 如果连接成功，即可开始使用

## 常见问题

### Q: 提示"Ollama 服务未启动"

**A:** 确保 Ollama 已安装并在后台运行。可以尝试：
- 重启 Ollama 服务
- 在命令行运行 `ollama serve`

### Q: 模型列表中没有我想要的模型

**A:** 你可以手动输入模型名称。Ollama 支持的所有模型可以在 [Ollama 模型库](https://ollama.com/library) 查看。

### Q: 生成摘要很慢

**A:** 本地运行模型的速度取决于你的硬件配置：
- **CPU 模式**：速度较慢，适合小模型
- **GPU 加速**：需要 NVIDIA 显卡，速度快很多

推荐配置：
- 至少 8GB 内存
- NVIDIA 显卡（可选，但强烈推荐）

### Q: 如何切换到 GPU 模式？

**A:** Ollama 会自动检测并使用 GPU。如果你有 NVIDIA 显卡且安装了 CUDA，Ollama 会自动使用 GPU 加速。

### Q: 修改了端口怎么办？

**A:** 如果你修改了 Ollama 的默认端口（11434），在密语的「服务地址」中修改为对应的地址即可，例如：
- `http://localhost:8080/v1`
- `http://192.168.1.100:11434/v1`（远程服务器）

## 优势

✅ **完全免费**：无需购买 API 密钥
✅ **数据隐私**：所有数据在本地处理，不会上传
✅ **离线可用**：无需网络连接
✅ **多模型支持**：可以随时切换不同的模型

## 劣势

❌ **需要本地资源**：占用 CPU/GPU 和内存
❌ **速度较慢**：相比云端 API，生成速度较慢
❌ **模型质量**：开源模型效果可能不如商业模型

## 推荐使用场景

- 对数据隐私有要求
- 不想付费使用 API
- 有较好的硬件配置
- 需要离线使用

## 更多信息

- [Ollama 官网](https://ollama.com/)
- [Ollama GitHub](https://github.com/ollama/ollama)
- [模型库](https://ollama.com/library)
