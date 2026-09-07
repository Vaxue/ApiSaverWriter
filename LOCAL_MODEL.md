# MiniCPM5-2B 本地免费模式

ApiSaverWriter 现在支持两种 Agent 模型来源：

- **本地免费**：通过 OpenAI 兼容的 `llama.cpp` / Ollama 服务运行 `MiniCPM5-2B` 的 GGUF 4bit 量化模型，不需要 API Key。
- **API 付费**：切换到 ApiSaver 中转服务，按账户额度使用模型。

## 推荐本地模型

从 ModelScope 下载 `OpenBMB/MiniCPM5-2B-GGUF` 中的 `Q4_K_M.gguf` 文件。不要把模型大文件提交到 Git 仓库。

## 直接打包进 Tauri 安装包

桌面端可以在构建阶段把 `llama-server` 和模型权重复制进安装包资源目录。脚本只做真实文件复制，不创建软链接。由于 GGUF 文件约 1.56GB，模型权重不会提交到 Git 源码仓库；构建机器需要提前准备文件。

```bash
export APISAVERWRITER_BUNDLE_LOCAL_MODEL=1
export APISAVERWRITER_LOCAL_MODEL=/absolute/path/MiniCPM5-2B-Q4_K_M.gguf
export APISAVERWRITER_LLAMA_SERVER=/absolute/path/llama-server
export APISAVERWRITER_LOCAL_CONTEXT=4096
npm run tauri:build --prefix desktop-app
```

构建流程会把文件复制到 Tauri 的 `local-model` 资源目录，并由应用自动启动 `llama-server`。若没有设置这些变量，普通开发构建仍可继续，但产物不包含模型权重。

Windows、macOS、Linux 必须分别准备对应平台的 `llama-server` 二进制并分别构建；不能把 Linux 二进制放进 Windows 安装包。iOS/Android 不直接打包 llama-server，需要另行接入 Metal/Vulkan 原生推理。


安装带 `llama-server` 的 llama.cpp，然后启动：

```bash
llama-server \
  -m /path/to/MiniCPM5-2B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  -c 4096 \
  -ngl 99
```

没有 GPU 时可以去掉 `-ngl 99`。8GB 设备建议从 `-c 2048` 或 `-c 4096` 开始，避免直接使用模型标称的 131K 上下文。

## 使用 Ollama

如果 Ollama 已经导入该 GGUF 并在 `11434` 端口运行，在软件的“设置 → AI 模型配置”中把本地接口改为：

```text
http://127.0.0.1:11434/v1
```

模型名称填写 Ollama 中实际的模型名。

## 软件设置

首次启动默认选择“本地免费”，接口地址为：

```text
http://127.0.0.1:8080/v1
```

点击“拉取模型”可以读取本地服务的 `/v1/models`，点击“测试模型”验证聊天接口。切换到“API 付费”后再填写 ApiSaver API Key。

## 实现边界

仓库只提交 Provider、设置界面和启动说明，不提交模型权重、llama.cpp 二进制或任何 API Key。桌面端和移动端需要由宿主应用分别集成 llama.cpp/Metal/Vulkan；它们都可以复用 GGUF 和统一的 OpenAI 兼容请求协议。
