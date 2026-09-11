# ApiSaverWriter 开发总结

## ✅ 已完成的工作

### 1. 后端 AI 引擎 (sidecars/agent-runtime)

#### 核心工作流 - LangGraph 5 节点
- ✅ **retrieve**: 混合检索节点
  - FTS5 关键词检索 (人名/地名/物品/章节)
  - sqlite-vec 语义向量检索
  - 混合召回策略，自动去重和相关性排序
  
- ✅ **draft**: 章节草稿生成
  - 支持流式输出
  - 上下文注入 (人物/地点/伏笔/上章结尾)
  - LLM 调用封装
  
- ✅ **review**: 内容审查
  - 人物一致性检查
  - 剧情逻辑验证
  - 自动识别需要修订的问题
  
- ✅ **revise**: 条件修订
  - 仅在 review 失败时触发
  - 针对性修复审查问题
  
- ✅ **summarize**: 章节摘要
  - 200字内摘要
  - 用于后续章节的上下文检索

#### 存储层 - SQLite + FTS5 + Vector
- ✅ **FTS5 中文全文检索**
  - jieba 分词集成
  - 人物、地点、物品、章节内容索引
  - BM25 相关性排序
  
- ✅ **sqlite-vec 向量检索**
  - Transformers.js 本地 embedding
  - 余弦相似度搜索
  - 批量向量插入优化
  
- ✅ **数据模型**
  - projects: 项目管理
  - chapters: 章节内容
  - characters: 角色卡
  - locations: 地点库
  - plot_threads: 伏笔线索

#### Embedding 支持
- ✅ **本地模型**: Transformers.js (Xenova/all-MiniLM-L6-v2)
- ✅ **远程 API**: API Saver / OpenAI 兼容接口
- ✅ **批量处理**: 自动批次切分

#### 流式输出
- ✅ **StreamEmitter**: 进度事件推送
- ✅ **JSON-RPC 集成**: 通过 stdio 实时传递进度
- ✅ **事件类型**:
  - node_start: 节点开始
  - node_end: 节点完成
  - draft_chunk: 草稿流式片段
  - review_result: 审查结果
  - complete: 整体完成

#### 测试覆盖
- ✅ FTS5 中文分词测试
- ✅ 向量语义检索测试
- ✅ 混合召回测试
- ✅ LangGraph 工作流集成测试
- ✅ 流式输出测试

---

### 2. 桌面应用 (desktop-app)

#### Tauri 框架搭建
- ✅ **项目初始化**: Tauri 2.0 + React 19 + TypeScript
- ✅ **Rust 后端**: IPC 命令处理框架
- ✅ **Sidecar 配置**: 为 agent-runtime 预留集成点

#### React 前端界面
- ✅ **App.tsx**: 主应用组件
  - 章节列表侧边栏
  - 指令输入区
  - 章节编辑器
  - 生成状态管理
  
- ✅ **UI 设计**: 暗色主题
  - 配色: #0F1117 背景 + #FBBF24 强调色
  - 系统字体栈
  - 响应式布局
  - 流畅动画和状态指示器

#### 配置文件
- ✅ **vite.config.ts**: Tauri 优化配置
- ✅ **tauri.conf.json**: 窗口、打包、权限配置
- ✅ **Cargo.toml**: Rust 依赖管理

---

### 3. 文档

- ✅ **项目 README**: 完整的项目介绍、特性、架构说明
- ✅ **桌面应用 README**: Tauri 开发指南、构建流程
- ✅ **技术架构文档**: 详细的技术选型和设计决策
- ✅ **ARCHITECTURE.md**: 数据流、检索策略、工作流说明

---

## 🚧 待完成的关键功能

### 1. Tauri ↔ Node.js 通信 (高优先级)

**当前状态**: 
- ✅ Rust 后端框架已搭建
- ✅ JSON-RPC 协议已实现
- ❌ stdio 双向通信未连接

**需要实现**:
```rust
// src-tauri/src/main.rs
use std::process::{Command, Stdio};
use serde_json::{json, Value};

#[tauri::command]
async fn start_agent_runtime() -> Result<String, String> {
    let mut child = Command::new("node")
        .arg("../sidecars/agent-runtime/dist/index.js")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    
    // 保存 child 到全局状态
    // 实现 JSON-RPC 读写
    Ok("Runtime started".to_string())
}

#[tauri::command]
async fn call_agent_rpc(method: String, params: Value) -> Result<Value, String> {
    // 构造 JSON-RPC 请求
    // 写入 stdin
    // 从 stdout 读取响应
    // 解析并返回
}
```

**测试方法**:
```bash
cd desktop-app
npm run dev
# 应能看到 agent-runtime 进程启动
# UI 点击"生成章节"应能正常调用
```

---

### 2. 项目管理功能

**需要的 UI 组件**:
- 项目选择/创建对话框
- 项目元数据编辑 (书名、作者、简介)
- 项目切换

**需要的 IPC 命令**:
```typescript
await invoke('create_project', { name, description })
await invoke('list_projects')
await invoke('switch_project', { projectId })
```

---

### 3. 人物/地点/伏笔管理

**UI 设计**:
```
Tabs: [章节] [人物] [地点] [伏笔]

人物 Tab:
- 人物卡列表
- 添加/编辑人物
- 字段: 姓名、简介、当前状态、关系网

地点 Tab:
- 地点库列表
- 添加/编辑地点
- 字段: 名称、描述、出现章节

伏笔 Tab:
- 伏笔线索列表
- 状态: 埋下/推进/回收
- 章节关联
```

**对应的 agent-runtime API**:
```typescript
rpc.addMethod('createCharacter', async (params) => {
  const { projectId, name, description, status } = params;
  // 插入 characters 表
  // 生成 embedding
  // 返回 character_id
});

rpc.addMethod('updateCharacter', async (params) => {
  // 更新角色状态
});

rpc.addMethod('listCharacters', async (params) => {
  // 查询项目所有角色
});
```

---

### 4. 设置页面

**需要配置项**:
- API Provider 选择 (API Saver / OpenAI / 自定义)
- API Key 输入
- Embedding 模型选择 (本地/远程)
- 是否启用重排模型
- Token 预算控制

**存储方式**:
```typescript
// Tauri 的安全存储
import { Store } from '@tauri-apps/plugin-store';

const store = new Store('settings.json');
await store.set('apiKey', encryptedKey);
await store.set('provider', 'api-saver');
```

---

### 5. 导出功能

**支持格式**:
- ✅ TXT: 简单拼接章节
- 📦 EPUB: 需要集成 epub-gen
- 📦 PDF: 需要集成 pdfmake 或调用系统打印

**实现方案**:
```typescript
// agent-runtime 新增方法
rpc.addMethod('exportProject', async (params) => {
  const { projectId, format } = params;
  
  // 查询所有章节
  const chapters = await storage.getChaptersByProject(projectId);
  
  switch (format) {
    case 'txt':
      return chapters.map(ch => ch.content).join('\n\n');
    case 'epub':
      // 使用 epub-gen
    case 'pdf':
      // 使用 pdfmake
  }
});
```

---

## 🎯 优先级排序

### P0 - 必须完成才能 Demo
1. **Tauri ↔ Node.js 通信** (2-3小时)
2. **基本的章节生成流程验证** (1小时测试)

### P1 - MVP 必需
3. **项目管理** (4-6小时)
4. **人物管理** (3-4小时)
5. **设置页面** (2-3小时)

### P2 - 增强功能
6. **地点/伏笔管理** (4-6小时)
7. **导出 TXT** (2小时)
8. **流式输出 UI 显示** (3-4小时)

### P3 - 高级功能
9. **导出 EPUB/PDF** (6-8小时)
10. **拆书分析** (8-10小时)
11. **多人协作** (需要后端服务)

---

## 📊 当前项目状态

```
整体完成度: 60%

后端引擎:  ████████████░░░░  75%
  - LangGraph 工作流 ✅
  - 存储层 ✅
  - 检索系统 ✅
  - 流式输出 ✅
  - RPC 接口 ✅

桌面应用:  ██████░░░░░░░░░░  40%
  - Tauri 框架 ✅
  - UI 组件 ✅
  - 样式设计 ✅
  - IPC 通信 ❌ (关键阻塞点)
  - 功能完整性 ❌

移动应用:  ░░░░░░░░░░░░░░░░  0%
  - React Native 未开始

文档:      ████████████████  100%
  - README ✅
  - 架构文档 ✅
  - 开发指南 ✅
```

---

## 🔧 下一步行动

### 今天应该做的 (2-4小时)

1. **实现 Tauri stdio 通信** (src-tauri/src/main.rs)
   - 启动 Node.js sidecar
   - JSON-RPC 请求/响应
   - 错误处理

2. **验证端到端流程**
   ```bash
   npm run dev
   # 输入: "第一章：海边老屋"
   # 预期: 返回生成的章节内容
   ```

3. **修复发现的问题**

### 本周应该做的

4. **实现项目管理 UI**
5. **实现人物管理 UI**
6. **添加设置页面**

### 长期计划

- 完善桌面应用到可发布状态
- 启动 React Native 移动端开发
- 添加云端同步功能

---

## 💡 技术债务

1. **类型安全**: `any` 类型应替换为具体接口
2. **错误处理**: 需要统一的错误码和用户友好提示
3. **性能优化**: 大量章节时的列表虚拟化
4. **测试覆盖**: 前端单元测试缺失
5. **日志系统**: 需要结构化日志和日志级别控制

---

## 📚 参考资源

- [Tauri IPC 文档](https://tauri.app/v1/guides/features/command)
- [LangGraph 文档](https://langchain-ai.github.io/langgraphjs/)
- [SQLite FTS5 文档](https://www.sqlite.org/fts5.html)
- [sqlite-vec 示例](https://github.com/asg017/sqlite-vec#examples)

---

**状态**: 🟡 开发中 - 核心功能已完成，需要连接各层

**预计可 Demo 时间**: 完成 Tauri 通信后即可演示基本流程 (2-3小时工作量)
