import { cpSync, existsSync, mkdirSync, rmSync, chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(desktopRoot, '..');
const runtimeRoot = join(desktopRoot, 'src-tauri', 'runtime', 'local-model');
const mobileTarget = ['android', 'ios'].includes(String(process.env.TAURI_ENV_PLATFORM || '').toLowerCase());
const modelSource = process.env.APISAVERWRITER_LOCAL_MODEL || '';
const llamaSource = process.env.APISAVERWRITER_LLAMA_SERVER || '';
const modelName = process.env.APISAVERWRITER_LOCAL_MODEL_NAME || 'MiniCPM5-2B-Q4_K_M.gguf';
const required = process.env.APISAVERWRITER_BUNDLE_LOCAL_MODEL === '1';

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
writeFileSync(join(runtimeRoot, 'README.txt'), 'Generated local model resources. See LOCAL_MODEL.md.\\n');

if (mobileTarget) {
  console.log(`Skipping llama-server bundle for ${process.env.TAURI_ENV_PLATFORM}; mobile requires native Metal/Vulkan integration.`);
  process.exit(0);
}

if (!modelSource || !llamaSource) {
  const message = '本次构建未提供 APISAVERWRITER_LOCAL_MODEL 和 APISAVERWRITER_LLAMA_SERVER；将生成不含模型权重的安装包。';
  if (required) throw new Error(message);
  console.warn(message);
  process.exit(0);
}
if (!existsSync(modelSource)) throw new Error(`本地模型不存在：${modelSource}`);
if (!existsSync(llamaSource)) throw new Error(`llama-server 不存在：${llamaSource}`);

const executableName = process.platform === 'win32' || String(process.env.TAURI_ENV_PLATFORM).toLowerCase() === 'windows' ? 'llama-server.exe' : 'llama-server';
copyFileSync(modelSource, join(runtimeRoot, modelName));
copyFileSync(llamaSource, join(runtimeRoot, executableName));
if (executableName !== 'llama-server.exe') chmodSync(join(runtimeRoot, executableName), 0o755);
writeFileSync(join(runtimeRoot, 'model.json'), JSON.stringify({ model: modelName, context: Number(process.env.APISAVERWRITER_LOCAL_CONTEXT || 4096) }, null, 2));
console.log(`Local model resources copied without symlinks: ${runtimeRoot}`);
