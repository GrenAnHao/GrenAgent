import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DefaultPackageManager, SettingsManager } from '../../../cli/src/pi-sdk.js';
import { parseManagedSource, readPackageGit, readPackageSnapshot, type PackageSnapshot } from './piPackageMetadata';
import { isValidNpmName, isValidSemver } from './piPackageModel';
import { PackageUpdateStage } from './packageUpdateStage';
import type { PackageDependencyChange } from './packageUpdateContracts';

interface Manifest { name?: string; version?: string; dependencies?: Record<string, string> }
async function manifest(root: string): Promise<Manifest> {
  const file = await realpath(join(root, 'package.json'));
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('PACKAGE_MANIFEST_OUTSIDE_ROOT');
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('PACKAGE_MANIFEST_INVALID');
  const data: unknown = JSON.parse(await readFile(file, { encoding: 'utf8', signal: AbortSignal.timeout(2000) }));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('PACKAGE_MANIFEST_INVALID');
  return data as Manifest;
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function packageInstallUnit(snapshot: PackageSnapshot, cwd: string, agentDir: string): { managedBase: string; liveRoot: string; relativeUnit: string } {
  const source = parseManagedSource(snapshot.source);
  const managedBase = resolve(snapshot.scope === 'user' ? agentDir : join(cwd, '.pi'));
  if (source.kind === 'npm') return { managedBase, liveRoot: join(managedBase, 'npm'), relativeUnit: 'npm' };
  if (source.kind !== 'git') throw new Error('PACKAGE_UPDATE_UNSUPPORTED');
  if (snapshot.installedPath && snapshot.location !== 'managed') throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
  const repo = new URL(source.repo);
  const liveRoot = snapshot.unitRoot ?? join(managedBase, 'git', repo.hostname, repo.pathname.replace(/^\/+/, ''));
  if (!inside(join(managedBase, 'git'), liveRoot)) throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
  return { managedBase, liveRoot, relativeUnit: relative(managedBase, liveRoot) };
}

async function directVersions(root: string, target: string): Promise<Record<string, string>> {
  if (!existsSync(root)) return {};
  const file = await manifest(root).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (await readdir(root)).length === 0) return {};
    throw new Error('PACKAGE_NPM_MANIFEST_INVALID');
  });
  const versions: Record<string, string> = {};
  for (const name of Object.keys(file.dependencies ?? {})) {
    if (!isValidNpmName(name)) throw new Error('PACKAGE_NONTARGET_UNVERIFIED');
    if (name === target) continue;
    const item = await manifest(join(root, 'node_modules', name));
    if (item.name !== name || !item.version) throw new Error('PACKAGE_NONTARGET_UNVERIFIED');
    versions[name] = item.version;
  }
  return versions;
}

async function dependencyInventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}, visited = new Set<string>();
  const modules = async (dir: string): Promise<void> => {
    if (!existsSync(dir)) return;
    const physical = await realpath(dir);
    if (!inside(root, physical)) throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
    if (visited.has(physical)) return; visited.add(physical);
    const packageDir = async (path: string): Promise<void> => {
      const physicalPackage = await realpath(path);
      if (!inside(root, physicalPackage)) throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
      const file = await manifest(path).catch(() => undefined);
      if (file?.version) result[relative(root, path).replace(/\\/g, '/')] = file.version;
      await modules(join(path, 'node_modules'));
    };
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.pnpm') {
        for (const store of await readdir(join(dir, entry.name))) await modules(join(dir, entry.name, store, 'node_modules'));
      } else if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const child of await readdir(join(dir, entry.name))) await packageDir(join(dir, entry.name, child));
      } else if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) await packageDir(join(dir, entry.name));
    }
  };
  await modules(join(root, 'node_modules')); return result;
}

export interface PackagePreparationInput {
  snapshot: PackageSnapshot;
  targetSource: string;
  cwd: string;
  agentDir: string;
  npmCommand: string[];
  recordsDir: string;
}
export interface PreparedPackageInstallation {
  stage: PackageUpdateStage;
  installed: PackageSnapshot;
  dependencies: PackageDependencyChange[];
}

/** Caller owns scoped consent/locks. SDK owns installation and dependency resolution. */
export async function preparePackageInstallation(input: PackagePreparationInput): Promise<PreparedPackageInstallation> {
  const target = parseManagedSource(input.targetSource), original = parseManagedSource(input.snapshot.source);
  if (target.identity !== original.identity || target.kind !== original.kind) throw new Error('PACKAGE_IDENTITY_CHANGED');
  if (target.kind === 'npm' ? !target.ref || !isValidSemver(target.ref) : target.kind === 'git' ? !target.ref || !/^[a-f0-9]{40,64}$/i.test(target.ref) : true) throw new Error('PACKAGE_TARGET_NOT_IMMUTABLE');
  const unit = packageInstallUnit(input.snapshot, input.cwd, input.agentDir);
  if (target.kind === 'npm' && input.snapshot.location === 'external' && existsSync(join(unit.liveRoot, 'node_modules', target.name))) throw new Error('PACKAGE_INSTALLATION_NOT_RELOCATABLE');
  if (existsSync(join(unit.liveRoot, '.npmrc'))) throw new Error('PACKAGE_ROOT_HAS_PRIVATE_NPM_CONFIGURATION');
  if (target.kind === 'git' && existsSync(unit.liveRoot)) {
    const tracked = await readPackageGit(['diff', '--name-only', 'HEAD', '--'], unit.liveRoot);
    const untracked = await readPackageGit(['ls-files', '--others', '--exclude-standard'], unit.liveRoot);
    if (tracked.trim() || untracked.split('\n').filter(Boolean).some((name) => name !== 'package-lock.json' && !name.startsWith('node_modules/'))) throw new Error('PACKAGE_GIT_DIRTY');
  }
  const beforeDirect = target.kind === 'npm' ? await directVersions(unit.liveRoot, target.name) : {};
  const beforeDependencies = await dependencyInventory(unit.liveRoot);
  const stage = new PackageUpdateStage({ ...unit, recordsDir: input.recordsDir, stageRelative: join(input.snapshot.scope === 'user' ? 'agent' : 'project/.pi', unit.relativeUnit) });
  let installed: PackageSnapshot | undefined;
  try {
    await stage.prepare(async (stageRoot, container) => {
      const agentDir = join(container, 'agent'), cwd = join(container, 'project');
      await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
      const settings = SettingsManager.inMemory({ npmCommand: [...input.npmCommand] }, { projectTrusted: true });
      const manager = new DefaultPackageManager({ agentDir, cwd, settingsManager: settings });
      // Reinstall even a damaged same-pin target, but never delete anything in live/global roots.
      if (target.kind === 'npm') await rm(join(stageRoot, 'node_modules', target.name), { recursive: true, force: true });
      await manager.install(input.targetSource, { local: input.snapshot.scope === 'project' });
      const actual = manager.getInstalledPath(input.targetSource, input.snapshot.scope);
      if (!actual || !inside(stageRoot, await realpath(actual)) || target.kind === 'git' && resolve(actual) !== resolve(stageRoot)) throw new Error('PACKAGE_STAGE_LAYOUT_MISMATCH');
      installed = await readPackageSnapshot({ scope: input.snapshot.scope, workspace: cwd, entry: input.targetSource, installedPath: actual, managedRoot: join(input.snapshot.scope === 'user' ? agentDir : join(cwd, '.pi'), target.kind) });
      if (installed.installState !== 'installed' || target.kind === 'npm' && (installed.installedVersion !== target.ref || (await manifest(actual)).name !== target.name) || target.kind === 'git' && installed.installedCommit?.toLowerCase() !== target.ref?.toLowerCase()) throw new Error('PACKAGE_STAGE_TARGET_MISMATCH');
      if (target.kind === 'npm') {
        const afterDirect = await directVersions(stageRoot, target.name);
        if (JSON.stringify(Object.entries(beforeDirect).sort()) !== JSON.stringify(Object.entries(afterDirect).sort())) throw new Error('PACKAGE_NONTARGET_VERSION_CHANGED');
      }
    });
  } catch { throw new Error('PACKAGE_INSTALLATION_PREPARE_FAILED'); }
  const afterDependencies = await dependencyInventory(stage.record.stageRoot);
  const dependencies = [...new Set([...Object.keys(beforeDependencies), ...Object.keys(afterDependencies)])].filter((path) => beforeDependencies[path] !== afterDependencies[path]).map((path) => ({ path, from: beforeDependencies[path], to: afterDependencies[path] }));
  return { stage, installed: installed!, dependencies };
}
