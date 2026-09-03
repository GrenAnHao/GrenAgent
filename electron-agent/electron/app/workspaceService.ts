import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  name: string | null;
}

export class WorkspaceService {
  private readonly agentDir: string;
  private readonly worksDir: string;
  private readonly sessionsDir: string;
  private readonly drafts = new Set<string>();
  private closeWorkspace?: (workspace: string) => Promise<void>;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.worksDir = join(agentDir, 'works');
    this.sessionsDir = join(agentDir, 'sessions');
  }

  setWorkspaceCloser(closeWorkspace: (workspace: string) => Promise<void>): void {
    this.closeWorkspace = closeWorkspace;
  }

  async getWorksDir(): Promise<string> {
    await mkdir(this.worksDir, { recursive: true });
    return displayPath(await realpath(this.worksDir));
  }

  async createConversation(): Promise<{ cwd: string }> {
    const worksDir = await this.getWorksDir();
    const directory = join(worksDir, randomUUID());
    await mkdir(directory);
    const cwd = displayPath(await realpath(directory));
    this.drafts.add(normalizePath(cwd));
    return { cwd };
  }

  async ensureWorkspace(workspace: string): Promise<string> {
    try {
      return displayPath(await realpath(workspace));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const worksDir = await this.getWorksDir();
      if (!isDirectChild(worksDir, workspace)) throw error;
      await mkdir(workspace, { recursive: true });
      return displayPath(await realpath(workspace));
    }
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    const sessions = (await Promise.all(files.map((path) => readSession(path)))).filter((session): session is SessionInfo => session !== null);
    return sessions.filter((session) => session.cwd !== null).sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
  }

  async listSessions(workspace: string): Promise<SessionInfo[]> {
    const sessions = await this.listAllSessions();
    return sessions.filter((session) => session.cwd !== null && pathsEquivalent(session.cwd, workspace));
  }

  async pruneOrphanConversations(keep: string[]): Promise<number> {
    const worksDir = await this.getWorksDir();
    const used = new Set((await this.listAllSessions()).flatMap((session) => session.cwd ? [normalizePath(session.cwd)] : []));
    const retained = new Set(keep.map(normalizePath));
    let removed = 0;

    for (const entry of await readdir(worksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(worksDir, entry.name);
      const resolved = displayPath(await realpath(candidate));
      if (!isDirectChild(worksDir, resolved)) continue;
      const normalized = normalizePath(resolved);
      if (used.has(normalized) || retained.has(normalized) || this.drafts.has(normalized)) continue;
      await rm(resolved, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async deleteConversation(workspace: string): Promise<void> {
    const worksDir = await this.getWorksDir();
    try {
      const target = displayPath(await realpath(workspace));
      if (!isDirectChild(worksDir, target)) throw new Error('not a conversation directory');
      await this.closeWorkspace?.(target);
      await this.deleteSessionsForWorkspace(workspace);
      await rm(target, { recursive: true, force: true });
      this.drafts.delete(normalizePath(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.deleteSessionsForWorkspace(workspace);
    }
  }

  async removeProject(workspace: string): Promise<void> {
    await this.deleteSessionsForWorkspace(workspace);
  }

  async deleteSession(workspace: string, sessionPath: string): Promise<void> {
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await readSession(target); if (!info || !info.cwd || !pathsEquivalent(info.cwd, workspace)) throw new Error('session does not belong to workspace');
    await rm(target, { force: true });
  }

  private async deleteSessionsForWorkspace(workspace: string): Promise<void> {
    for (const path of await collectJsonlFiles(this.sessionsDir)) {
      const info = await readSession(path);
      if (info?.cwd && pathsEquivalent(info.cwd, workspace)) await rm(path, { force: true });
    }
  }
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const descendants = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectJsonlFiles(path);
    return entry.isFile() && path.endsWith('.jsonl') ? [path] : [];
  }));
  return descendants.flat();
}

async function readSession(path: string): Promise<SessionInfo | null> {
  const firstLine = (await readFile(path, 'utf8')).split(/\r?\n/, 1)[0];
  let header: Record<string, unknown> | undefined;
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    /* not JSON — fall through to path-based inference */
  }

  if (header?.type === 'session') {
    return {
      id: typeof header.id === 'string' ? header.id : '',
      path,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
      name: null,
    };
  }

  // pi sidecar no longer writes a session header; infer metadata from path.
  const cwd = inferCwdFromSessionPath(path);
  if (!cwd) return null;
  const timestamp = inferTimestampFromFilename(path);
  const id = inferIdFromFilename(path);
  return { id, path, cwd, timestamp, name: null };
}

/** Session files live at `<sessionsDir>/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
 *  The encoded cwd replaces `:` and every path separator with `-`, then wraps the
 *  result in `--` (e.g. `C:\Users\foo` → `--C--Users-foo--`). Literal `-` in the
 *  original path is also `-`, so decoding is ambiguous; resolve it greedily by
 *  validating each guessed separator boundary against the filesystem. */
function inferCwdFromSessionPath(sessionFilePath: string): string | null {
  const parent = displayPath(join(sessionFilePath, '..')).replace(/\\/g, '/').replace(/\/+$/, '');
  const encoded = parent.split('/').pop();
  if (!encoded || !encoded.startsWith('--') || !encoded.endsWith('--')) return null;
  return decodeEncodedCwd(encoded.slice(2, -2));
}

function decodeEncodedCwd(inner: string): string | null {
  let root: string;
  let rest: string;
  if (/^[A-Za-z]-/.test(inner)) {
    root = `${inner[0]}:\\`;
    rest = inner.slice(2);
    if (rest.startsWith('-')) rest = rest.slice(1);
  } else if (inner.startsWith('-')) {
    root = '/';
    rest = inner.slice(1);
  } else {
    return null;
  }
  const sep = root === '/' ? '/' : '\\';
  const attach = (prefix: string, part: string) => (prefix.endsWith(sep) ? prefix + part : prefix + sep + part);
  // Backtrack over each `-` (separator vs literal dash), validating against the
  // filesystem. Trying the whole remainder as one segment first prefers literal
  // dashes (`src-tauri` wins over `src/tauri` when both exist).
  const solve = (prefix: string, s: string): string | null => {
    if (!s) return null;
    if (existsSync(attach(prefix, s))) return attach(prefix, s);
    for (let i = 1; i < s.length; i++) {
      if (s[i] !== '-') continue;
      const candidate = attach(prefix, s.slice(0, i));
      if (!existsSync(candidate)) continue;
      const solved = solve(candidate, s.slice(i + 1));
      if (solved) return solved;
    }
    return null;
  };
  return solve(root, rest);
}

function inferTimestampFromFilename(sessionFilePath: string): string | null {
  const base = sessionFilePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) return null;
  // Filename uses `-` where ISO timestamp uses `:`: `2026-08-28T16-27-36-994Z` → `2026-08-28T16:27:36.994Z`
  const raw = match[1];
  return raw.slice(0, 13) + ':' + raw.slice(14, 16) + ':' + raw.slice(17, 19) + '.' + raw.slice(20, 23) + 'Z';
}

function inferIdFromFilename(sessionFilePath: string): string {
  const base = sessionFilePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = base.match(/_([^.]+)\.jsonl$/);
  return match ? match[1] : '';
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = normalizePath(candidate).slice(normalizePath(parent).length).replace(/^\/+/, '');
  return relative.length > 0 && !relative.includes('/');
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = normalizePath(candidate).slice(normalizePath(parent).length).replace(/^\/+/, '');
  return relative.length > 0 && !relative.startsWith('..');
}

function pathsEquivalent(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  return displayPath(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
}
