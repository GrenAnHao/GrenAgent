import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isPackageEnabled, isValidNpmName, isValidSemver, packageSourceString, type PackageSource } from './piPackageModel';
import { readNpmVersions } from './packageRegistry';

export type ManagedSource =
  | { kind: 'npm'; name: string; ref?: string; identity: string; display: string }
  | { kind: 'git'; repo: string; ref?: string; identity: string; display: string }
  | { kind: 'local' | 'unsupported'; identity: string; display: string };
export type GitReader = (args: string[], cwd?: string) => Promise<string>;
const exec = promisify(execFile);
export const readPackageGit: GitReader = async (args, cwd) => (await exec('git', [
  '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'credential.interactive=false',
  '-c', 'protocol.file.allow=never', ...args,
], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();

export function parseManagedSource(source: string): ManagedSource {
  const npm = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@([^\s]+))?$/.exec(source);
  if (npm && isValidNpmName(npm[1])) return { kind: 'npm', name: npm[1], ref: npm[2], identity: `npm:${npm[1]}`, display: source };
  const unsupported = (): ManagedSource => ({ kind: 'unsupported', identity: 'unsupported', display: '不支持或包含凭据的来源' });
  if (source.startsWith('npm:') || /[\x00-\x1f]/.test(source)) return unsupported();
  if (!/^(git:|https?:|ssh:|git@)/.test(source)) return { kind: 'local', identity: `local:${source}`, display: source };
  let raw = source.replace(/^git:/, ''); let ref: string | undefined;
  const hash = raw.indexOf('#'); if (hash >= 0) { ref = raw.slice(hash + 1); raw = raw.slice(0, hash); }
  if (/^git@[^:]+:/.test(raw)) raw = raw.replace(/^git@([^:]+):/, 'ssh://git@$1/');
  if (!raw.includes('://')) raw = `https://${raw}`;
  try {
    const pathStart = raw.indexOf('/', raw.indexOf('://') + 3);
    if (pathStart < 0) return unsupported();
    const pathText = raw.slice(pathStart);
    const at = pathText.indexOf('@');
    if (at >= 0) { if (ref) return unsupported(); ref = pathText.slice(at + 1); raw = raw.slice(0, pathStart + at); }
    const decoded = decodeURIComponent(raw.slice(pathStart));
    if (decoded.split('/').some((part) => part === '..' || part === '.') || decoded.includes('\\')) return unsupported();
    const url = new URL(raw);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) return unsupported();
    if (ref && (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..'))) return unsupported();
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!path || path.split('/').some((part) => !part || !/^[A-Za-z0-9_.-]+$/.test(part))) return unsupported();
    url.pathname = `/${path}`;
    const repo = url.toString().replace(/\/$/, '');
    return { kind: 'git', repo, ref, identity: `git:${url.hostname}/${path}`, display: `git:${repo}${ref ? `@${ref}` : ''}` };
  } catch { return unsupported(); }
}

export interface PackageSnapshot {
  key: string;
  identity: string;
  source: string;
  scope: 'user' | 'project';
  workspace?: string;
  kind: ManagedSource['kind'];
  enabled: boolean;
  filters: Record<string, string[]>;
  configuredTarget?: string;
  installedPath?: string;
  unitRoot?: string;
  installedVersion?: string;
  installedCommit?: string;
  installState: 'installed' | 'missing' | 'invalid';
  location: 'managed' | 'external' | 'missing';
  /** Source override and autoload delta are different SDK relationships. */
  overriddenBy?: string;
  resourceBaseKey?: string;
}
async function readManifest(root: string): Promise<{ version?: string; pi?: { changelogPath?: unknown } }> {
  const file = await realpath(resolve(root, 'package.json')); const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PACKAGE_MANIFEST_OUTSIDE_ROOT');
  const info = await stat(file); if (!info.isFile() || info.size > 1024 * 1024) throw new Error('PACKAGE_MANIFEST_INVALID');
  return JSON.parse(await readFile(file, { encoding: 'utf8', signal: AbortSignal.timeout(2000) }));
}
export async function readPackageSnapshot(input: {
  scope: 'user' | 'project'; workspace?: string; entry: PackageSource;
  installedPath?: string; managedRoot: string; git?: GitReader;
}): Promise<PackageSnapshot> {
  const parsed = parseManagedSource(packageSourceString(input.entry));
  const workspace = input.scope === 'project' && input.workspace ? await realpath(input.workspace) : undefined;
  const filters: Record<string, string[]> = {};
  if (typeof input.entry === 'object') for (const key of ['extensions', 'skills', 'prompts', 'themes'] as const) if (input.entry[key] !== undefined) filters[key] = [...input.entry[key]!];
  const result: PackageSnapshot = {
    key: JSON.stringify([input.scope, workspace ?? '', parsed.identity]), identity: parsed.identity,
    source: parsed.display, scope: input.scope, workspace, kind: parsed.kind,
    enabled: isPackageEnabled(input.entry), filters,
    configuredTarget: 'ref' in parsed ? parsed.ref : undefined,
    installState: 'missing', location: 'missing',
  };
  if (!input.installedPath) return result;
  try {
    result.installedPath = await realpath(input.installedPath);
    const unit = resolve(input.managedRoot); const child = relative(unit, result.installedPath);
    result.location = !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child) ? 'managed' : 'external';
    result.unitRoot = parsed.kind === 'git' ? result.installedPath : result.location === 'managed' ? unit : undefined;
    let file: { version?: unknown } = {};
    try { file = await readManifest(result.installedPath); }
    catch (error) { if (parsed.kind === 'npm' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (typeof file.version === 'string') result.installedVersion = file.version;
    if (parsed.kind === 'git') {
      const head = await (input.git ?? readPackageGit)(['rev-parse', '--verify', 'HEAD'], result.installedPath);
      if (!/^[a-f0-9]{40,64}$/i.test(head.trim())) throw new Error('invalid git HEAD');
      result.installedCommit = head.trim();
    }
    result.installState = 'installed';
  } catch { result.installState = 'invalid'; }
  return result;
}

export interface PackageUpdateCheck {
  state: 'available' | 'up-to-date' | 'pinned' | 'offline' | 'unsupported' | 'error';
  targetSource?: string; targetVersion?: string; targetCommit?: string; error?: string;
}
function compareStable(left: string, right: string): number {
  const a = left.split(/[-+]/)[0].split('.').map(BigInt); const b = right.split(/[-+]/)[0].split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  const pre = (value: string) => value.split('+')[0].split('-').slice(1).join('-');
  const x = pre(left); const y = pre(right);
  if (!x || !y) return x === y ? 0 : x ? -1 : 1;
  const xs = x.split('.'); const ys = y.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === ys[i]) continue;
    if (xs[i] === undefined || ys[i] === undefined) return xs[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(xs[i]); const yn = /^\d+$/.test(ys[i]);
    if (xn && yn) return BigInt(xs[i]) > BigInt(ys[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return xs[i] > ys[i] ? 1 : -1;
  }
  return 0;
}
export async function checkPackageUpdate(snapshot: PackageSnapshot, options: {
  fetch?: typeof fetch; git?: GitReader; registry?: string; offline?: boolean; targetRef?: string;
  npmVersions?: (name: string) => Promise<string[]>; cwd?: string; npmCommand?: string[];
} = {}): Promise<PackageUpdateCheck> {
  if (options.offline) return { state: 'offline' };
  const source = parseManagedSource(snapshot.source);
  try {
    if (source.kind === 'npm') {
      let allVersions: string[];
      if (options.fetch || options.registry) {
        const registry = new URL(options.registry ?? 'https://registry.npmjs.org');
        if (registry.username || registry.password || (registry.protocol !== 'https:' && registry.hostname !== '127.0.0.1')) throw new Error('invalid registry');
        const response = await (options.fetch ?? fetch)(`${registry.toString().replace(/\/$/, '')}/${encodeURIComponent(source.name)}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return { state: 'error', error: `HTTP ${response.status}` };
        const data = await response.json() as { versions?: Record<string, unknown> };
        allVersions = Object.keys(data.versions ?? {});
      } else {
        allVersions = await (options.npmVersions ?? ((name) => readNpmVersions({ name, cwd: options.cwd ?? snapshot.workspace ?? process.cwd(), npmCommand: options.npmCommand })))(source.name);
      }
      const versions = allVersions.filter((version) => isValidSemver(version) && !version.includes('-')).sort(compareStable);
      const target = options.targetRef ?? versions.at(-1);
      if (!target || !isValidSemver(target) || !allVersions.includes(target)) return { state: 'error', error: '无法验证目标版本' };
      const from = snapshot.installedVersion ?? source.ref;
      return { state: from && isValidSemver(from) && compareStable(target, from) <= 0 ? 'up-to-date' : 'available', targetVersion: target, targetSource: `npm:${source.name}@${target}` };
    }
    if (source.kind === 'git') {
      const ref = options.targetRef ?? source.ref ?? 'HEAD';
      if (/^[a-f0-9]{40,64}$/i.test(ref) && !options.targetRef) return { state: 'pinned', targetCommit: ref, targetSource: source.display };
      if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) throw new Error('invalid ref');
      const text = await (options.git ?? readPackageGit)(['ls-remote', source.repo, ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]);
      const entries = text.split('\n').map((line) => line.trim().split(/\s+/)).filter(([sha]) => /^[a-f0-9]{40,64}$/i.test(sha));
      const chosen = entries.find(([, name]) => name?.endsWith('^{}')) ?? entries[0];
      if (!chosen) return { state: 'error', error: '无法验证远端目标' };
      const commit = chosen[0];
      return { state: commit === snapshot.installedCommit ? 'up-to-date' : 'available', targetCommit: commit, targetSource: `git:${source.repo}@${commit}` };
    }
    return { state: 'unsupported' };
  } catch { return { state: 'error', error: '包元数据查询失败，请检查已配置的 registry 或 git 连接' }; }
}

export interface PackageChangelog {
  state: 'available' | 'disabled' | 'unavailable'; text?: string; version?: string; format?: 'text';
  reason?: 'missing' | 'invalid-declaration' | 'outside-root' | 'unsupported-format' | 'too-large' | 'read-failed';
}
export async function readPackageChangelog(packageRoot: string): Promise<PackageChangelog> {
  try {
    const root = await realpath(packageRoot);
    let manifest: Awaited<ReturnType<typeof readManifest>> = {};
    try { manifest = await readManifest(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const declared = manifest.pi?.changelogPath;
    if (declared === '') return { state: 'disabled' };
    const name = declared === undefined ? 'CHANGELOG.md' : declared;
    if (typeof name !== 'string') return { state: 'unavailable', reason: 'invalid-declaration' };
    if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) return { state: 'unavailable', reason: 'outside-root' };
    if (!['.md', '.markdown', '.txt', ''].includes(extname(name).toLowerCase())) return { state: 'unavailable', reason: 'unsupported-format' };
    const file = await realpath(resolve(root, name)); const rel = relative(root, file);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return { state: 'unavailable', reason: 'outside-root' };
    const info = await stat(file);
    if (!info.isFile()) return { state: 'unavailable', reason: 'unsupported-format' };
    if (info.size > 256 * 1024) return { state: 'unavailable', reason: 'too-large' };
    const text = await readFile(file, { encoding: 'utf8', signal: AbortSignal.timeout(2000) });
    if (text.includes('\0')) return { state: 'unavailable', reason: 'unsupported-format' };
    return { state: 'available', text, version: manifest.version, format: 'text' };
  } catch (error) { return { state: 'unavailable', reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed' }; }
}
