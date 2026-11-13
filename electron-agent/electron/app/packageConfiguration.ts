import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';
import { SettingsManager } from '../../../cli/src/pi-sdk.js';
import { parseManagedSource } from './piPackageMetadata';
import { packageSourceString, type PackageSource } from './piPackageModel';

export interface PackageEntryChange {
  cwd: string;
  agentDir: string;
  scope: 'user' | 'project';
  expected: PackageSource;
  next: PackageSource;
  projectTrusted: boolean;
}

function parseSettings(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Configuration values never enter an error message. */ }
  throw new Error('PACKAGE_CONFIGURATION_INVALID');
}

function selectedIndex(entries: PackageSource[], identity: string): number {
  const indices = entries.map((entry, index) => parseManagedSource(packageSourceString(entry)).identity === identity ? index : -1).filter((index) => index >= 0);
  if (indices.length !== 1) throw new Error('PACKAGE_ENTRY_CHANGED');
  return indices[0];
}

/** Same settings.json.lock / realpath:false / default mtime protocol as SDK 1.5.1. */
async function changeEntry(input: PackageEntryChange, restoring: boolean): Promise<void> {
  if (input.scope === 'project' && !input.projectTrusted) throw new Error('PACKAGE_PROJECT_UNTRUSTED');
  const expected = parseManagedSource(packageSourceString(input.expected));
  const next = parseManagedSource(packageSourceString(input.next));
  if (!['npm', 'git'].includes(expected.kind) || expected.identity !== next.identity) throw new Error('PACKAGE_IDENTITY_CHANGED');
  const file = resolve(input.scope === 'user' ? join(input.agentDir, 'settings.json') : join(input.cwd, '.pi/settings.json'));
  for (let path = file; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('PACKAGE_SETTINGS_PATH_UNSAFE');
    if (dirname(path) === path) break;
  }
  mkdirSync(dirname(file), { recursive: true });
  const release = await lockfile.lock(file, { realpath: false, retries: { retries: 20, factor: 1, minTimeout: 20, maxTimeout: 20 } });
  try {
    const scope = input.scope === 'user' ? 'global' : 'project';
    const read = () => existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const packages = (value: Record<string, unknown>) => {
      if (value.packages === undefined) return [];
      if (!Array.isArray(value.packages)) throw new Error('PACKAGE_CONFIGURATION_INVALID');
      return value.packages as PackageSource[];
    };
    const current = packages(parseSettings(read()));
    const index = selectedIndex(current, expected.identity);
    if (restoring && isDeepStrictEqual(current[index], input.next)) return;
    if (!isDeepStrictEqual(current[index], input.expected)) throw new Error('PACKAGE_ENTRY_CHANGED');
    if (isDeepStrictEqual(input.expected, input.next)) return; // repair validates its pin without rewriting it
    const manager = SettingsManager.fromStorage({
      withLock(requestedScope, update) {
        if (requestedScope !== scope) {
          if (update(undefined) !== undefined) throw new Error('PACKAGE_SCOPE_MISMATCH');
          return;
        }
        const text = read();
        const candidate = update(text);
        if (candidate === undefined) return;
        const latest = parseSettings(text);
        const entries = packages(latest);
        const target = selectedIndex(entries, expected.identity);
        if (!isDeepStrictEqual(entries[target], input.expected)) throw new Error('PACKAGE_ENTRY_CHANGED');
        const proposed = packages(parseSettings(candidate));
        if (!isDeepStrictEqual(proposed[selectedIndex(proposed, expected.identity)], input.next)) throw new Error('PACKAGE_ENTRY_CHANGED');
        const replacement = entries.map((entry, position) => position === target ? input.next : entry);
        const temporary = `${file}.gren-package-${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...latest, packages: replacement }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, file);
      },
    }, { projectTrusted: input.projectTrusted });
    const loadErrors = manager.drainErrors();
    if (loadErrors.length) throw loadErrors[0].error;
    const replacement = current.map((entry, position) => position === index ? input.next : entry);
    if (input.scope === 'user') manager.setPackages(replacement);
    else manager.setProjectPackages(replacement);
    await manager.flush();
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
    const saved = packages(parseSettings(read()));
    if (!isDeepStrictEqual(saved[selectedIndex(saved, expected.identity)], input.next)) throw new Error('PACKAGE_CONFIGURATION_NOT_PERSISTED');
  } finally { await release(); }
}

export const commitPackageEntry = (input: PackageEntryChange): Promise<void> => changeEntry(input, false);
export const restorePackageEntry = (input: PackageEntryChange): Promise<void> => changeEntry(input, true);
