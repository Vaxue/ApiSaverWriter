#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 版本说明必须取自 CHANGELOG 中对应版本的段落。此前这里写死了几条 v0.1.4
// 时期的条目，导致同步到飞书的内容与本次实际发布毫无关系。
const changelogSection = (version) => {
  const changelogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
  let text = '';
  try { text = readFileSync(changelogPath, 'utf8'); } catch { return ''; }
  const heading = new RegExp(`^##\\s*\\[?v?${version.replace(/\./g, '\\.')}\\]?`);
  const collected = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (inside) break;
      inside = heading.test(line);
      continue;
    }
    if (inside) collected.push(line);
  }
  return collected.join('\n').trim();
};

const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
  headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});
if (!releaseResponse.ok) throw new Error(`GitHub Release 查询失败：HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const assets = Array.isArray(release.assets) ? release.assets : [];
const downloadBase = `https://github.com/${downloadRepository}/releases/download/${encodeURIComponent(tag)}`;
const version = tag.replace(/^v/, '');
const section = changelogSection(version);
const lines = [
  `\n\n## ${tag}（${new Date().toISOString().slice(0, 10)}）`,
  '',
  section || '### 更新内容\n- 详见 GitHub Release 说明。',
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
