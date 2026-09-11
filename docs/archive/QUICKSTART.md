# 快速开始指南

## 🚀 5 分钟上手 ApiSaverWriter

### 前置要求

- Node.js 18+
- Rust 1.70+（用于 Tauri）
- 操作系统：macOS / Windows / Linux

### 安装步骤

#### 1. 克隆项目

```bash
git clone https://github.com/yourusername/ApiSaverWriter.git
cd ApiSaverWriter
```

#### 2. 安装依赖

```bash
# 安装根项目依赖
npm install

# 安装桌面应用依赖
cd desktop-app
npm install
```

#### 3. 启动开发服务器

```bash
# 在 desktop-app 目录下
npm run tauri dev
```

首次启动会编译 Rust 代码，需要 1-2 分钟。

### 基础使用

#### 技能库

1. 点击左侧「⚡ 技能库」
2. 浏览内置的 10+ 种写作技巧
3. 使用搜索框快速查找
4. 点击技能卡片查看详情

#### 扫榜工具

1. 点击「📊 扫榜工具」
2. 选择平台（番茄小说）
3. 选择分类（玄幻、都市等）
4. 点击「刷新榜单」获取最新排行

#### 拆书分析

1. 从扫榜工具选择一本书
2. 点击「拆书分析」
3. 查看章节结构、节奏、技巧分析
4. 将优秀写法添加到技能库

### 核心 API 使用

#### 搜索技能

```typescript
import { NovelWriter } from '@apisaverwriter/core';

const writer = new NovelWriter();

// 全部技能
const allSkills = writer.skills.search({ limit: 100 });

// 按分类搜索
const techniques = writer.skills.search({ 
  category: 'technique' 
});

// 按标签搜索
const dialogueSkills = writer.skills.search({ 
  tags: ['对话'] 
});

// 全文搜索
const results = writer.skills.search({ 
  query: '悬念' 
});
```

#### 添加自定义技能

```typescript
const skillId = writer.skills.add({
  name: '倒叙开头',
  category: 'technique',
  description: '从结局开始倒叙，吸引读者兴趣',
  content: `
    1. 从高潮或结局场景开始
    2. 设置悬念："这一切是如何发生的？"
    3. 然后回到故事开端
    4. 逐步揭示真相
  `,
  tags: ['开头', '悬念', '结构'],
  examples: [
    '那一天，他站在悬崖边，回想起这一切的开始...'
  ]
});

console.log(`技能已添加，ID: ${skillId}`);
```

#### 分析章节

```typescript
import { BookAnalyzer } from '@apisaverwriter/core';

const analyzer = new BookAnalyzer();

const content = `
  他推开门，屋内一片寂静。
  "有人吗？"他小心翼翼地问道。
  没有回应。他慢慢走进去，突然，背后传来一声巨响！
`;

const result = await analyzer.analyzeChapter(
  content,
  '第一章 神秘的房间',
  1
);

console.log('章节结构:', result.structure);
console.log('识别的技巧:', result.techniques);
console.log('节奏评估:', result.pacing);
console.log('可学习点:', result.learnings);
```

### 常见问题

#### Q: 首次启动很慢？
A: Tauri 需要编译 Rust 代码，首次启动需要 1-2 分钟。后续启动会快很多。

#### Q: 如何添加更多爬虫？
A: 继承 `BaseScraper` 类：

```typescript
import { BaseScraper, NovelRanking, ScraperOptions } from './base-scraper';

export class QidianScraper extends BaseScraper {
  async fetchRankings(options?: ScraperOptions): Promise<NovelRanking[]> {
    // 实现爬虫逻辑
    const response = await fetch('https://www.qidian.com/rank/...');
    const html = await response.text();
    // 解析 HTML...
    return rankings;
  }
}
```

#### Q: 数据存储在哪里？
A: SQLite 数据库文件位于：
- macOS: `~/Library/Application Support/com.apisaverwriter.app/`
- Windows: `%APPDATA%/com.apisaverwriter.app/`
- Linux: `~/.local/share/com.apisaverwriter.app/`

#### Q: 如何备份数据？
A: 复制上述目录中的 `novel-writer.db` 文件。

### 进阶功能

#### 批量分析

```typescript
const chapters = [
  { content: '第一章内容...', title: '第一章', number: 1 },
  { content: '第二章内容...', title: '第二章', number: 2 },
  // ...
];

const analyzer = new BookAnalyzer();
const results = await Promise.all(
  chapters.map(ch => 
    analyzer.analyzeChapter(ch.content, ch.title, ch.number)
  )
);

// 分析整本书的节奏变化
const pacing = results.map(r => r.pacing.speed);
console.log('节奏曲线:', pacing);
```

#### 自动提取技能

```typescript
const result = await analyzer.analyzeChapter(content, title, 1);

// 将识别的技巧保存为技能
for (const technique of result.techniques) {
  writer.skills.add({
    name: technique.name,
    category: technique.category,
    description: technique.description,
    content: technique.example,
    tags: [technique.category],
  });
}
```

### 下一步

- 📖 阅读 [README.md](./README.md) 了解完整功能
- 🏗️ 查看 [ARCHITECTURE.md](./ARCHITECTURE.md) 了解技术架构
- 🧪 运行 `npm test` 查看测试用例
- 🎨 自定义 `desktop-app/src/App.css` 调整界面样式

### 获取帮助

- 提交 Issue: https://github.com/yourusername/ApiSaverWriter/issues
- 讨论区: https://github.com/yourusername/ApiSaverWriter/discussions
- Email: your-email@example.com

---

**祝你写作愉快！✍️**
