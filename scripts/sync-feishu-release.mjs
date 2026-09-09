#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const docUrl = process.env.FEISHU_DOC_URL || 'https://my.feishu.cn/wiki/TQKNwxbzUitID3kWxOicv58vnqa';
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || '';
const repository = process.env.GITHUB_REPOSITORY || 'Vaxue/ApiSaverWriter';
const downloadRepository = process.env.DOWNLOAD_REPOSITORY || 'Vaxue/AI-xiaoshuo-xiezuo-ruanjian';
const token = process.env.GITHUB_TOKEN || '';
const identity = process.env.FEISHU_AS || 'bot';
if (!tag) throw new Error('缺少 RELEASE_TAG 或 GITHUB_REF_NAME');

const run = (args, options = {}) => execFileSync('lark-cli', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return {}; }
};

const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
  headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});
if (!releaseResponse.ok) throw new Error(`GitHub Release 查询失败：HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const assets = Array.isArray(release.assets) ? release.assets : [];
const downloadBase = `https://github.com/${downloadRepository}/releases/download/${encodeURIComponent(tag)}`;
const lines = [
  `\n\n## ${tag}（${new Date().toISOString().slice(0, 10)}）`,
  '',
  '### 更新内容',
  '- 使用教程改为飞书文档入口，客服入口统一为“联系客服”。',
  '- 下载小说时按书源完整目录获取，不再限制最多 200 章。',
  '- TXT 导入兼容 `第1章`、`1、标题`、`1. 标题`、`1 标题`、`Chapter 1` 等章节格式。',
  '- 猫眼看书优+书源遇到过期授权或 403 时自动清理旧授权并重试。',
  '- 新增审查中心，支持当前章、勾选章节和全书审查，可按建议让 AI 修改正文并自动同步章纲。',
  '- 保存章节时自动创建或更新对应章纲，异步合并最新项目状态，避免正文与章纲脱节。',
  '',
  '### 安装包下载',
  ...(assets.length ? assets.map(asset => `- [${asset.name}](${downloadBase}/${encodeURIComponent(asset.name)})`) : ['- 安装包正在准备中，请稍后刷新本页。']),
  '',
  '> 本节由 GitHub Actions 自动同步。重复运行不会重复追加同一版本。',
].join('\n');

const fetched = parseJson(run(['docs', '+fetch', '--as', identity, '--doc', docUrl, '--doc-format', 'markdown', '--scope', 'full', '--detail', 'simple']));
const current = String(fetched?.data?.document?.content || '');
if (current.includes(`## ${tag}（`)) {
  console.log(`飞书文档已包含 ${tag}，跳过重复同步。`);
  process.exit(0);
}

run(['docs', '+update', '--as', identity, '--doc', docUrl, '--command', 'append', '--doc-format', 'markdown', '--content', '-'], { input: lines });
console.log(`已同步 ${tag} 到飞书文档：${docUrl}`);
