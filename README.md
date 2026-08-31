# AI写作软件｜AI写小说软件｜ApiSaverWriter

**关键词：AI写作软件、AI写小说软件、AI网文写作、小说智能体、长篇小说创作、网文大纲、章节记忆、Tauri 多端写作。**

> ApiSaverWriter 是一款面向长篇网文创作的 AI 写作软件、AI 写小说软件和本地优先写作工作台。

[![Version](https://img.shields.io/badge/version-0.1.5-1677ff)](https://my.feishu.cn/wiki/TQKNwxbzUitID3kWxOicv58vnqa)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Android%20%7C%20iOS-20a162)](#下载安装)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-8a2be2)](LICENSE)

ApiSaverWriter 将作品资料、世界观、大纲、章节、角色卡、记忆与写作技能组织在一个本地项目中。它面向需要持续创作、追踪设定与维持上下文一致性的长篇网文作者，而不是一次性文本生成器。

## 下载安装

最新安装包、校验值与版本更新记录统一发布在飞书文档：

**[下载 ApiSaverWriter](https://my.feishu.cn/wiki/TQKNwxbzUitID3kWxOicv58vnqa)**

当前提供 macOS、Windows、Android 与 iOS 构建版本。iOS 安装包为未签名 IPA，需使用适合设备的签名或安装方式导入。

## 使用教程

完整图文教程请查看[飞书使用教程](https://my.feishu.cn/wiki/UMTkwQAuEiIm3UkTNqrcAN3lnWb)。下面保留教程中的操作目录，方便在仓库首页快速查找。

### 一、创建大模型 ApiKey

1. 注册 ApiSaverWriter 中转站账户。
2. 登录中转站。
3. 创建一个 ApiKey。
4. 打开 ApiSaverWriter，在设置中粘贴 ApiKey。
5. 点击“拉取模型”，选择启用的模型并保存设置。

### 二、小说管理

1. 新建小说。
2. 新建总纲。
3. 新建世界观与作品设定。
4. 新建主角卡片和金手指卡片。
5. 创建章纲。
6. 根据章纲生成章节正文。
7. 在记忆中心查看章节记忆。
8. 查看知识图谱。
9. 使用 AI 检测、AI 润色和去 AI 味。
10. 绑定文风。

### 三、书籍管理

1. 搜索并下载书籍。
2. 下载完成后，可调用 AI 生成章纲，也可以一键拆书到拆书管理。
3. 使用“蒸馏文风”Skill 提取参考作品的写作风格。

### 四、拆书管理

可以选择书籍管理中的小说进行拆书，生成结构、节奏、人物和文风分析。

### 五、扫榜管理

扫榜支持番茄、起点和飞卢榜单，可查看榜单书籍及封面信息。

### 六、技能管理

1. 技能管理中提供软件内置的默认技能。
2. 可以新建自定义技能，用于扩展写作流程。

### 七、文风管理

可以新建文风，并添加图标、封面和文风说明，供章节写作时绑定使用。

### 教程与下载

- [打开完整飞书使用教程](https://my.feishu.cn/wiki/UMTkwQAuEiIm3UkTNqrcAN3lnWb)
- [下载最新安装包与查看版本更新](https://my.feishu.cn/wiki/TQKNwxbzUitID3kWxOicv58vnqa)
- [ApiSaverWriter 开源仓库](https://github.com/Vaxue/ApiSaverWriter)

## 界面预览

以下截图来自 v0.1.5 的实际构建，用于展示主要工作流；移动端采用独立的窄屏布局。

| 首页 | 新建小说 |
| --- | --- |
| ![首页](docs/screenshots/home.png) | ![新建小说](docs/screenshots/new-project.png) |

### 移动端章节编辑器

![移动端章节编辑器](docs/screenshots/mobile-chapter-editor.png)

## 使用方式

1. 在“设置”中添加 ApiSaver API Key，拉取该 Key 所属分组可用的模型并选择模型。
2. 新建小说，先建立世界观与作品设定，再创建总纲、章纲或正文。
3. 保存正文后确认章节记忆，后续章节会按固定资料、历史摘要与最近对话的顺序构建上下文。
4. 通过“设置 - 备份与同步”创建完整备份，在新设备上恢复同一份创作资料。

## 架构

```text
ApiSaverWriter/
├── desktop-app/             # React + TypeScript + Tauri 多端客户端
│   ├── src/                 # 界面、平台适配、内置 Skills
│   └── src-tauri/           # Rust 原生能力与移动端工程
├── sidecars/agent-runtime/  # Node.js 写作智能体、上下文和本地存储
├── src/                     # 技能、拆书、书源与基础能力
├── schema/                  # 本地数据结构
└── scripts/                 # 版本发布和飞书同步脚本
```

- **客户端**：React、TypeScript、Vite、Tauri 2。
- **智能体运行时**：Node.js、TypeScript，负责会话、上下文缓存、Skill 路由和章节记忆。
- **本地数据**：项目资料保存在用户设备本地；同步由用户主动触发。

## 本地开发

### 环境要求

- Node.js 20+
- Rust stable 与 Tauri 对应平台依赖
- 平台构建工具：Xcode（iOS/macOS）、Android SDK（Android）、Windows 构建环境（Windows）

### 启动

```bash
npm install
npm install --prefix desktop-app
npm run tauri:dev --prefix desktop-app
```

### 构建

```bash
npm run tauri:build --prefix desktop-app
```

移动端构建步骤请查看 [desktop-app/MOBILE.md](desktop-app/MOBILE.md)。

## 开源边界与隐私

本仓库公开的是客户端、写作工作流和本地数据能力。以下内容不在仓库内，也不会随客户端源码提交：

- ApiSaver 的模型渠道、模型路由、余额、计费、风控与运营系统。
- API Key、访问令牌、签名证书、个人小说内容、云端备份内容和其他用户数据。
- 生产服务配置与服务端密钥。

客户端默认使用 ApiSaver 服务地址，用户需在设置中配置自己的 API Key。请勿在 Issue、Pull Request、日志或截图中提交任何 Key、Cookie、备份文件或私密作品资料。

## 贡献

欢迎提交 Bug 报告、功能建议与 Pull Request。开始前请阅读 [贡献指南](CONTRIBUTING.md) 与 [安全策略](SECURITY.md)。

## 许可证

本项目以 [GNU Affero General Public License v3.0 or later](LICENSE) 发布。第三方依赖仍受各自许可证约束。
