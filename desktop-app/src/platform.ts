import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { gzip, gunzip } from 'fflate';
import SparkMD5 from 'spark-md5';
import qianyueSourceData from './data/qianyue-novel-sources.json';

type InvokeArgs = Record<string, unknown> | undefined;
type MobileParams = Record<string, unknown>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type MobileUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; cacheWriteTokens: number; reasoningTokens: number; requests: number; startedAt: string };
type CloudBackupFile = {
  name: string;
  path: string;
  fsId?: string;
  size: number;
  modifiedAt: string;
  isBundle: boolean;
  source: 'bundle';
};
type MobileQianyueSource = {
  bookSourceName?: string;
  bookSourceUrl?: string;
  searchUrl?: string;
  enabled?: boolean;
  ruleSearch?: Record<string, unknown>;
  ruleBookInfo?: Record<string, unknown>;
  ruleToc?: Record<string, unknown>;
  ruleContent?: Record<string, unknown>;
  header?: string;
};

const mobileRuntime = () => '__TAURI_INTERNALS__' in window && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// 百度网盘同步使用应用内 HTTP API。所有 Tauri 平台都走这条路径，避免
// macOS/Windows 依赖外部 bdpan CLI；桌面端的小说文件仍由原生命令写入本机目录。
const directBaiduRuntime = () => '__TAURI_INTERNALS__' in window;

let httpFetchPromise: Promise<typeof globalThis.fetch> | null = null;
// `/v1/models` is scoped to one API Key. Keep the association on mobile too,
// otherwise a merged model list can route Gemini through a Claude-only key.
const mobileModelsByApiKey = new Map<string, Set<string>>();
const httpFetch = async (): Promise<typeof globalThis.fetch> => {
  if (!httpFetchPromise) {
    httpFetchPromise = import('@tauri-apps/plugin-http')
      .then(module => module.fetch as unknown as typeof globalThis.fetch)
      .catch(() => globalThis.fetch.bind(globalThis));
  }
  return httpFetchPromise;
};

const stringValue = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const arrayStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const memoryList = (value: unknown, limit = 40): string[] => {
  if (typeof value === 'string') return value.split(/\r?\n|[；;、]/u).map(item => item.trim()).filter(Boolean).slice(0, limit);
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    const entry = item as Record<string, unknown>;
    return stringValue(entry.text || entry.content || entry.change || entry.changes || entry.description || entry.name).trim();
  }).filter(Boolean).slice(0, limit);
};
const isQuotaExceeded = (value: string) => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|余额不足|额度(?:已)?用尽/iu.test(value);
const baseURL = (value: unknown) => {
  // Mobile clients use the managed ApiSaver gateway only. Ignore legacy
  // custom values restored from older app versions.
  return 'https://api.apisaver.com/v1';
};

const usageKey = 'writer-mobile-usage';
const baiduTokenKey = 'writer-baidu-access-token';
const baiduClientId = 'zF5kkNsCvckX4aIpRdHxpFkcSMxnGZky';
const baiduBackupName = 'ApiSaverWriter-backup.aswbackup';
const backupMagic = new TextEncoder().encode('ASWBACKUP\x01');

const emitCloudProgress = (message: string) => window.dispatchEvent(new CustomEvent('cloud-sync-progress', { detail: { message } }));

const mobileBaiduToken = () => stringValue(localStorage.getItem(baiduTokenKey)).trim();
const mobileBaiduURL = (base: string, params: Record<string, string>) => {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};

const mobileBaiduRequest = async <T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> => {
  const fetcher = await httpFetch();
  const response = await fetcher(url, init);
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* Keep the response text for diagnostics. */ }
  const errno = Number(data.errno ?? data.error_code ?? 0);
  if (!response.ok || errno !== 0 || data.error) {
    const detail = stringValue(data.error_msg || data.error_description || data.error) || text.replace(/\s+/gu, ' ').slice(0, 220);
    throw new Error(`百度网盘请求失败（${response.status}${errno ? `/${errno}` : ''}）：${detail || '未知错误'}`);
  }
  return data as T;
};

const gzipBytes = (bytes: Uint8Array) => new Promise<Uint8Array>((resolve, reject) => {
  gzip(bytes, { level: 9 }, (error, result) => error ? reject(error) : resolve(result));
});

const gunzipBytes = (bytes: Uint8Array) => {
  if (!bytes.slice(0, 2).every((value, index) => value === [0x1f, 0x8b][index])) return bytes;
  return new Promise<Uint8Array>((resolve, reject) => {
    gunzip(bytes, (error, result) => error ? reject(error) : resolve(result));
  });
};

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const u64 = (value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
};

const concatBytes = (parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  parts.forEach(part => { output.set(part, offset); offset += part.byteLength; });
  return output;
};

const safeBackupRelativePath = (value: string) => {
  if (!value || value.startsWith('/') || value.includes('\0') || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  const segments = value.replace(/\\/gu, '/').split('/');
  return segments.every(segment => Boolean(segment) && segment !== '.' && segment !== '..');
};

const mobileBundleSafeName = (value: unknown, fallback: string) => {
  const cleaned = String(value || '').trim().replace(/[\\/:*?"<>|]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '').trim();
  return cleaned || fallback;
};

const mobileBundleJSON = <T>(files: Record<string, string>, path: string): T | null => {
  try { return files[path] ? JSON.parse(files[path]) as T : null; } catch { return null; }
};

const mobileBundlePath = (...parts: string[]) => parts.filter(Boolean).join('/');

// Desktop backups store large text fields as Markdown files and keep only an
// index in metadata.json. Rehydrate those indexes here because iOS does not
// have the desktop filesystem restore command.
const mobileHydrateDirectorySnapshots = (files: Record<string, string>) => {
  const projects: unknown[] = [];
  Object.keys(files).filter(path => /^projects\/[^/]+\/metadata\.json$/u.test(path)).forEach(metadataPath => {
    const projectFolder = metadataPath.split('/')[1];
    const project = mobileBundleJSON<Record<string, unknown>>(files, metadataPath);
    if (!project) return;
    const chapters = Array.isArray(project.chapters) ? project.chapters.map((chapter: Record<string, unknown>) => {
      const title = mobileBundleSafeName(chapter.title, '未命名章节');
      const contentPath = mobileBundlePath('projects', projectFolder, '章节', `${title}.md`);
      return { ...chapter, content: files[contentPath] ?? String(chapter.content || '') };
    }) : [];
    const outlines = Array.isArray(project.outlines) ? project.outlines.map((outline: Record<string, unknown>) => {
      const title = mobileBundleSafeName(outline.title || outline.kind, '大纲');
      const contentPath = mobileBundlePath('projects', projectFolder, '大纲', `${title}.md`);
      return { ...outline, content: files[contentPath] ?? String(outline.content || '') };
    }) : [];
    const cards = Array.isArray(project.cards) ? project.cards.map((card: Record<string, unknown>) => {
      const type = mobileBundleSafeName(card.type, '角色卡');
      const title = mobileBundleSafeName(card.title, '未命名卡片');
      const contentPath = mobileBundlePath('projects', projectFolder, '卡片', type, `${title}.md`);
      const markdown = files[contentPath];
      if (!markdown) return card;
      const [body, state] = markdown.split('\n## 当前状态\n');
      const currentState = state?.split('\n## 状态历史\n')[0]?.trim();
      return { ...card, content: body.trim(), currentState: currentState && currentState !== '暂无' ? currentState : card.currentState };
    }) : [];
    const memoryDocuments = Array.isArray(project.memoryDocuments) ? project.memoryDocuments.map((document: Record<string, unknown>) => {
      const title = mobileBundleSafeName(document.title || document.kind, '章节快照');
      const contentPath = mobileBundlePath('projects', projectFolder, '记忆', `${title}.md`);
      return { ...document, content: files[contentPath] ?? String(document.content || '') };
    }) : [];
    projects.push({ ...project, chapters, outlines, cards, memoryDocuments });
  });

  const hydrateExternalBooks = (prefix: 'books' | 'dismantles') => {
    const books: unknown[] = [];
    Object.keys(files).filter(path => new RegExp(`^${prefix}/[^/]+/metadata\\.json$`, 'u').test(path)).forEach(metadataPath => {
      const folder = metadataPath.split('/')[1];
      const book = mobileBundleJSON<Record<string, unknown>>(files, metadataPath);
      if (!book) return;
      const chapters = Array.isArray(book.chapters) ? book.chapters.map((chapter: Record<string, unknown>) => {
        const relative = typeof chapter.sourcePath === 'string' && chapter.sourcePath ? chapter.sourcePath : prefix === 'books'
          ? `章节/${mobileBundleSafeName(chapter.title, '未命名章节')}.md`
          : `原文/${String(chapter.number || 1).padStart(3, '0')}-${mobileBundleSafeName(chapter.title, '未命名章节')}.txt`;
        const content = files[mobileBundlePath(prefix, folder, relative)];
        if (prefix === 'books') return { ...chapter, content: content ?? String(chapter.content || ''), downloaded: content ? true : chapter.downloaded };
        return { ...chapter, sourceContent: content ?? String(chapter.sourceContent || '') };
      }) : [];
      books.push({ ...book, chapters });
    });
    return books;
  };

  return {
    projects,
    libraryBooks: hydrateExternalBooks('books'),
    dismantleBooks: hydrateExternalBooks('dismantles'),
    rankingBooks: mobileBundleJSON<unknown[]>(files, 'rankings/metadata.json') || [],
    writingStyles: (() => {
      const styles = mobileBundleJSON<unknown[]>(files, 'styles/metadata.json') || [];
      return styles.map((style: Record<string, unknown>) => {
        const sourcePath = typeof style.sourcePath === 'string' ? style.sourcePath : `${mobileBundleSafeName(style.name, '未命名文风')}.md`;
        return { ...style, content: files[mobileBundlePath('styles', sourcePath)] ?? String(style.content || '') };
      });
    })(),
  };
};

const mobileBackupBundle = async (clientState: Record<string, string | null>) => {
  const encoder = new TextEncoder();
  const state = encoder.encode(JSON.stringify(clientState));
  const snapshotFiles: Array<[string, string]> = [
    ['projects.json', 'projects'],
    ['library-books.json', 'writer-library-books'],
    ['ranking-books.json', 'writer-ranking-books'],
    ['dismantle-books.json', 'writer-dismantle-books'],
    ['writing-styles.json', 'writer-writing-styles'],
    ['agent-config.json', 'agent-config'],
    ['writer-skills.json', 'writer-skills'],
    ['backup-manifest.json', 'backup-manifest'],
  ];
  const entries = [['client-state.json', state], ...snapshotFiles.map(([file, key]) => [file, encoder.encode(stringValue(clientState[key], key === 'agent-config' || key === 'backup-manifest' ? '{}' : '[]'))] as [string, Uint8Array])] as Array<[string, Uint8Array]>;
  const parts: Uint8Array[] = [backupMagic, u64(entries.length)];
  entries.forEach(([path, content]) => {
    const pathBytes = encoder.encode(path);
    parts.push(u32(pathBytes.byteLength), u64(content.byteLength), pathBytes, content);
  });
  return gzipBytes(concatBytes(parts));
};

const readMobileBackupBundle = async (bytes: Uint8Array) => {
  emitCloudProgress(`下载完成（${(bytes.byteLength / 1_048_576).toFixed(1)} MB），正在解压完整备份...`);
  const raw = await gunzipBytes(bytes);
  emitCloudProgress(`解压完成（${(raw.byteLength / 1_048_576).toFixed(1)} MB），正在校验备份内容...`);
  const decoder = new TextDecoder();
  let offset = backupMagic.byteLength;
  if (decoder.decode(raw.slice(0, offset)) !== decoder.decode(backupMagic)) throw new Error('云端文件不是有效的 ApiSaverWriter 完整备份包。');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = Number(view.getBigUint64(offset, true)); offset += 8;
  if (!Number.isSafeInteger(count) || count > 10000) throw new Error('云端备份包文件数量异常。');
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    if (offset + 12 > raw.byteLength) throw new Error(`云端备份包索引不完整（文件 ${index + 1}/${count}）。`);
    const pathLength = view.getUint32(offset, true); offset += 4;
    const size = Number(view.getBigUint64(offset, true)); offset += 8;
    if (!pathLength || offset + pathLength > raw.byteLength) throw new Error(`云端备份包路径索引无效（文件 ${index + 1}/${count}）。`);
    const path = decoder.decode(raw.slice(offset, offset + pathLength)); offset += pathLength;
    if (!safeBackupRelativePath(path)) throw new Error(`云端备份包包含不安全路径：${path}`);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > raw.byteLength) throw new Error(`云端备份包文件内容不完整：${path}`);
    files[path] = decoder.decode(raw.slice(offset, offset + size)); offset += size;
    if (count > 1) emitCloudProgress(`正在解析备份文件 ${index + 1}/${count}...`);
  }
  emitCloudProgress('备份包校验通过，正在读取应用数据...');
  const parsedState = JSON.parse(files['client-state.json'] || '{}') as unknown;
  if (!parsedState || typeof parsedState !== 'object' || Array.isArray(parsedState)) throw new Error('备份包中的应用状态格式无效。');
  const state = parsedState as Record<string, string | null>;
  const snapshotFiles: Array<[string, string]> = [
    ['projects.json', 'projects'],
    ['library-books.json', 'writer-library-books'],
    ['ranking-books.json', 'writer-ranking-books'],
    ['dismantle-books.json', 'writer-dismantle-books'],
    ['writing-styles.json', 'writer-writing-styles'],
    ['agent-config.json', 'agent-config'],
    ['writer-skills.json', 'writer-skills'],
    ['backup-manifest.json', 'backup-manifest'],
  ];
  snapshotFiles.forEach(([file, key]) => {
    if (typeof state[key] !== 'string' && typeof files[file] === 'string') state[key] = files[file];
  });
  const directorySnapshots = mobileHydrateDirectorySnapshots(files);
  if (directorySnapshots.projects.length) state.projects = JSON.stringify(directorySnapshots.projects);
  if (directorySnapshots.libraryBooks.length) state['writer-library-books'] = JSON.stringify(directorySnapshots.libraryBooks);
  if (directorySnapshots.dismantleBooks.length) state['writer-dismantle-books'] = JSON.stringify(directorySnapshots.dismantleBooks);
  if (directorySnapshots.rankingBooks.length) state['writer-ranking-books'] = JSON.stringify(directorySnapshots.rankingBooks);
  if (directorySnapshots.writingStyles.length) state['writer-writing-styles'] = JSON.stringify(directorySnapshots.writingStyles);
  emitCloudProgress('应用数据读取完成，正在写入本机存储...');
  return { clientState: state };
};

const mobileBaiduStatus = async () => {
  const token = mobileBaiduToken();
  if (!token) return { authenticated: false, logged_in: false, raw: '未登录' };
  try {
    const data = await mobileBaiduRequest<Record<string, unknown>>(mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/nas', { method: 'uinfo', openapi: 'xpansdk', access_token: token }));
    return { ...data, authenticated: true, logged_in: true, username: stringValue(data.baidu_name || data.netdisk_name) };
  } catch (error) {
    localStorage.removeItem(baiduTokenKey);
    throw error;
  }
};

const mobileBaiduLoginURL = () => mobileBaiduURL('https://openapi.baidu.com/oauth/2.0/authorize', {
  client_id: baiduClientId, display: 'popup', qrcode: '1', redirect_uri: 'oob', response_type: 'token', scope: 'basic,netdisk',
});

const extractBaiduToken = (value: string) => {
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return new URLSearchParams(url.hash.replace(/^#/u, '')).get('access_token')
      || url.searchParams.get('access_token')
      || '';
  } catch {
    const match = raw.match(/(?:access_token[=:])([A-Za-z0-9._-]+)/u);
    return match?.[1] || raw;
  }
};

const mobileBaiduCompleteLogin = async (value: string) => {
  const token = extractBaiduToken(value);
  if (token.length < 20) throw new Error('授权结果中没有找到有效 access_token，请粘贴浏览器地址栏完整内容或 access_token。');
  localStorage.setItem(baiduTokenKey, token);
  try { return await mobileBaiduStatus(); } catch (error) { localStorage.removeItem(baiduTokenKey); throw error; }
};

const mobileBaiduForm = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');

const mobileCloudDirectory = (remotePath: string) => {
  const path = remotePath.trim().replace(/^\/+|\/+$/gu, '');
  if (!path || path.includes('..') || path.includes('\0') || path.includes('\\') || path.startsWith('.') || path.startsWith('~') || /^[A-Za-z]:/u.test(path)) {
    throw new Error('云端路径无效，只能使用 /apps/bdpan/ 下的相对路径。');
  }
  return { path, directory: `/apps/bdpan/${path}` };
};

const mobileCloudBackupPath = (remotePath: string, backupPath: string) => {
  const { path, directory } = mobileCloudDirectory(remotePath);
  const normalized = backupPath.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  const relative = normalized.startsWith('apps/bdpan/') ? normalized.slice('apps/bdpan/'.length) : normalized;
  if (!relative || relative.includes('..') || !relative.toLowerCase().endsWith('.aswbackup')) {
    throw new Error('所选云端文件不是有效的 ApiSaverWriter 备份包。');
  }
  const expectedPrefix = `${path}/`;
  if (!relative.startsWith(expectedPrefix) || relative.slice(expectedPrefix.length).includes('/')) {
    throw new Error('所选备份文件不在当前云端备份目录中。');
  }
  return { relative, fullPath: `${directory}/${relative.slice(expectedPrefix.length)}` };
};

const mobileBaiduEnsureDirectory = async (remotePath: string) => {
  const segments = remotePath.split('/').filter(Boolean);
  let current = '/apps/bdpan';
  for (const segment of segments) {
    current += `/${segment}`;
    try {
      await mobileBaiduRequest(mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/file', { method: 'create', openapi: 'xpansdk', access_token: mobileBaiduToken() }), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: mobileBaiduForm({ path: current, isdir: '1', rtype: '1' }),
      });
    } catch (error) {
      if (!/已存在|exist|errno.?-8|\/-8/u.test(String(error))) throw error;
    }
  }
};

const mobileBaiduUpload = async (remotePath: string, bytes: Uint8Array) => {
  const chunkSize = 4 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  const blockList = chunks.map(chunk => SparkMD5.ArrayBuffer.hash(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)));
  const path = `/apps/bdpan/${remotePath}/${baiduBackupName}`;
  const precreate = await mobileBaiduRequest<{ uploadid?: string; return_type?: number }>(mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/file', { method: 'precreate', openapi: 'xpansdk', access_token: mobileBaiduToken() }), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: mobileBaiduForm({ path, size: String(bytes.byteLength), isdir: '0', autoinit: '1', block_list: JSON.stringify(blockList), rtype: '3' }),
  });
  const uploadId = stringValue(precreate.uploadid);
  if (Number(precreate.return_type) !== 2 && !uploadId) throw new Error('百度网盘没有返回上传任务 ID。');
  if (Number(precreate.return_type) !== 2) {
    for (const [index, chunk] of chunks.entries()) {
      emitCloudProgress(`正在上传备份分片 ${index + 1}/${chunks.length}...`);
      const form = new FormData();
      form.append('file', new Blob([chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)]), baiduBackupName);
      await mobileBaiduRequest(mobileBaiduURL('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2', { method: 'upload', openapi: 'xpansdk', type: 'tmpfile', access_token: mobileBaiduToken(), path, uploadid: uploadId, partseq: String(index) }), { method: 'POST', headers: { 'User-Agent': 'pan.baidu.com' }, body: form });
    }
    await mobileBaiduRequest(mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/file', { method: 'create', openapi: 'xpansdk', access_token: mobileBaiduToken() }), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: mobileBaiduForm({ path, size: String(bytes.byteLength), isdir: '0', uploadid: uploadId, block_list: JSON.stringify(blockList), rtype: '3' }),
    });
  }
  return path;
};

const mobileBaiduTimeout = async <T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void) => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          onTimeout();
          reject(new Error('请求超时。'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

const mobileBaiduDownloadBytes = async (fetcher: typeof globalThis.fetch, url: string, label: string) => {
  const controller = new AbortController();
  const request = fetcher(url, { headers: { 'User-Agent': 'pan.baidu.com' }, signal: controller.signal });
  let response: Response;
  try {
    response = await mobileBaiduTimeout(request, 30_000, () => controller.abort());
  } catch (error) {
    controller.abort();
    throw new Error(`${label}连接超时（30 秒）：${String(error)}`);
  }
  if (!response.ok) throw new Error(`${label}失败（${response.status}）。`);
  const expected = Number(response.headers.get('content-length')) || 0;
  emitCloudProgress(expected ? `${label}已连接，准备下载 ${(expected / 1_048_576).toFixed(1)} MB...` : `${label}已连接，正在下载...`);
  if (!response.body) {
    const bytes = await mobileBaiduTimeout(response.arrayBuffer(), 30_000, () => controller.abort());
    return new Uint8Array(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const result = await mobileBaiduTimeout(reader.read(), 30_000, () => {
      controller.abort();
      void reader.cancel();
    });
    if (result.done) break;
    if (result.value?.byteLength) {
      chunks.push(result.value);
      received += result.value.byteLength;
      emitCloudProgress(expected
        ? `${label} ${Math.min(100, Math.round(received * 100 / expected))}%（${(received / 1_048_576).toFixed(1)}/${(expected / 1_048_576).toFixed(1)} MB）`
        : `${label} 已下载 ${(received / 1_048_576).toFixed(1)} MB`);
    }
  }
  return concatBytes(chunks);
};

const mobileBaiduListBackups = async (remotePath: string): Promise<{ files: CloudBackupFile[] }> => {
  const status = await mobileBaiduStatus();
  if (!status.authenticated) throw new Error('请先登录百度网盘，再查看云端备份。');
  const { path, directory } = mobileCloudDirectory(remotePath);
  const listURL = mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/file', {
    method: 'list', openapi: 'xpansdk', access_token: mobileBaiduToken(), dir: directory,
    order: 'time', desc: '1', start: '0', limit: '1000', web: '1',
  });
  const fetcher = await httpFetch();
  const response = await fetcher(listURL);
  const responseText = await response.text();
  if (!response.ok) throw new Error(`百度网盘备份列表加载失败（${response.status}）`);
  const data = JSON.parse(responseText) as {
    errno?: number;
    error_msg?: string;
    list?: Array<{ path?: string; server_filename?: string; fs_id?: number | string; size?: number; isdir?: number | boolean; server_mtime?: number | string; local_mtime?: number | string }>;
  };
  if (Number(data.errno || 0) !== 0) throw new Error(`百度网盘备份列表加载失败：${data.error_msg || `errno ${data.errno}`}`);
  const files = (data.list || []).flatMap((item): CloudBackupFile[] => {
    const name = stringValue(item.server_filename) || stringValue(item.path).split('/').pop() || '';
    const itemPath = stringValue(item.path);
    if (!name.toLowerCase().endsWith('.aswbackup') || Boolean(item.isdir) || !itemPath.startsWith(`${directory}/`)) return [];
    const rawTime = item.server_mtime ?? item.local_mtime;
    const numericTime = Number(rawTime);
    const modifiedAt = typeof rawTime === 'string' && /[T:-]/u.test(rawTime)
      ? rawTime
      : numericTime > 0 ? new Date(numericTime * 1000).toISOString() : '';
    return [{
      name,
      path: `${path}/${name}`,
      fsId: item.fs_id === undefined || item.fs_id === null ? undefined : String(item.fs_id),
      size: Number(item.size) || 0,
      modifiedAt,
      isBundle: true,
      source: 'bundle',
    }];
  }).sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { files };
};

const mobileBaiduDownload = async (remotePath: string, backupPath: string, backupFsId?: string) => {
  const selected = mobileCloudBackupPath(remotePath, backupPath);
  let fsId = backupFsId?.trim();
  if (!fsId) {
    const listed = await mobileBaiduListBackups(remotePath);
    fsId = listed.files.find(file => file.path === selected.relative)?.fsId;
  }
  if (!fsId) throw new Error('所选备份文件已不存在，请刷新备份列表后重试。');
  // filemetas expects a JSON array of numeric IDs. Keep the original decimal
  // string to avoid JavaScript precision loss for large Baidu fs_id values.
  const fsids = /^\d+$/u.test(String(fsId)) ? `[${String(fsId)}]` : JSON.stringify([String(fsId)]);
  const meta = await mobileBaiduRequest<{ list?: Array<{ dlink?: string }>}>(mobileBaiduURL('https://pan.baidu.com/rest/2.0/xpan/multimedia', { method: 'filemetas', openapi: 'xpansdk', access_token: mobileBaiduToken(), fsids, dlink: '1', extra: '1' }));
  const dlink = stringValue(meta.list?.[0]?.dlink);
  if (!dlink) throw new Error('百度网盘没有返回备份下载地址。');
  const fetcher = await httpFetch();
  const dlinkURL = `${dlink}${dlink.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(mobileBaiduToken())}`;
  let bytes: Uint8Array;
  try {
    bytes = await mobileBaiduDownloadBytes(fetcher, dlinkURL, '百度网盘完整备份下载');
  } catch (primaryError) {
    emitCloudProgress('主下载地址无响应，正在切换备用下载通道...');
    const fallbackURL = mobileBaiduURL('https://d.pcs.baidu.com/rest/2.0/pcs/file', {
      method: 'download', openapi: 'xpansdk', access_token: mobileBaiduToken(), path: selected.fullPath,
    });
    try {
      bytes = await mobileBaiduDownloadBytes(fetcher, fallbackURL, '百度网盘备用下载');
    } catch (fallbackError) {
      throw new Error(`百度网盘下载失败：${String(primaryError)}；备用通道：${String(fallbackError)}`);
    }
  }
  return readMobileBackupBundle(bytes);
};

const mobileBaiduBackup = async (remotePath: string, clientState: Record<string, string | null>) => {
  const status = await mobileBaiduStatus();
  if (!status.authenticated) throw new Error('请先登录百度网盘，再开始备份。');
  const path = remotePath.trim().replace(/^\/+|\/+$/gu, '');
  if (!path || path.includes('..')) throw new Error('云端路径无效，只能使用 /apps/bdpan/ 下的相对路径。');
  emitCloudProgress('正在整理完整应用备份...');
  const bundle = await mobileBackupBundle(clientState);
  await mobileBaiduEnsureDirectory(path);
  const remoteFile = await mobileBaiduUpload(path, bundle);
  emitCloudProgress('完整备份已上传到百度网盘。');
  return { remotePath: path, remoteFile, size: bundle.byteLength, scope: 'projects, books, dismantles, rankings, styles, client-state' };
};

const mobileBaiduRestore = async (remotePath: string, backupPath: string, backupFsId?: string) => {
  const status = await mobileBaiduStatus();
  if (!status.authenticated) throw new Error('请先登录百度网盘，再开始恢复。');
  const { path } = mobileCloudDirectory(remotePath);
  if (!backupPath.trim()) throw new Error('请先选择要恢复的云端备份文件。');
  const result = await mobileBaiduDownload(path, backupPath, backupFsId);
  emitCloudProgress('完整备份已下载，正在恢复本机数据。');
  return result;
};
const readUsage = (): MobileUsage => {
  try {
    const parsed = JSON.parse(localStorage.getItem(usageKey) || '') as Partial<MobileUsage>;
    return {
      inputTokens: Number(parsed.inputTokens) || 0, outputTokens: Number(parsed.outputTokens) || 0,
      totalTokens: Number(parsed.totalTokens) || 0, cachedInputTokens: Number(parsed.cachedInputTokens) || 0,
      cacheWriteTokens: Number(parsed.cacheWriteTokens) || 0, reasoningTokens: Number(parsed.reasoningTokens) || 0,
      requests: Number(parsed.requests) || 0, startedAt: stringValue(parsed.startedAt, new Date().toISOString()),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString() };
  }
};

const recordUsage = (usage: unknown) => {
  if (!usage || typeof usage !== 'object') return;
  const value = usage as Record<string, unknown>;
  const prompt = (value.prompt_tokens_details || value.input_tokens_details) as Record<string, unknown> | undefined;
  const completion = (value.completion_tokens_details || value.output_tokens_details) as Record<string, unknown> | undefined;
  const input = Number(value.prompt_tokens ?? value.input_tokens) || 0;
  const output = Number(value.completion_tokens ?? value.output_tokens) || 0;
  const next = readUsage();
  next.inputTokens += input;
  next.outputTokens += output;
  next.totalTokens += Number(value.total_tokens) || input + output;
  next.cachedInputTokens += Number(prompt?.cached_tokens ?? value.cached_tokens ?? value.prompt_cache_hit_tokens) || 0;
  next.cacheWriteTokens += Number(prompt?.cache_write_tokens ?? value.cache_creation_input_tokens) || 0;
  next.reasoningTokens += Number(completion?.reasoning_tokens) || 0;
  next.requests += 1;
  // iOS WKWebView has a small browser-storage quota. Usage telemetry must
  // never turn an otherwise successful model request or chapter save into an
  // error; project data itself is written through Tauri to the app directory.
  try { localStorage.setItem(usageKey, JSON.stringify(next)); } catch { /* Keep the current request successful. */ }
};

const compactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[已省略]';
  if (typeof value === 'string') return value.length > 18000 ? `${value.slice(0, 9000)}\n...[移动端上下文已压缩]...\n${value.slice(-7000)}` : value;
  if (Array.isArray(value)) return value.slice(-40).map(item => compactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(apiKey|apiKeys|proxyURL|proxyEnabled|proxyBypassLocal)$/u.test(key)) continue;
    output[key] = compactValue(item, depth + 1);
  }
  return output;
};

const schemaFor = (method: string) => {
  const schemas: Record<string, string> = {
    'project.generate': '{"title":"书名（仅在 field=title 时填写）","synopsis":"番茄风格简介（仅在 field=synopsis 时填写）"}',
    'outline.write': '{"title":"大纲标题","content":"Markdown 大纲正文"}',
    'card.write': '{"title":"卡片名称","content":"Markdown 卡片正文"}',
    'chapter.write': '{"content":"章节正文","summary":"本章摘要","consistency":"一致性检查"}',
    'memory.write': '{"summary":"摘要","keywords":[],"characterStateChanges":[],"knowledgeChanges":[],"foreshadowingChanges":[],"timelineEvents":[],"canonFacts":[],"conflicts":[],"endingHook":"","entities":[],"relations":[],"cardUpdates":[]}',
    'book.dismantle': '{"summary":"剧情摘要","detailedOutline":"章节章纲","plotBeats":[],"characterDynamics":[],"setupPayoff":[],"pacing":""}',
    'book.style.distill': '{"name":"文风名称","description":"文风说明","tags":[],"content":"Markdown 文风 Skill"}',
    'skill.write': '{"name":"技能名称","category":"write","description":"技能用途","tags":[],"content":"Markdown 技能正文"}',
  };
  return schemas[method] || '{"content":"处理结果"}';
};

const promptFor = (method: string, params: MobileParams) => {
  const context = JSON.stringify(compactValue(params), null, 2);
  const task = method === 'chapter.write'
    ? '你是中文长篇小说章节智能体。必须承接上一章结尾，严格遵守世界观、卡片、章纲和记忆，输出可直接保存的章节正文。不要输出分析过程。'
    : method === 'outline.write'
      ? '你是中文网文大纲智能体。根据作品资料与作者指令生成可执行的大纲，保持设定一致，不泄露总纲之外的未来情节。'
      : method === 'card.write'
        ? '你是中文小说知识卡片智能体。只根据作品资料补全当前卡片，明确事实、状态、关系和边界，不把推测写成事实。'
        : method === 'memory.write'
          ? '你是章节记忆编辑。只从正文抽取明确事实、人物状态、角色认知、时间线、伏笔、知识图谱关系和卡片变化。人物状态变化写入 characterStateChanges，角色知道了什么、隐瞒了什么写入 knowledgeChanges；这两个字段必须始终返回数组，正文有相关事实时不得留空。'
          : `你是小说写作助手，负责执行 ${method}。`;
  return `${task}\n\n输入资料（已移除密钥与网络配置）：\n${context}\n\n${method === 'text.transform' ? '只返回处理后的 content 字段。' : `严格只返回 JSON，不要 Markdown 代码围栏或额外解释。JSON 结构：${schemaFor(method)}`}`;
};

const parseJSON = <T>(content: string): T | null => {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();
  try { return JSON.parse(cleaned) as T; } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { return null; } }
    return null;
  }
};

const memoryField = (result: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) {
    const value = result[name];
    if ((Array.isArray(value) && value.length) || (typeof value === 'string' && value.trim())) return value;
  }
  return [];
};

/** Normalise model-specific memory keys before App.tsx persists the chapter snapshot. */
const normalizeMobileMemoryResult = (value: Record<string, unknown>, rawContent: string): Record<string, unknown> => {
  // Some providers wrap the JSON object in a `content` string.
  let result = value;
  if (typeof value.content === 'string' && value.content.trim().startsWith('{')) {
    result = parseJSON<Record<string, unknown>>(value.content) || value;
  }
  const summary = stringValue(result.summary || result.摘要 || result.chapterSummary || result.chapter_summary, rawContent.slice(0, 220)).trim();
  return {
    ...result,
    summary,
    keywords: memoryList(memoryField(result, 'keywords', '关键词', 'key_words'), 8),
    characterStateChanges: memoryList(memoryField(result, 'characterStateChanges', 'character_state_changes', 'characterChanges', 'character_changes', '人物状态变化', '人物状态', '角色状态变化')),
    knowledgeChanges: memoryList(memoryField(result, 'knowledgeChanges', 'knowledge_changes', 'characterKnowledgeChanges', 'roleKnowledgeChanges', '角色认知变化', '角色认知', '认知变化', '知识变化')),
    foreshadowingChanges: memoryList(memoryField(result, 'foreshadowingChanges', 'foreshadowing_changes', '伏笔变化', '伏笔进展')),
    timelineEvents: memoryList(memoryField(result, 'timelineEvents', 'timeline_events', '时间线事件', '时间线')),
    canonFacts: memoryList(memoryField(result, 'canonFacts', 'canon_facts', '设定事实', '世界观事实')),
    conflicts: memoryList(memoryField(result, 'conflicts', '冲突', '冲突变化')),
    endingHook: stringValue(result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子).trim(),
  };
};

const mobilePromptByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const mobilePromptWhitespace = (value: unknown) => String(value ?? '')
  .replace(/\r\n?/gu, '\n')
  .split('\n')
  .map(line => line.trim().replace(/[ \t]{2,}/gu, ' '))
  .join('\n')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

const mobileSliceToBytes = (value: string, maxBytes: number) => {
  if (mobilePromptByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (mobilePromptByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
};

const mobileCompactPromptText = (value: unknown, maxBytes: number) => {
  const text = mobilePromptWhitespace(value);
  if (!text || maxBytes <= 0 || mobilePromptByteLength(text) <= maxBytes) return text;
  const marker = '\n...[已按相关性与预算裁剪]...\n';
  const available = Math.max(0, maxBytes - mobilePromptByteLength(marker));
  const head = mobileSliceToBytes(text, Math.floor(available * 0.62));
  const tailCharacters = Array.from(text).reverse().join('');
  const tail = Array.from(mobileSliceToBytes(tailCharacters, Math.max(0, available - mobilePromptByteLength(head)))).reverse().join('');
  return `${head}${marker}${tail}`;
};

const mobileMemorySystemPrompt = `你是长篇小说的记忆编辑。只从章节正文与给定的相关资料抽取明确事实，不补写未发生的剧情。

输出必须是严格 JSON 对象，不要代码围栏或解释。摘要应简短、可检索、包含事件推进、人物状态和未解决线索。实体与关系必须有正文依据；卡片只在状态确有变化且正文能证明时更新。`;

const mobileKnowledgeGraphSummary = (value: unknown, query: string, maxBytes = 2400) => {
  if (!value || typeof value !== 'object') return '';
  const graph = value as Record<string, unknown>;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const queryText = query.toLocaleLowerCase();
  const selectedIds = new Set(nodes.filter(node => {
    const label = stringValue(node.label).trim();
    return Boolean(label) && queryText.includes(label.toLocaleLowerCase());
  }).map(node => String(node.id || '')));
  edges.forEach(edge => {
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (selectedIds.has(source) || selectedIds.has(target)) {
      selectedIds.add(source);
      selectedIds.add(target);
    }
  });
  const selectedNodes = nodes.filter(node => selectedIds.has(String(node.id || ''))).slice(0, 30);
  const selectedEdges = edges.filter(edge => selectedIds.has(String(edge.source || '')) && selectedIds.has(String(edge.target || ''))).slice(0, 60);
  if (!selectedNodes.length && !selectedEdges.length) return '';
  const labels = new Map(selectedNodes.map(node => [String(node.id || ''), stringValue(node.label, String(node.id || '实体'))]));
  const lines = [
    ...selectedNodes.map(node => `实体：${stringValue(node.label, '未命名')}（${stringValue(node.category || node.type, '实体')}）`),
    ...selectedEdges.map(edge => `关系：${labels.get(String(edge.source || '')) || String(edge.source || '')} -[${stringValue(edge.label, '关联')}]-> ${labels.get(String(edge.target || '')) || String(edge.target || '')}（权重 ${Number(edge.weight) || 0.7}）`),
  ];
  return mobileCompactPromptText(lines.join('\n'), maxBytes);
};

const mobileMemoryMessages = (params: MobileParams): ChatMessage[] => {
  const projectTitle = stringValue(params.projectTitle, '未命名小说');
  const chapterTitle = stringValue(params.chapterTitle, '未命名章节');
  const content = stringValue(params.content);
  const contextWindowKB = Math.max(16, Number(params.contextWindow) || 128);
  const chapterBudget = Math.min(20 * 1024, Math.max(8 * 1024, Math.floor(contextWindowKB * 1024 * 0.16)));
  const chapterContent = mobileCompactPromptText(content, chapterBudget);
  const cards = Array.isArray(params.cards)
    ? params.cards.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>
    : [];
  const relevantCards = cards.filter(card => {
    const title = stringValue(card.title).trim();
    return Boolean(title) && content.includes(title);
  }).slice(0, 10);
  const cardContext = relevantCards.length
    ? `\n## 正文命中的卡片（仅可更新这些卡片）\n${relevantCards.map(card => {
      const history = Array.isArray(card.stateHistory)
        ? card.stateHistory.slice(-2).map(item => item && typeof item === 'object' ? mobileCompactPromptText((item as Record<string, unknown>).changes, 180) : '').filter(Boolean).join('；')
        : '';
      return `${String(card.id || '')} | ${mobileCompactPromptText(card.title || '卡片', 100)}\n当前状态：${mobileCompactPromptText(card.currentState || '暂无', 360)}${history ? `\n近期变化：${history}` : ''}\n知识：${mobileCompactPromptText(card.content || '', 720)}`;
    }).join('\n\n')}`
    : '';
  const graphSummary = mobileKnowledgeGraphSummary(params.knowledgeGraph, `${chapterTitle}\n${chapterContent}\n${relevantCards.map(card => stringValue(card.title)).join(' ')}`);
  const graphContext = graphSummary ? `\n## 相关知识图谱（用于增量更新）\n${graphSummary}` : '';
  const prompt = `请为《${projectTitle}》的${chapterTitle}整理可检索的结构化章节记忆，并从正文抽取有证据的实体、关系和卡片变化。

## 本章正文
${chapterContent}${cardContext}${graphContext}

返回 JSON：
{
  "summary": "180 字以内的事件、人物状态和未解决线索",
  "keywords": ["最多 8 个关键词"],
  "characterStateChanges": ["角色名：本章结束时的位置、身体、情绪、能力、关系或目标状态变化"],
  "knowledgeChanges": ["角色名：本章新得知、确认、误解或仍被隐瞒的信息"],
  "foreshadowingChanges": ["已有伏笔的新增进展，或本章新埋且后续可回收的明确线索"],
  "foreshadowingItems": [{"text":"伏笔内容","status":"active|progressing|resolved|overdue","priority":"high|normal|low","plantedChapter":1,"targetChapter":5}],
  "timelineEvents": ["按发生顺序记录的关键事件"],
  "canonFacts": ["后续写作必须遵守且本章已确认的设定事实"],
  "conflicts": ["冲突双方、起因、本章结果与尚未解决部分"],
  "endingHook": "章末最后一个未解决事项或下一章必须承接的钩子",
  "entities": [{"name":"实体","type":"人物|物品|地点|势力|事件|设定"}],
  "relations": [{"source":"实体","target":"实体","label":"关系","weight":0.7}],
  "cardUpdates": [{"cardId":"卡片 ID","cardTitle":"卡片名称","status":"changed|acquired|lost|revealed|updated","changes":"有正文依据的变化"}]
}

分类必须互不混写：人物状态只写角色自身状态；角色认知必须明确写谁知道什么；伏笔只写可在后文回收的线索；冲突必须写双方和当前结果。正文明确存在相关事实时不得遗漏；确实不存在时使用空数组，不要用“暂无”“待补充”凑数。关系 weight 为 0.1 到 1.0 的正文证据强度：明确行动、身份、持有或状态变化为 0.85 以上；直接提及为 0.65 至 0.8；推断性弱关联不超过 0.6。实体不超过 30 个，关系不超过 60 条。`;
  return [
    { role: 'system', content: mobileMemorySystemPrompt },
    { role: 'user', content: prompt },
  ];
};

const emitProgress = (runId: string, payload: Record<string, unknown>) => {
  if (!runId) return;
  window.dispatchEvent(new CustomEvent('agent-progress', { detail: { ...payload, runId } }));
};

const mobileResponseText = (value: unknown, depth = 0): string => {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => mobileResponseText(item, depth + 1)).join('');
  if (typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.output_text === 'string') return item.output_text;
  if (typeof item.content === 'string') return item.content;
  return mobileResponseText(item.content, depth + 1)
    || mobileResponseText(item.output, depth + 1)
    || mobileResponseText(item.message, depth + 1);
};

async function mobileChat(params: MobileParams, messages: ChatMessage[], onChunk?: (chunk: string) => void, jsonMode = false): Promise<{ content: string; usage?: unknown }> {
  const fetcher = await httpFetch();
  // Keep mobile on the same verified OpenAI-compatible wire as desktop.
  const apiMode = 'openai';
  const model = stringValue(params.model, 'gpt-4o-mini');
  // ApiSaver's Gemini-compatible routes can reject OpenAI's response_format
  // option upstream. The prompt still asks for JSON, so parsing remains safe.
  const supportsJsonMode = !/^gemini(?:[-:/]|$)/iu.test(model.trim());
  const configuredKeys = Array.from(new Set([stringValue(params.apiKey), ...arrayStrings(params.apiKeys)].map(key => key.trim()).filter(Boolean)));
  const knownModelKeys = configuredKeys.filter(key => mobileModelsByApiKey.get(key)?.has(model));
  const allKeysKnown = configuredKeys.length > 0 && configuredKeys.every(key => mobileModelsByApiKey.has(key));
  if (!knownModelKeys.length && allKeysKnown) throw new Error(`当前配置的 API Key 都不支持模型 ${model}。请重新拉取模型并选择该模型对应的 API Key。`);
  const keys = knownModelKeys.length ? knownModelKeys : configuredKeys;
  if (!keys.length) throw new Error('请先在设置中填写 API Key。');
  const base = baseURL(params.baseURL);
  let endpoint = `${base}/chat/completions`;
  let body: Record<string, unknown>;
  const maxTokens = jsonMode ? 1300 : 6000;
  const temperature = jsonMode ? 0.2 : 0.7;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: onChunk ? 'text/event-stream' : 'application/json' };
  body = { model, messages, temperature, max_tokens: maxTokens, stream: Boolean(onChunk), ...(onChunk ? { stream_options: { include_usage: true } } : {}), ...(jsonMode && supportsJsonMode ? { response_format: { type: 'json_object' } } : {}) };
  headers.Authorization = `Bearer ${keys[0]}`;
  let response: Response | null = null;
  let lastError = '';
  for (const key of keys) {
    const requestHeaders = { ...headers };
    requestHeaders.Authorization = `Bearer ${key}`;
    let candidate = await fetcher(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
    if (candidate.ok) {
      response = candidate;
      break;
    }
    const detail = (await candidate.text()).replace(/\s+/gu, ' ').slice(0, 220);
    lastError = `模型接口返回 ${candidate.status}：${detail}`;
    // A key may be out of quota or lack this model while another configured
    // key remains usable. Continue through the configured key pool.
  }
  if (!response) throw new Error(lastError || '所有 API Key 请求均失败。');
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/gu, ' ').slice(0, 220);
    if (isQuotaExceeded(detail)) {
      throw new Error('API 中转服务额度已用尽。章节正文已保存，本章记忆将在额度恢复后再更新。');
    }
    throw new Error(`模型接口返回 ${response.status}：${detail}`);
  }
  if (!onChunk || !response.body || apiMode !== 'openai') {
    const data = await response.json() as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const content = mobileResponseText(message?.content)
      || mobileResponseText(data.output_text)
      || mobileResponseText(data.content)
      || mobileResponseText(data.output);
    recordUsage(data.usage);
    return { content, usage: data.usage };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: unknown;
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const raw = line.trim().replace(/^data:\s*/u, '');
      if (!raw || raw === '[DONE]') continue;
      try {
        const event = JSON.parse(raw) as Record<string, unknown>;
        usage = event.usage || usage;
        const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> : undefined;
        const delta = choice?.delta as Record<string, unknown> | undefined;
        const chunk = stringValue(delta?.content);
        if (chunk) { content += chunk; onChunk(chunk); }
      } catch { /* Ignore keep-alives and malformed proxy fragments. */ }
    }
    if (next.done) break;
  }
  recordUsage(usage);
  return { content, usage };
}

const mobileResolveURL = (base: string, value: string) => {
  try { return value ? new URL(value, base).toString() : ''; } catch { return ''; }
};

const mobileFetchHTML = async (url: string, encoding = 'utf-8', init: RequestInit = {}) => {
  const fetcher = await httpFetch();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  const initialHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ...(init.headers as Record<string, string> || {}),
  };
  const withoutAuthorization = Object.fromEntries(Object.entries(initialHeaders).filter(([key]) => key.toLowerCase() !== 'authorization'));
  try {
    const execute = (headers: Record<string, string>) => fetcher(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    let response = await execute(initialHeaders);
    if ((response.status === 401 || response.status === 403) && Object.keys(initialHeaders).some(key => key.toLowerCase() === 'authorization')) {
      response = await execute(withoutAuthorization);
    }
    if (!response.ok) throw new Error(`书源返回 HTTP ${response.status}`);
    return new TextDecoder(encoding).decode(await response.arrayBuffer());
  } finally {
    window.clearTimeout(timer);
  }
};

const mobileChineseNumber = (value: string) => {
  const match = value.replace(/,/gu, '').match(/([\d.]+)\s*(万|亿)?/u);
  if (!match) return undefined;
  const multiplier = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) ? Math.round(number) : undefined;
};

const mobileNovelCatchCategories = async () => {
  const sections = [
    { key: 'male-read', label: '男频阅读', gender: 'm', list: 'read' },
    { key: 'male-new', label: '男频新书', gender: 'm', list: 'new' },
    { key: 'female-read', label: '女频阅读', gender: 'f', list: 'read' },
    { key: 'female-new', label: '女频新书', gender: 'f', list: 'new' },
  ];
  const result = await Promise.all(sections.map(async section => {
    const url = `https://novelcatch.com/rank?gender=${section.gender}&list=${section.list}`;
    const document = new DOMParser().parseFromString(await mobileFetchHTML(url), 'text/html');
    const seen = new Set<string>();
    const categories = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/rank?"]')).flatMap(link => {
      const target = mobileResolveURL(url, link.getAttribute('href') || '');
      if (!target || seen.has(target)) return [];
      const parsed = new URL(target);
      const category = parsed.searchParams.get('category');
      if (!category || parsed.searchParams.get('gender') !== section.gender || parsed.searchParams.get('list') !== section.list) return [];
      seen.add(target);
      return [{ id: category, label: link.textContent?.trim() || category, url: target, gender: section.gender === 'f' ? 'female' : 'male', list: section.list }];
    });
    return { key: section.key, label: section.label, url, categories };
  }));
  return { sections: result };
};

const mobileRankingFetch = async (params: MobileParams) => {
  const platform = stringValue(params.platform, 'fanqie');
  const rankType = stringValue(params.rankType, 'read');
  const gender = stringValue(params.gender, 'male');
  if (platform === 'fanqie') {
    const url = /^https:\/\/novelcatch\.com\/rank\?/u.test(stringValue(params.rankUrl))
      ? stringValue(params.rankUrl)
      : `https://novelcatch.com/rank?gender=${gender === 'female' ? 'f' : 'm'}&list=${rankType === 'new' ? 'new' : 'read'}&category=all`;
    const document = new DOMParser().parseFromString(await mobileFetchHTML(url), 'text/html');
    const seen = new Set<string>();
    const books = Array.from(document.querySelectorAll<HTMLElement>('div.border-b.border-line')).flatMap((card, index) => {
      const titleLink = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href^="/book/"]')).find(link => link.textContent?.trim());
      const href = titleLink?.getAttribute('href') || '';
      const bookId = href.match(/\/(\d+)$/u)?.[1] || '';
      const title = titleLink?.textContent?.trim() || '';
      if (!bookId || !title || seen.has(bookId)) return [];
      seen.add(bookId);
      const info = card.querySelector<HTMLElement>('.mt-1.flex.flex-wrap.items-center')?.textContent?.replace(/\s+/gu, ' ').trim() || '';
      const infoParts = info.split('·').map(item => item.trim()).filter(Boolean);
      const cardText = card.textContent?.replace(/\s+/gu, ' ').trim() || '';
      const readMatch = cardText.match(/([\d.]+\s*万?)在读/u);
      const rankText = card.querySelector<HTMLElement>('[class*="font-mono"]')?.textContent?.trim() || '';
      return [{
        id: `fanqie:${bookId}`, sourceId: 'novelcatch-rank', sourceBookId: bookId, title,
        author: infoParts[0] || '未知作者', intro: card.querySelector<HTMLElement>('p.line-clamp-2')?.textContent?.replace(/\s+/gu, ' ').trim() || '',
        cover: mobileResolveURL(url, card.querySelector<HTMLImageElement>('img')?.getAttribute('src') || '') || undefined,
        category: card.querySelector<HTMLAnchorElement>('a[href^="/category/"]')?.textContent?.trim() || undefined,
        rank: Number(rankText) || index + 1, rankType, gender, platform: 'fanqie', url: `https://fanqienovel.com/page/${bookId}`,
        wordCount: mobileChineseNumber(infoParts.find(item => /字$/u.test(item)) || ''), readCount: readMatch ? mobileChineseNumber(readMatch[1]) : undefined,
      }];
    }).slice(0, 60);
    if (!books.length) throw new Error('番茄榜单页面没有返回可解析书籍，请稍后刷新。');
    return { books, fetchedAt: new Date().toISOString(), sourceName: '番茄小说网' };
  }
  if (platform === 'qidian') {
    const path = rankType === 'new' ? 'signnewbook' : rankType === 'read' ? 'readindex' : 'yuepiao';
    const url = `https://www.qidian.com/rank/${path}/`;
    const html = await mobileFetchHTML(url);
    if (/C2WF946J0\/probe\.js|var\s+buid\s*=|challenge|verify/iu.test(html)) throw new Error(`起点中文网${path}返回了反爬校验页，请更换代理出口或稍后重试`);
    const document = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-rid], li.rank-list-item, .rank-list .book-mid-info'));
    const books = rows.flatMap((row, index) => {
      const titleLink = row.querySelector<HTMLAnchorElement>('.book-mid-info h2 a, h2 a, a[href*="/book/"]');
      const title = titleLink?.textContent?.trim() || '';
      const href = mobileResolveURL(url, titleLink?.getAttribute('href') || '');
      if (!title || !href) return [];
      const bookId = titleLink?.getAttribute('data-bid') || href.match(/\/book\/(\d+)/u)?.[1] || String(index);
      const authorLinks = Array.from(row.querySelectorAll<HTMLAnchorElement>('.book-mid-info .author a, .author a'));
      return [{ id: `qidian:${bookId}`, sourceBookId: bookId, title, author: row.querySelector<HTMLElement>('.author a.name, .author a')?.textContent?.trim() || '未知作者', intro: row.querySelector<HTMLElement>('.intro, [class*="intro"]')?.textContent?.trim() || '', cover: mobileResolveURL(url, row.querySelector<HTMLImageElement>('.book-img-box img, img')?.getAttribute('src') || '') || undefined, category: authorLinks.slice(1).map(item => item.textContent?.trim()).filter(Boolean).join(' · ') || undefined, rank: Number(row.dataset.rid) || index + 1, rankType, gender: 'all', platform: 'qidian', url: href }];
    }).slice(0, 60);
    if (books.length) return { books, fetchedAt: new Date().toISOString(), sourceName: '起点中文网官网' };
    const fallbackSeen = new Set<string>();
    const fallbackBooks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/book/"]')).flatMap((link, index) => {
      const href = mobileResolveURL(url, link.getAttribute('href') || '');
      const bookId = href.match(/\/book\/(\d+)/u)?.[1] || '';
      const title = link.textContent?.replace(/\s+/gu, ' ').trim() || '';
      if (!bookId || !title || fallbackSeen.has(bookId)) return [];
      fallbackSeen.add(bookId);
      const card = link.closest('li, article, .book-mid-info, [class*="book"]') || link.parentElement;
      return [{ id: `qidian:${bookId}`, sourceBookId: bookId, title, author: card?.querySelector<HTMLElement>('.author a, [class*="author"]')?.textContent?.trim() || '未知作者', intro: card?.querySelector<HTMLElement>('.intro, [class*="intro"]')?.textContent?.trim() || '', cover: mobileResolveURL(url, card?.querySelector<HTMLImageElement>('img')?.getAttribute('src') || '') || undefined, rank: index + 1, rankType, gender: 'all', platform: 'qidian', url: href }];
    }).slice(0, 60);
    if (!fallbackBooks.length) throw new Error(`起点中文网${path}未找到书籍条目，官网结构可能已变化`);
    return { books: fallbackBooks, fetchedAt: new Date().toISOString(), sourceName: '起点中文网官网' };
  }
  if (platform === 'faloo') {
    const url = 'https://b.faloo.com/SR_1.html';
    const document = new DOMParser().parseFromString(await mobileFetchHTML(url, 'gb18030'), 'text/html');
    const books = Array.from(document.querySelectorAll<HTMLElement>('.c_td_d_data')).flatMap((row, index) => {
      const titleLink = row.querySelector<HTMLAnchorElement>('.c_td_d_d_title a');
      const title = titleLink?.textContent?.trim() || '';
      const href = mobileResolveURL(url, titleLink?.getAttribute('href') || '');
      if (!title || !href) return [];
      const bookId = href.match(/\/(\d+)\.html/u)?.[1] || String(index);
      return [{ id: `faloo:${bookId}`, sourceBookId: bookId, title, author: row.querySelector<HTMLElement>('.c_td_d_d_author')?.textContent?.trim() || '未知作者', intro: '', cover: mobileResolveURL(url, row.querySelector<HTMLImageElement>('.c_td_d_d_img img')?.getAttribute('src') || '').replace(/^http:/iu, 'https:') || undefined, category: row.querySelector<HTMLElement>('.c_td_d_d_class')?.textContent?.trim() || undefined, rank: Number(row.querySelector<HTMLElement>('[class^="c_td_d_d_number"]')?.textContent?.trim()) || index + 1, rankType: 'read', gender: 'all', platform: 'faloo', url: href }];
    }).slice(0, 60);
    if (!books.length) throw new Error('飞卢24小时畅销榜没有返回可解析书籍。');
    return { books, fetchedAt: new Date().toISOString(), sourceName: '飞卢中文网官网' };
  }
  throw new Error('未知扫榜平台。');
};

const mobileFanqieSearch = async (query: string) => {
  const encoded = encodeURIComponent(query);
  const endpoint = `https://fanqienovel.com/api/author/search/search_book/v1?filter=127%2C127%2C127%2C127&page_count=20&page_index=0&query_type=0&query_word=${encoded}`;
  const books: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  try {
    const payload = JSON.parse(await mobileFetchHTML(endpoint, 'utf-8')) as Record<string, unknown>;
    const root = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload;
    const list = Array.isArray(root.search_book_data_list) ? root.search_book_data_list : [];
    list.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const sourceBookId = String(record.book_id || record.bookId || record.id || '').trim();
      const title = String(record.book_name || record.bookName || record.title || '').trim();
      if (!sourceBookId || !title || seen.has(sourceBookId)) return;
      seen.add(sourceBookId);
      books.push({ id: `fanqie:${sourceBookId}`, sourceId: 'fanqie', sourceBookId, source: '番茄小说', title,
        author: String(record.author || record.author_name || '未知作者'), intro: String(record.abstract || record.introduction || record.description || '').slice(0, 320),
        cover: String(record.thumb_url || record.thumbUri || record.cover || '') || undefined, category: String(record.category || '') || undefined,
        wordCount: Number(record.word_count || record.wordCount) || undefined, url: `https://fanqienovel.com/page/${sourceBookId}` });
    });
  } catch { /* Search pages can be challenged; the HTML fallback below remains available. */ }
  if (!books.length) {
    try {
      const document = new DOMParser().parseFromString(await mobileFetchHTML(`https://fanqienovel.com/search/${encoded}`), 'text/html');
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/page/"]')).forEach(link => {
        const sourceBookId = link.getAttribute('href')?.match(/\/page\/(\d+)/u)?.[1] || '';
        const title = link.textContent?.replace(/\s+/gu, ' ').trim() || '';
        if (!sourceBookId || !title || seen.has(sourceBookId)) return;
        seen.add(sourceBookId);
        books.push({ id: `fanqie:${sourceBookId}`, sourceId: 'fanqie', sourceBookId, source: '番茄小说', title, author: '未知作者', intro: '', url: `https://fanqienovel.com/page/${sourceBookId}` });
      });
    } catch { /* Return a normal empty search result instead of invoking the model. */ }
  }
  return { books: books.slice(0, 100), searchedSourceCount: 1, responsiveSourceCount: 1, failedSourceCount: 0 };
};

const mobileQianyueSources = (qianyueSourceData as MobileQianyueSource[])
  .map((source, index) => ({ ...source, id: source.bookSourceName === '酷我小说[api]' ? 'qianyue-kuwo' : `qianyue-${index}`, name: String(source.bookSourceName || `千阅书源 ${index + 1}`) }))
  .filter(source => source.enabled !== false && Boolean(source.bookSourceUrl) && Boolean(source.searchUrl) && !/^(?:@js:|<js>|\{\{)/iu.test(String(source.searchUrl)));

const mobileSourceBase = (source: MobileQianyueSource) => String(source.bookSourceUrl || '').split('##')[0].trim().replace(/\/+$/u, '');
const mobileSourceHeaders = (source: MobileQianyueSource): Record<string, string> => {
  const raw = String(source.header || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw.replace(/'/gu, '"')) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
    if (authorization) {
      const token = authorization[1].replace(/^Bearers+/iu, '').trim();
      const payload = token.split('.')[1];
      if (payload) {
        try {
          const normalized = payload.replace(/-/gu, '+').replace(/_/gu, '/');
          const exp = Number(JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))).exp);
          if (Number.isFinite(exp) && exp > 0 && exp <= Math.floor(Date.now() / 1000)) delete headers[authorization[0]];
        } catch { /* Keep opaque non-JWT authorization headers. */ }
      }
    }
    return headers;
  } catch { return {}; }
};

const mobileRuleTemplate = (template: unknown, item: unknown, query: string, page = 1, baseUrl = '') => String(template || '')
  .replace(/\{\{key\}\}/giu, encodeURIComponent(query))
  .replace(/\{\{page(?:-1)?\}\}/giu, match => match.includes('-1') ? '0' : String(page))
  .replace(/\{\{baseUrl\}\}/giu, baseUrl)
  .replace(/\{\{baseUrl\.replace\(['"]([^'"]*)['"],['"]([^'"]*)['"]\)\}\}/giu, (_match, from: string, to: string) => baseUrl.replace(from, to))
  .replace(/\{\{?\$\.([^}]+)\}\}?/gu, (_match, path: string) => String(mobileJsonPath(item, `$.${path.trim()}`)[0] ?? ''));

type MobileSourceRequest = { url: string; method: 'GET' | 'POST'; body?: string; headers: Record<string, string>; encoding: string };

const mobileSourceRequestFromRule = (source: MobileQianyueSource, rule: unknown, item: unknown, query = '', page = 1): MobileSourceRequest | null => {
  const raw = mobileRuleTemplate(rule, item, query, page, mobileSourceBase(source)).trim();
  if (!raw || /^(?:@js:|<js>|\{\{)/iu.test(raw)) return null;
  const descriptorIndex = raw.search(/,\s*\{/u);
  const urlPart = (descriptorIndex >= 0 ? raw.slice(0, descriptorIndex) : raw).replace(/\n/gu, '').trim();
  let descriptor: Record<string, unknown> = {};
  if (descriptorIndex >= 0) {
    try { descriptor = JSON.parse(raw.slice(descriptorIndex + 1).trim()) as Record<string, unknown>; } catch { return null; }
  }
  let url = '';
  try { url = new URL(urlPart, `${mobileSourceBase(source)}/`).toString(); } catch { return null; }
  const method = String(descriptor.method || (descriptor.body ? 'POST' : 'GET')).toUpperCase() === 'POST' ? 'POST' : 'GET';
  const body = typeof descriptor.body === 'string' ? mobileRuleTemplate(descriptor.body, {}, query, page) : undefined;
  const headers = { ...mobileSourceHeaders(source), ...(descriptor.headers && typeof descriptor.headers === 'object' ? descriptor.headers as Record<string, string> : {}) };
  if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  return { url, method, body, headers, encoding: String(descriptor.charset || 'utf-8') };
};

const mobileSourceRequest = (source: MobileQianyueSource, query: string, page = 1): MobileSourceRequest | null => mobileSourceRequestFromRule(source, source.searchUrl, {}, query, page);

const mobileJsonPath = (input: unknown, rawRule: unknown): unknown[] => {
  const rule = String(rawRule || '').replace(/^@JSon:/iu, '').split('##')[0].replace(/\{\{?|\}\}?/gu, '').trim();
  if (!rule) return [];
  const alternatives = rule.split('||').map(item => item.trim()).filter(Boolean);
  const walk = (value: unknown, parts: string[]): unknown[] => {
    if (!parts.length) return Array.isArray(value) ? value : [value];
    const [part, ...rest] = parts;
    if (part === '*' || part === '[*]') return Array.isArray(value) ? value.flatMap(item => walk(item, rest)) : [];
    const keyMatch = part.match(/^([^[]+)?(?:\[(\d+|\*)\])?$/u);
    if (!keyMatch) return [];
    const key = keyMatch[1];
    const index = keyMatch[2];
    const next = key ? value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined : value;
    if (index === '*') return Array.isArray(next) ? next.flatMap(item => walk(item, rest)) : [];
    if (index !== undefined) return Array.isArray(next) ? walk(next[Number(index)], rest) : [];
    return walk(next, rest);
  };
  const recursive = (value: unknown, key: string): unknown[] => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    return Object.entries(record).flatMap(([entryKey, entryValue]) => [
      ...(entryKey === key ? (Array.isArray(entryValue) ? entryValue : [entryValue]) : []),
      ...recursive(entryValue, key),
    ]);
  };
  for (const alternative of alternatives) {
    if (alternative.startsWith('$..')) {
      const values = recursive(input, alternative.slice(3).split(/[.[\]]/u)[0]);
      if (values.length) return values;
      continue;
    }
    const parts = alternative.replace(/^\$\.?/u, '').split('.').filter(Boolean);
    const values = walk(input, parts);
    if (values.length) return values;
  }
  return [];
};

const mobileRuleText = (value: string, rule: unknown) => {
  const raw = String(rule || '').trim();
  if (!raw) return '';
  const sections = raw.split('##');
  let output = value;
  if (sections[1]) {
    try { output = output.replace(new RegExp(sections[1], 'gu'), sections[2] || ''); } catch { /* Ignore invalid source regex. */ }
  }
  return output.replace(/\s+/gu, ' ').trim();
};

const mobileCssSelector = (part: string) => part
  .replace(/^class\./iu, '.')
  .replace(/^id\./iu, '#')
  .replace(/^tag\./iu, '')
  .replace(/!\d+$/u, '')
  .replace(/:\d+$/u, '');

const mobileHtmlNodes = (root: ParentNode, selectorRule: string): Element[] => {
  const selector = mobileCssSelector(selectorRule.split('@')[0].trim());
  if (!selector || selector.startsWith('@')) return [];
  try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
};

const mobileHtmlValue = (root: Element, rule: unknown, baseUrl: string): string => {
  const alternatives = String(rule || '').split('&&').map(item => item.trim()).filter(Boolean);
  for (const alternative of alternatives) {
    const sections = alternative.split('##');
    const chain = sections[0].split('@').map(item => item.trim()).filter(Boolean);
    let nodes: Element[] = [root];
    let mode = 'text';
    for (const part of chain) {
      if (part === 'text' || part === 'textNodes') { mode = 'text'; continue; }
      if (part === 'href' || part === 'src' || part === 'title' || part === 'onclick') { mode = part; continue; }
      const indexMatch = part.match(/^(.*)\.(\d+)$/u);
      const selector = mobileCssSelector(indexMatch?.[1] || part);
      const index = indexMatch ? Number(indexMatch[2]) : 0;
      nodes = nodes.flatMap(node => mobileHtmlNodes(node, selector).slice(index, index + 1));
      if (!nodes.length) break;
    }
    const node = nodes[0];
    if (!node) continue;
    let value = mode === 'text' ? node.textContent || '' : node.getAttribute(mode) || '';
    value = mobileRuleText(value, sections.length > 1 ? `##${sections.slice(1).join('##')}` : '');
    if ((mode === 'href' || mode === 'src') && value) {
      try { value = new URL(value, baseUrl).toString(); } catch { /* Keep original URL. */ }
    }
    if (value) return value;
  }
  return '';
};

const mobileSearchOneQianyueSource = async (source: MobileQianyueSource & { id: string; name: string }, query: string): Promise<Record<string, unknown>[]> => {
  const request = mobileSourceRequest(source, query);
  if (!request) return [];
  const html = await mobileFetchHTML(request.url, request.encoding, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
  });
  const payload = html.trim();
  const rule = source.ruleSearch || {};
  let json: unknown = null;
  try { json = JSON.parse(payload) as unknown; } catch { /* HTML source. */ }
  const baseUrl = mobileSourceBase(source) || request.url;
  const items = json !== null ? mobileJsonPath(json, rule.bookList) : mobileHtmlNodes(new DOMParser().parseFromString(payload, 'text/html'), String(rule.bookList || ''));
  return items.map((item, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const scalar = (field: string) => {
      if (json === null) return mobileHtmlValue(item instanceof Element ? item : document.createElement('div'), rule[field], baseUrl);
      const rawRule = String(rule[field] || '').trim();
      const expanded = mobileRuleTemplate(rawRule, item, query).trim();
      const hasTemplateValue = expanded !== rawRule && !/@js:|<js>/iu.test(rawRule);
      const isLiteralUrl = field === 'bookUrl' && /^(?:https?:|\/)/iu.test(expanded);
      const value = hasTemplateValue || isLiteralUrl
        ? expanded.split(/\n@js:|@js:/iu)[0].trim()
        : String(mobileJsonPath(item, rawRule).find(value => value !== undefined && value !== null) ?? '');
      return mobileRuleText(value, rawRule);
    };
    const title = mobileRuleText(scalar('name'), rule.name) || (typeof record.title === 'string' ? record.title : '');
    const author = mobileRuleText(scalar('author'), rule.author) || '未知作者';
    const sourceBookId = String(record.bookId || record.book_id || record.novelId || record.nid || `${source.id}-${index}`);
    let bookUrl = scalar('bookUrl');
    const descriptorIndex = bookUrl.search(/,\s*\{/u);
    if (descriptorIndex >= 0) bookUrl = bookUrl.slice(0, descriptorIndex).trim();
    if (bookUrl && !/^https?:\/\//iu.test(bookUrl)) { try { bookUrl = new URL(bookUrl, baseUrl).toString(); } catch { /* Keep relative. */ } }
    if (!title || !bookUrl || /[{}@]/u.test(bookUrl)) return null;
    return {
      id: `${source.id}:${sourceBookId}:${index}`, sourceId: source.id, sourceBookId, source: source.name, title, author,
      intro: mobileRuleText(scalar('intro'), rule.intro), cover: scalar('coverUrl') || undefined,
      category: mobileRuleText(scalar('kind'), rule.kind) || undefined, wordCount: Number(scalar('wordCount')) || undefined, url: bookUrl,
    };
  }).filter((book): book is Record<string, unknown> => Boolean(book));
};

type MobileSourcePayload = { request: MobileSourceRequest; text: string; json: unknown | null };

const mobileFetchSourceRule = async (source: MobileQianyueSource, rule: unknown, item: unknown, query = '', page = 1): Promise<MobileSourcePayload> => {
  const request = mobileSourceRequestFromRule(source, rule, item, query, page);
  if (!request) throw new Error('书源规则包含当前移动端不支持的脚本地址');
  const text = await mobileFetchHTML(request.url, request.encoding, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
  });
  let json: unknown = null;
  try { json = JSON.parse(text) as unknown; } catch { /* HTML source. */ }
  return { request, text, json };
};

const mobileSourceValue = (payload: MobileSourcePayload, item: unknown, rule: unknown, field = ''): string => {
  const rawRule = String(rule || '').trim();
  if (!rawRule) return '';
  if (payload.json !== null) {
    const expanded = mobileRuleTemplate(rawRule, item, '', 1, new URL(payload.request.url).origin).trim();
    const hasTemplateValue = expanded !== rawRule && !/@js:|<js>/iu.test(rawRule);
    const isLiteral = /^(?:https?:|\/)/iu.test(expanded) && (field === 'bookUrl' || field === 'coverUrl' || field === 'tocUrl');
    const value = hasTemplateValue || isLiteral ? expanded.split(/\n@js:|@js:/iu)[0].trim() : String(mobileJsonPath(item, rawRule).find(entry => entry !== undefined && entry !== null) ?? '');
    return mobileRuleText(value, rawRule);
  }
  const document = new DOMParser().parseFromString(payload.text, 'text/html');
  return mobileHtmlValue(document.body, rawRule, new URL(payload.request.url).origin);
};

const mobileSourceChapterId = (sourceId: string, url: string, index: number) => `${sourceId}:chapter:${index + 1}:${url || 'missing'}`;

const mobileConcurrentMap = async <Item, Result>(items: Item[], concurrency: number, work: (item: Item, index: number) => Promise<Result>): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  return results;
};

const mobileQianyueDownload = async (source: MobileQianyueSource & { id: string; name: string }, title: string, author: string, sourceBookId: string, bookUrl: string, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Record<string, unknown>> => {
  const info = await mobileFetchSourceRule(source, bookUrl, {});
  const infoRoot = info.json !== null && source.ruleBookInfo?.init ? mobileJsonPath(info.json, source.ruleBookInfo.init)[0] || info.json : info.json;
  const tocRule = source.ruleBookInfo?.tocUrl || bookUrl;
  const toc = await mobileFetchSourceRule(source, tocRule, infoRoot || {});
  const chapterItems = toc.json !== null
    ? mobileJsonPath(toc.json, source.ruleToc?.chapterList)
    : mobileHtmlNodes(new DOMParser().parseFromString(toc.text, 'text/html'), String(source.ruleToc?.chapterList || ''));
  if (!chapterItems.length) throw new Error(`${source.name} 没有返回章节目录`);
  const selected = chapterItems.slice(0, Math.max(1, maxChapters));
  const chapters = await mobileConcurrentMap(selected, 4, async (item, index): Promise<Record<string, unknown>> => {
    const chapterTitle = mobileSourceValue(toc, item, source.ruleToc?.chapterName) || `第 ${index + 1} 章`;
    const chapterRule = String(source.ruleToc?.chapterUrl || '').trim();
    const chapterUrl = mobileRuleTemplate(chapterRule, item, '', 1, new URL(toc.request.url).origin).split(/\n@js:|@js:/iu)[0].trim();
    const resolvedUrl = chapterUrl && !/^https?:\/\//iu.test(chapterUrl) ? mobileResolveURL(toc.request.url, chapterUrl) : chapterUrl;
    const baseChapter = { id: mobileSourceChapterId(source.id, resolvedUrl, index), number: index + 1, title: chapterTitle, url: resolvedUrl };
    if (!resolvedUrl || /\$\.|\{\{|@js:|<js>/iu.test(resolvedUrl)) {
      return { ...baseChapter, content: '', wordCount: 0, downloaded: false, unavailableReason: '章节地址包含暂不支持的脚本规则' };
    }
    try {
      const contentPayload = await mobileFetchSourceRule(source, resolvedUrl, {});
      const content = mobileSourceValue(contentPayload, contentPayload.json ?? {}, source.ruleContent?.content, 'content').replace(/\n{3,}/gu, '\n\n').trim();
      return { ...baseChapter, content, wordCount: content.replace(/\s/gu, '').length, downloaded: Boolean(content), ...(content ? {} : { unavailableReason: '书源没有返回本章正文' }) };
    } catch (error) {
      return { ...baseChapter, content: '', wordCount: 0, downloaded: false, unavailableReason: error instanceof Error ? error.message : String(error) };
    }
  });
  return { title: title || '未命名书籍', author: author || '未知作者', sourceId: source.id, sourceName: source.name, sourceBookId: sourceBookId || bookUrl, chapters, downloadedChapterCount: chapters.filter(chapter => chapter.downloaded === true).length, completedChapterCount: chapters.filter(chapter => chapter.downloaded === true).length };
};

const mobileQianyueDownloadChapter = async (source: MobileQianyueSource & { id: string; name: string }, chapter: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const url = String(chapter.url || '').trim();
  if (!url || /\$\.|\{\{|@js:|<js>/iu.test(url)) throw new Error('该章节缺少可下载地址');
  const payload = await mobileFetchSourceRule(source, url, {});
  const content = mobileSourceValue(payload, payload.json ?? {}, source.ruleContent?.content, 'content').replace(/\n{3,}/gu, '\n\n').trim();
  if (!content) throw new Error(`${source.name} 没有返回本章正文`);
  return { ...chapter, content, wordCount: content.replace(/\s/gu, '').length, downloaded: true, unavailableReason: undefined };
};

const mobileSearchAllQianyue = async (query: string) => {
  // API and HTTPS sources have stable structured search responses on iOS.
  // Run them first so a slow or retired HTML source cannot make a valid title
  // appear as an empty search result.
  const preferredSourceIds = ['qianyue-0', 'qianyue-3', 'qianyue-4', 'qianyue-17', 'qianyue-27', 'qianyue-kuwo', 'qianyue-70'];
  const preferred = preferredSourceIds.map(id => mobileQianyueSources.find(source => source.id === id)).filter((source): source is typeof mobileQianyueSources[number] => Boolean(source));
  const fallback = mobileQianyueSources.filter(source => !preferredSourceIds.includes(source.id)).slice(0, 36);
  const sources = [{ id: 'fanqie', name: '番茄小说' }, ...preferred, ...fallback];
  const results: Array<Record<string, unknown>> = [];
  let responsiveSourceCount = 0;
  let failedSourceCount = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor]; cursor += 1;
      let result: { books?: Record<string, unknown>[]; failed?: boolean };
      if (source.id === 'fanqie') result = await mobileFanqieSearch(query);
      else {
        try { result = { books: await mobileSearchOneQianyueSource(source, query) }; }
        catch { result = { failed: true, books: [] }; }
      }
      if (result.failed) failedSourceCount += 1; else responsiveSourceCount += 1;
      results.push(...(result.books || []));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, sources.length) }, () => worker()));
  const seen = new Set<string>();
  const normalize = (value: unknown) => String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const needle = normalize(query);
  const score = (book: Record<string, unknown>) => {
    const title = normalize(book.title);
    if (title === needle) return 1_000;
    if (title.includes(needle)) return 800 - Math.min(240, title.length - needle.length);
    if (needle.includes(title)) return 620 - Math.min(240, needle.length - title.length);
    return normalize(book.author).includes(needle) ? 520 : 0;
  };
  const books = results.filter(book => { const key = `${book.sourceId}:${book.sourceBookId || book.url}`; if (seen.has(key)) return false; seen.add(key); return Boolean(book.title && book.url); }).sort((left, right) => score(right) - score(left)).slice(0, 150);
  return { books, searchedSourceCount: sources.length, responsiveSourceCount, failedSourceCount };
};

const mobileAgentRpc = async <T>(method: string, params: MobileParams): Promise<T> => {
  if (method === 'usage.summary') return readUsage() as T;
  if (method === 'ranking.categories') return mobileNovelCatchCategories() as T;
  if (method === 'ranking.fetch') return mobileRankingFetch(params) as T;
  if (method === 'book.search.all' || method === 'book.search') {
    if (method === 'book.search') {
      const sourceId = stringValue(params.source, 'fanqie');
      if (sourceId === 'fanqie') return mobileFanqieSearch(stringValue(params.query).trim()) as T;
      const source = mobileQianyueSources.find(item => item.id === sourceId);
      if (!source) throw new Error('未知小说书源');
      return { books: await mobileSearchOneQianyueSource(source, stringValue(params.query).trim()), sourceId, sourceName: source.name } as T;
    }
    return mobileSearchAllQianyue(stringValue(params.query).trim()) as T;
  }
  if (method === 'book.download') {
    const sourceId = stringValue(params.source, 'fanqie');
    const source = mobileQianyueSources.find(item => item.id === sourceId);
    if (!source) throw new Error(sourceId === 'fanqie' ? '番茄移动端下载规则暂不可用，请从可下载书源结果中选择其它来源。' : '未知小说书源');
    return mobileQianyueDownload(source, stringValue(params.title), stringValue(params.author), stringValue(params.sourceBookId), stringValue(params.url), Number(params.maxChapters) || Number.MAX_SAFE_INTEGER) as T;
  }
  if (method === 'book.chapter.download') {
    const sourceId = stringValue(params.source);
    const source = mobileQianyueSources.find(item => item.id === sourceId);
    if (!source) throw new Error(sourceId === 'fanqie' ? '番茄移动端单章下载规则暂不可用，请选择其它书源。' : '未知小说书源');
    if (!params.chapter || typeof params.chapter !== 'object') throw new Error('缺少需要重新下载的章节');
    return { chapter: await mobileQianyueDownloadChapter(source, params.chapter as Record<string, unknown>) } as T;
  }
  const fetcher = await httpFetch();
  if (method === 'book.sources.list') {
    return { sources: [{ id: 'fanqie', name: '番茄小说' }, ...mobileQianyueSources.map(source => ({ id: source.id, name: source.name }))], defaultSourceId: mobileQianyueSources[0]?.id || 'fanqie' } as T;
  }
  if (method === 'image.generate') {
    const imageApiKey = stringValue(params.imageApiKey).trim();
    const prompt = stringValue(params.prompt).trim();
    if (!imageApiKey || !prompt) throw new Error('请先填写封面生图 API Key 和提示词');
    const model = stringValue(params.imageModel, 'gpt-image-2').trim() || 'gpt-image-2';
    const response = await fetcher('https://api.apisaver.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${imageApiKey}` },
      body: JSON.stringify({ model, prompt: prompt.replace(/\s+/gu, ' ').trim(), size: stringValue(params.size, '1024x1536'), quality: stringValue(params.quality, 'high'), n: 1 }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`生图接口返回 ${response.status}：${raw.replace(/\s+/gu, ' ').slice(0, 240)}`);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('生图接口返回了无效 JSON'); }
    const first = Array.isArray(payload.data) && payload.data[0] && typeof payload.data[0] === 'object' ? payload.data[0] as Record<string, unknown> : undefined;
    const b64 = stringValue(first?.b64_json).trim();
    const url = stringValue(first?.url).trim();
    if (!b64 && !url) throw new Error('生图接口没有返回图片');
    if (!b64 && url) {
      try {
        const imageResponse = await fetcher(url);
        if (imageResponse.ok) {
          const bytes = new Uint8Array(await imageResponse.arrayBuffer());
          let binary = '';
          const chunkSize = 0x8000;
          for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + chunkSize)));
          const contentType = imageResponse.headers.get('content-type') || 'image/png';
          return { dataUrl: `data:${contentType};base64,${btoa(binary)}`, url, ...(stringValue(first?.revised_prompt) ? { revisedPrompt: stringValue(first?.revised_prompt) } : {}) } as T;
        }
      } catch { /* Keep the remote URL as a fallback when CDN fetch is unavailable. */ }
    }
    return { ...(b64 ? { dataUrl: `data:image/png;base64,${b64}` } : {}), ...(url ? { url } : {}), ...(stringValue(first?.revised_prompt) ? { revisedPrompt: stringValue(first?.revised_prompt) } : {}) } as T;
  }
  if (method === 'gateway.usage') {
    const keys = Array.from(new Set([stringValue(params.apiKey), ...arrayStrings(params.apiKeys)].map(key => key.trim()).filter(Boolean)));
    if (!keys.length) throw new Error('请先在设置中填写 API Key。');
    const root = baseURL(params.baseURL).replace(/\/v1\/?$/u, '');
    const getJSON = async (path: string, key?: string): Promise<Record<string, unknown>> => {
      const response = await fetcher(`${root}${path}`, { headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
      const body = await response.text();
      if (!response.ok) throw new Error(`${path} 请求失败（${response.status}）：${body.replace(/\s+/gu, ' ').slice(0, 180)}`);
      return JSON.parse(body) as Record<string, unknown>;
    };
    const [statusResult, accounts] = await Promise.all([
      getJSON('/api/status').catch(error => ({ __error: String(error) })),
      Promise.all(keys.map(async (key, keyIndex) => {
        const [usage, logs, pricing] = await Promise.allSettled([getJSON('/api/usage/token', key), getJSON('/api/log/token', key), getJSON('/api/pricing', key)]);
        const errors = [usage, logs].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
        const usagePayload = usage.status === 'fulfilled' ? usage.value : undefined;
        const logsPayload = logs.status === 'fulfilled' ? logs.value : undefined;
        const pricingPayload = pricing.status === 'fulfilled' ? pricing.value : undefined;
        return {
          keyIndex, keyHint: `${key.slice(0, 4)}••••${key.slice(-4)}`,
          usage: usagePayload?.data && typeof usagePayload.data === 'object' ? usagePayload.data : undefined,
          logs: Array.isArray(logsPayload?.data) ? logsPayload.data : [],
          pricing: Array.isArray(pricingPayload?.data) ? pricingPayload.data : [],
          group: typeof usagePayload?.data?.group === 'string' ? usagePayload.data.group : undefined,
          groupRatios: pricingPayload?.group_ratio && typeof pricingPayload.group_ratio === 'object' ? pricingPayload.group_ratio as Record<string, number> : undefined,
          usableGroups: pricingPayload?.usable_group && typeof pricingPayload.usable_group === 'object' ? pricingPayload.usable_group as Record<string, unknown> : undefined,
          ...(errors.length ? { error: errors.join('；') } : {}),
        };
      })),
    ]);
    const pricing = accounts.flatMap(account => account.pricing || []).filter((item, index, all) => all.findIndex(other => String(other.model_name) === String(item.model_name)) === index);
    return {
      fetchedAt: new Date().toISOString(),
      status: statusResult.data && typeof statusResult.data === 'object' ? statusResult.data : undefined,
      pricing,
      accounts,
      errors: [statusResult.__error].filter((value): value is string => typeof value === 'string'),
    } as T;
  }
  if (method === 'models.list') {
    const keys = Array.from(new Set([stringValue(params.apiKey), ...arrayStrings(params.apiKeys)].map(key => key.trim()).filter(Boolean)));
    if (!keys.length) throw new Error('请先在设置中填写 API Key。');
    const responses = await Promise.allSettled(keys.map(async key => {
      const response = await fetcher(`${baseURL(params.baseURL)}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）`);
      const data = await response.json() as { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> };
      const models = (data.data || data.models || []).map(item => typeof item === 'string' ? item : item.id || '').filter(Boolean);
      mobileModelsByApiKey.set(key, new Set(models));
      return models;
    }));
    const models = Array.from(new Set(responses.flatMap(result => result.status === 'fulfilled' ? result.value : [])));
    if (!models.length) throw new Error('所有 API Key 拉取模型失败');
    return { models } as T;
  }
  if (method === 'models.test') {
    await mobileChat(params, [{ role: 'user', content: '请只回复 OK' }]);
    return { tested: true, model: stringValue(params.model) } as T;
  }
  const runId = stringValue(params.runId);
  emitProgress(runId, { type: 'step', step: 'writing', progress: 8, message: '移动端已连接模型，正在整理上下文' });
  const agentMessages: ChatMessage[] = method === 'memory.write'
    ? mobileMemoryMessages(params)
    : [{ role: 'system', content: '系统固定规则：保持设定一致、遵守用户输出格式、不要泄露密钥。' }, { role: 'user', content: promptFor(method, params) }];
  const onAgentChunk = (chunk: string) => {
    emitProgress(runId, { type: 'chunk', data: { text: chunk } });
  };
  let result: { content: string; usage?: unknown };
  try {
    // 章节记忆是后台结构化写入，不需要向编辑器推送字符流。部分中转站会
    // 在 SSE 中切碎 JSON 或省略 delta.content，导致人物/认知等数组被解析为空。
    // 使用一次完整 JSON 响应可稳定保留所有字段；章节、大纲和卡片仍保持流式。
    result = await mobileChat(params, agentMessages, method === 'memory.write' ? undefined : onAgentChunk, method === 'memory.write');
  } catch (error) {
    // A few OpenAI-compatible gateways reject response_format even though
    // they support chat completions. Retry memory extraction without that
    // optional hint; the prompt and alias normaliser still enforce JSON.
    if (method !== 'memory.write' || !/response[_ ]format|json_object|400/iu.test(String(error))) throw error;
    result = await mobileChat(params, agentMessages, method === 'memory.write' ? undefined : onAgentChunk, false);
  }
  if (!result.content.trim()) throw new Error('模型没有返回内容');
  emitProgress(runId, { type: 'complete', data: { message: '移动端 Agent 已完成' } });
  if (method === 'text.transform') return { content: result.content.trim() } as T;
  const parsed = parseJSON<Record<string, unknown>>(result.content);
  if (parsed) {
    if (method === 'memory.write') return normalizeMobileMemoryResult(parsed, stringValue(params.content)) as T;
    if (method === 'chapter.write') {
      return { ...parsed, draftContent: stringValue(parsed.draftContent || parsed.content), summary: stringValue(parsed.summary) } as T;
    }
    return parsed as T;
  }
  if (method === 'chapter.write' || method === 'book.rewrite') return { content: result.content.trim() } as T;
  if (method === 'outline.write' || method === 'card.write') return { content: result.content.trim() } as T;
  return { content: result.content.trim() } as T;
};

/** Agent runtime remains platform-specific; 百度网盘同步在所有 Tauri 平台统一走 HTTP API。 */
export const invoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
  if (directBaiduRuntime() && command === 'cloud_sync_status') return mobileBaiduStatus() as T;
  if (directBaiduRuntime() && command === 'baidu_login_url') return mobileBaiduLoginURL() as T;
  if (directBaiduRuntime() && command === 'complete_baidu_login') {
    const input = args as { code?: string } | undefined;
    return mobileBaiduCompleteLogin(stringValue(input?.code)) as T;
  }
  if (directBaiduRuntime() && command === 'backup_projects_to_baidu') {
    const input = args as { remotePath?: string; clientState?: Record<string, string | null> } | undefined;
    return mobileBaiduBackup(stringValue(input?.remotePath), input?.clientState || {}) as T;
  }
  if (directBaiduRuntime() && command === 'list_baidu_backups') {
    const input = args as { remotePath?: string } | undefined;
    return mobileBaiduListBackups(stringValue(input?.remotePath)) as T;
  }
  if (directBaiduRuntime() && command === 'restore_projects_from_baidu') {
    const input = args as { remotePath?: string; backupPath?: string; backupFsId?: string } | undefined;
    return mobileBaiduRestore(stringValue(input?.remotePath), stringValue(input?.backupPath), stringValue(input?.backupFsId)) as T;
  }
  if (!mobileRuntime()) return nativeInvoke<T>(command, args);
  if (command === 'start_agent_runtime') return 'Mobile direct Agent ready' as T;
  if (command === 'call_agent_rpc') {
    const input = args as { method?: string; params?: MobileParams } | undefined;
    if (!input?.method) throw new Error('缺少 Agent RPC 方法。');
    return mobileAgentRpc<T>(input.method, input.params || {});
  }
  if (command === 'detect_system_proxy') return null as T;
  return nativeInvoke<T>(command, args);
};

export const isMobileRuntime = mobileRuntime;
export const isDirectBaiduRuntime = directBaiduRuntime;
