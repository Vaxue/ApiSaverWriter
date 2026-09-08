# 移动端构建

本项目使用同一份 React 前端和 Tauri Rust 数据层构建 Windows、macOS、Android、iOS。

## 移动端 Agent

Android 与 iOS 不启动桌面 Node 子进程，直接通过 Tauri 原生 HTTP 通道访问“AI 模型配置”里的 OpenAI/Responses/Anthropic 兼容接口。模型密钥只保存在本机，移动端不需要填写 Gateway，也不需要额外服务器。章节、章纲、卡片和润色请求保持 SSE 流式返回；本地项目、记忆和用量仍由 Tauri 数据层保存。

如果接口没有浏览器 CORS 头，应用会自动使用内置的 `tauri-plugin-http` 原生请求通道；桌面端仍使用内置 Agent Runtime。

## 移动端本地模型

iOS/Android 现在支持将 `MiniCPM5-2B-Q4_K_M.gguf` 直接作为 Tauri mobile 资源打包，并通过 Rust 原生 `llama-cpp-4` 在设备内部推理：

- iOS：llama.cpp Metal 后端
- Android：llama.cpp CPU/NEON 基线后端
- 手机不需要局域网电脑、不需要 API Key、不启动 `llama-server`
- 本地模型请求通过 Tauri command 进入原生推理，不经过 HTTP

移动端资源构建需要提前提供模型文件：

```bash
export APISAVERWRITER_BUNDLE_LOCAL_MODEL=1
export APISAVERWRITER_LOCAL_MODEL=/absolute/path/MiniCPM5-2B-Q4_K_M.gguf
npm run android:build --prefix desktop-app
# 或
npm run ios:build --prefix desktop-app
```

注意：1.56GB GGUF 会显著增大 APK/IPA，Android 发布包更适合使用 Play Asset Pack；iOS 需要在真实设备上验证 App 内存限制。当前移动端原生实现按请求加载模型并返回完整结果，章节正文流式体验会在原生推理稳定后再改为 token event 流。

如果不把模型打进移动包，仍可以切换到 API 付费模式；桌面端继续使用 `llama-server` 资源方案。


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
