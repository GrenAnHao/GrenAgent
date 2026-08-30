import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const source = process.env.GREN_TENCENTDB_RUNTIME_SOURCE || process.argv[2];
const target = join(appRoot, 'resources', 'tencentdb-memory', platformDir());

if (!source) {
  throw new Error('Set GREN_TENCENTDB_RUNTIME_SOURCE or pass a prebuilt TencentDB runtime directory');
}

const sourceRoot = resolve(source);
for (const path of [
  join(sourceRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'bin', process.platform === 'win32' ? '' : 'node'),
  join(sourceRoot, 'core', 'src', 'gateway', 'server.ts'),
  join(sourceRoot, 'knowledge', 'bin', 'server.mjs'),
  join(sourceRoot, 'core', 'tdai-gateway.standalone.yaml'),
  join(sourceRoot, 'panel', 'dist', 'index.js'),
]) {
  if (!existsSync(path)) throw new Error(`TencentDB runtime entry is missing: ${path}`);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(sourceRoot, target, { recursive: true });
console.log(`TencentDB runtime copied to ${target}`);

function platformDir() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'windows-aarch64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-aarch64';
  if (process.platform === 'darwin') return 'darwin-x86_64';
  if (process.arch === 'arm64') return 'linux-aarch64';
  return 'linux-x86_64';
}
