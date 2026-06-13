// 把 GrenAgent agent sidecar(pi runtime + 8 个内置 extension)编译为独立二进制，
// 按 Tauri target triple 命名放入 src-tauri/binaries/pi-<triple>。
// Rust 侧(pi/sidecar.rs)无需改动：它 spawn "pi" 走 RPC，协议与官方 pi 一致，
// 只是这个二进制现在自带了我们的 8 个 extension（extensionFactories 编译进去）。
//
// 用法：node scripts/build-sidecar.mjs （或 npm run build:sidecar）
// 前置：已安装 bun；sidecar 源在 ../cli（其 package.json 依赖 @earendil-works/pi-coding-agent）。
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..'); // tauri-agent/
const sidecarRoot = resolve(appRoot, '..', 'cli'); // GrenAgent agent sidecar（pi + 8 extension）
const binDir = join(appRoot, 'src-tauri', 'binaries');
mkdirSync(binDir, { recursive: true });

// 1) 安装 sidecar 依赖（@earendil-works/pi-coding-agent + typebox），bun 编译需要解析它们。
console.log('Installing sidecar deps…');
execSync('npm install', { cwd: sidecarRoot, stdio: 'inherit' });

// extensions/*/index.ts 也 import 'typebox' 等；bun 从 ../extensions/*/ 解析这些 import，
// 需在 extensions/ 也装好依赖，否则 bun build 报 "Could not resolve typebox"。
const extensionsRoot = resolve(appRoot, '..', 'extensions');
console.log('Installing extensions deps…');
execSync('npm install', { cwd: extensionsRoot, stdio: 'inherit' });

// 2) 取 rustc host target triple（Tauri sidecar 命名约定）。
const hostLine = execSync('rustc -Vv')
  .toString()
  .split('\n')
  .find((l) => l.startsWith('host:'));
if (!hostLine) throw new Error('could not determine rustc host triple');
const triple = hostLine.split('host:')[1].trim();
const isWin = triple.includes('windows');
const dest = join(binDir, `pi-${triple}${isWin ? '.exe' : ''}`);

// 3) bun 编译 sidecar 为单文件二进制（内置 pi + 8 extension）。
console.log('Compiling GrenAgent sidecar via bun…');
execSync(`bun build ./src/main.ts --compile --outfile "${dest}"`, { cwd: sidecarRoot, stdio: 'inherit' });

// 4) 复制 pi 运行时资源（theme/assets 等）。从已安装的完整 npm 包 dist 取（本地 ../pi/dist 可能残缺）。
//    通过 sidecar.rs 设置的 PI_PACKAGE_DIR=binaries/ 让运行时按需找到这些资源。
const piPkgDist = resolve(sidecarRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
if (existsSync(piPkgDist)) {
  for (const dir of ['theme', 'assets', 'export-html', 'docs', 'examples']) {
    const from = join(piPkgDist, dir);
    if (existsSync(from)) cpSync(from, join(binDir, dir), { recursive: true });
  }
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', 'photon_rs_bg.wasm']) {
    const from = join(piPkgDist, file);
    if (existsSync(from)) copyFileSync(from, join(binDir, file));
  }
} else {
  console.warn('warn: pi npm dist not found under cli/node_modules; theme/assets not copied.');
}

console.log(`GrenAgent sidecar ready: ${dest}`);
