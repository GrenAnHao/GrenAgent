import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fastPreferenceKey } from './fast-mode.js';

export type FastPreferences = Record<string, boolean>;
const writes = new Map<string, Promise<unknown>>();

export async function readFastPreferences(agentDir: string): Promise<FastPreferences> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(agentDir, 'fast-mode.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fast-mode.json');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'boolean'));
}

/** Serialize read/merge/atomic-write so concurrent model updates cannot erase one another. */
export async function writeFastPreference(agentDir: string, provider: string, id: string, enabled: boolean): Promise<FastPreferences> {
  const path = resolve(agentDir, 'fast-mode.json');
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const next = { ...await readFastPreferences(agentDir), [fastPreferenceKey(provider, id)]: enabled };
    await mkdir(agentDir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return next;
  });
  writes.set(path, current);
  try { return await current; }
  finally { if (writes.get(path) === current) writes.delete(path); }
}
