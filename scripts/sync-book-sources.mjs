#!/usr/bin/env node
/**
 * 书源数据单一源同步脚本。
 *
 * 背景：qianyue-novel-sources.json 存在两份物理拷贝，分别服务于两个运行时：
 *   - sidecars/agent-runtime/src/data/  → 桌面端 sidecar（经 JSON-RPC 书源搜索/下载）
 *   - desktop-app/src/data/             → 移动端前端（无 sidecar，直接 HTTP gateway 模式）
 * 两份必须保持一致，否则桌面端与移动端书源行为会不一致。
 *
 * 约定：以 agent-runtime 侧为 canonical 源，本脚本负责同步与校验。
 *
 * 用法：
 *   node scripts/sync-book-sources.mjs sync    # 将 canonical 同步到 desktop-app
 *   node scripts/sync-book-sources.mjs check   # 校验两份一致（供 CI），不一致以非零码退出
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  resolve(root, 'sidecars/agent-runtime/src/data/qianyue-novel-sources.json'),
  resolve(root, 'desktop-app/src/data/qianyue-novel-sources.json'),
];
const [canonical, mirror] = files;

const hash = (buf) => createHash('sha256').update(buf).digest('hex');

const mode = process.argv[2] ?? 'check';
const canonicalBuf = readFileSync(canonical);
const mirrorBuf = readFileSync(mirror);
const same = canonicalBuf.equals(mirrorBuf);

if (mode === 'sync') {
  if (same) {
    console.log('书源数据已一致，无需同步。');
  } else {
    writeFileSync(mirror, canonicalBuf);
    console.log(`已同步书源数据 → ${mirror}`);
  }
  process.exit(0);
}

// check 模式
if (same) {
  console.log(`书源数据一致 (sha256 ${hash(canonicalBuf).slice(0, 12)}…)`);
  process.exit(0);
}

console.error('❌ 书源数据不一致！');
console.error(`   canonical: ${canonical}  (${hash(canonicalBuf)})`);
console.error(`   mirror:    ${mirror}  (${hash(mirrorBuf)})`);
console.error('   请运行 `npm run sync:book-sources` 同步，或从 canonical 手动更新。');
process.exit(1);
