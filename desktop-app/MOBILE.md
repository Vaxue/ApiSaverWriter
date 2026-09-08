# 移动端构建

本项目使用同一份 React 前端和 Tauri Rust 数据层构建 Windows、macOS、Android、iOS。

## 移动端 Agent

Android 与 iOS 不启动桌面 Node 子进程，直接通过 Tauri 原生 HTTP 通道访问“AI 模型配置”里的 OpenAI/Responses/Anthropic 兼容接口。模型密钥只保存在本机，移动端不需要填写 Gateway，也不需要额外服务器。章节、章纲、卡片和润色请求保持 SSE 流式返回；本地项目、记忆和用量仍由 Tauri 数据层保存。

如果接口没有浏览器 CORS 头，应用会自动使用内置的 `tauri-plugin-http` 原生请求通道；桌面端仍使用内置 Agent Runtime。

## 移动端本地模型

Android/iOS 已支持选择“本地免费”并通过原生 HTTP 通道连接 OpenAI 兼容的 llama.cpp/Ollama 服务。移动端不能像桌面端那样直接启动 `llama-server` 子进程：iOS 不允许 App 执行随包二进制，Android 也不能复用桌面 Linux/Windows/macOS 二进制。因此移动端当前支持两种实际部署方式：

1. **同一局域网电脑运行 llama-server**：把设置里的本地地址改为电脑局域网地址，例如 `http://192.168.1.20:8080/v1`；手机不需要 API Key，小说内容通过局域网访问本地服务。
2. **原生端内置推理（后续移动原生构建阶段）**：需要把 llama.cpp 编译为 iOS Metal / Android NDK-Vulkan 原生库，并接入 Tauri mobile plugin；不能把桌面 `llama-server` 二进制直接塞进移动包。

移动端的“本地免费”模式已经支持本地地址、免 Key、模型列表、测试、流式聊天和 Agent 写作请求。iOS 已声明本地网络用途；Android/iOS 构建仍需在各自原生工具链上完成。


Android 需要 Android SDK、NDK、JDK，并设置 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）。

```bash
cd desktop-app
npm run mobile:init -- android
npm run android:build
```

发布给用户安装的 APK 必须经过固定发布证书签名。CI 使用
`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、
`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 四个仓库 Secret，并由
`scripts/package-android-release.sh` 完成 zipalign、APK v2/v3 签名、
包名/版本解析和签名校验。不要分发 Gradle 输出中的
`*-release-unsigned.apk`，安卓安装器会将它识别为无效软件包。

iOS 需要 Xcode、CocoaPods、Apple Development Team：

```bash
cd desktop-app
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run mobile:init -- ios
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run ios:build
```

桌面构建保持不变：`npm run tauri:build`。Windows 安装包需要在 Windows CI 或 Windows 机器上构建；macOS 不能直接产出可发布的 Windows WebView2 安装包。
