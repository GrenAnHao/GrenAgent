import { randomUUID } from 'node:crypto';
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
  private readonly worksDir: string;
  private readonly sessionsDir: string;
  private readonly drafts = new Set<string>();

  constructor(agentDir: string) {
    this.worksDir = join(agentDir, 'works');
    this.sessionsDir = join(agentDir, 'sessions');
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
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.type !== 'session') return null;
  return {
    id: typeof header.id === 'string' ? header.id : '',
    path,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
    name: null,
  };
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = normalizePath(candidate).slice(normalizePath(parent).length).replace(/^\/+/, '');
  return relative.length > 0 && !relative.includes('/');
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
