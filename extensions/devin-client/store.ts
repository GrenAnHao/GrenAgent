import { mkdir, readFile, rename, writeFile, chmod, unlink, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fail, object } from './safety.js';

/** Grant payload persisted locally (same shape as the original DSH GrantRecord payload). */
export interface Grant {
  version: 1;
  token: string;
  expiresAt: number;
  expirySource: 'jwt' | 'fallback';
  revoked?: boolean;
}

export function defaultStorePath(): string {
  if (process.env.DEVIN_SEARCH_SESSION) return process.env.DEVIN_SEARCH_SESSION;
  const home = process.env.DEVIN_SEARCH_HOME
    ?? (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'devin-search') : join(homedir(), '.config', 'devin-search'));
  return join(home, 'session.json');
}

function parseGrant(raw: unknown): Grant | undefined {
  const p = object(raw);
  if (
    p?.version !== 1 ||
    typeof p.token !== 'string' ||
    !p.token ||
    typeof p.expiresAt !== 'number' ||
    !Number.isFinite(p.expiresAt) ||
    !['jwt', 'fallback'].includes(String(p.expirySource))
  ) {
    return;
  }
  return {
    version: 1,
    token: p.token,
    expiresAt: p.expiresAt,
    expirySource: p.expirySource as 'jwt' | 'fallback',
    ...(p.revoked === true ? { revoked: true } : {}),
  };
}

export class FileStore {
  constructor(readonly path: string = defaultStorePath()) {}

  async read(): Promise<Grant | undefined> {
    try {
      const text = await readFile(this.path, 'utf8');
      return parseGrant(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return fail('storage', 'Unable to read Devin session file.');
    }
  }

  async write(grant: Grant): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(grant, null, 2) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } catch {
      return fail('storage', 'Unable to write Devin session file.');
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail('storage', 'Unable to clear Devin session file.');
      }
    }
  }
}
