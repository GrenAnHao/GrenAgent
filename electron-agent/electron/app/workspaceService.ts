import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseChildForDelete, releaseSubagentControlPlane } from '../../../extensions/multi-agent/controlPlane.js';
import { readSubagentSessionMeta, type SubagentSessionMeta } from './subagentSession.js';
import { isSystemWorkerSessionLines } from './systemWorkerSession.js';

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  name: string | null;
}

/** `hidden`：子代理 / 系统短调用会话——不进列表，但随所属工作区一起删除。 */
interface SessionRecord {
  info: SessionInfo;
  hidden: boolean;
  /** 仅子代理会话：父会话被删时按 parentSession 级联。 */
  subagent?: SubagentSessionMeta;
}

interface ChildSession {
  path: string;
  /** 用来被孙级 parentSession 命中的归一化拼法：原路径 + realpath。 */
  keys: string[];
  agentId: string | null;
  parentSession: string | null;
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
      // 目录里只剩隐藏会话（子代理 / 系统短调用）时才会走到这里，随目录一起清掉，避免 JSONL 孤儿。
      // 先删会话再释放 registry：子级收尾写 registry 必须落在关闭之前，否则懒重建的 registry.db 会顶住 rm。
      await this.deleteSessionsForWorkspace(resolved);
      releaseSubagentControlPlane(resolved);
      await rmWithBusyRetry(resolved);
      removed += 1;
    }
    return removed;
  }

  async deleteConversation(workspace: string): Promise<void> {
    const worksDir = await this.getWorksDir();
    try {
      const target = displayPath(await realpath(workspace));
      if (!isDirectChild(worksDir, target)) throw new Error('not a conversation directory');
      // 活着的子代理先收口：closeWorkspace 会顺手释放 registry，之后子级收尾写 registry 只会把 registry.db 重建回目录里。
      await this.tearDownChildSessions(workspace);
      try {
        await this.closeWorkspace?.(target);
      } finally {
        releaseSubagentControlPlane(target);
      }
      await this.deleteSessionsForWorkspace(workspace);
      await rmWithBusyRetry(target);
      this.drafts.delete(normalizePath(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.deleteSessionsForWorkspace(workspace);
    }
  }

  async removeProject(workspace: string): Promise<void> {
    await this.deleteSessionsForWorkspace(workspace);
  }

  async setSessionDisplayName(sessionPath: string, name: string): Promise<void> {
    const trimmed = name.replace(/[\r\n]+/g, ' ').trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await readSession(target);
    if (!info) throw new Error('SESSION_NOT_FOUND');
    await appendFile(target, `${JSON.stringify({ type: 'session_info', name: trimmed })}\n`);
  }

  async deleteSession(workspace: string, sessionPath: string): Promise<void> {
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await readSession(target); if (!info || !info.cwd || !pathsEquivalent(info.cwd, workspace)) throw new Error('session does not belong to workspace');
    const children = await this.childSessionsIn(workspace);
    // 子会话 parentSession 是 SDK 落盘写法，与调用方传入 / realpath 后的拼法都可能不同，两者都作根。
    await this.removeChildSessions(workspace, descendantsLeafFirst(children, [sessionPath, target]));
    await rm(target, { force: true });
  }

  private async deleteSessionsForWorkspace(workspace: string): Promise<void> {
    const records = await this.sessionRecordsIn(workspace);
    const kept = await this.removeChildSessions(workspace, await this.orderedChildren(records));
    for (const record of records) {
      if (!kept.has(record.info.path)) await rm(record.info.path, { force: true });
    }
  }

  /** 只收口不删文件：deleteConversation 在 closeWorkspace 前调用。 */
  private async tearDownChildSessions(workspace: string): Promise<void> {
    for (const child of await this.orderedChildren(await this.sessionRecordsIn(workspace))) {
      await releaseChildForDelete(workspace, child.agentId, child.path);
    }
  }

  /**
   * 先收口活着的子代理再删文件：跑着的子级会把尾部 append 回同名路径，变成无头的假会话。
   * 等超时（子级可能还在写）的不删，留在盘上仍是隐藏的；返回这些保留下来的路径。
   */
  private async removeChildSessions(workspace: string, children: ChildSession[]): Promise<Set<string>> {
    const kept = new Set<string>();
    for (const child of children) {
      const { quiescent } = await releaseChildForDelete(workspace, child.agentId, child.path);
      if (!quiescent) {
        kept.add(child.path);
        continue;
      }
      await rm(child.path, { force: true });
    }
    return kept;
  }

  /** 工作区内全部子会话，后代在前；parentSession 为空的孤儿排最后。 */
  private async orderedChildren(records: SessionRecord[]): Promise<ChildSession[]> {
    const children = await Promise.all(records.filter((record) => record.subagent).map((record) => toChildSession(record)));
    const ordered = descendantsLeafFirst(children, children.flatMap((child) => (child.parentSession ? [child.parentSession] : [])));
    return [...ordered, ...children.filter((child) => !ordered.includes(child))];
  }

  private async childSessionsIn(workspace: string): Promise<ChildSession[]> {
    const records = await this.sessionRecordsIn(workspace);
    return Promise.all(records.filter((record) => record.subagent).map((record) => toChildSession(record)));
  }

  private async sessionRecordsIn(workspace: string): Promise<SessionRecord[]> {
    const records = await Promise.all((await collectJsonlFiles(this.sessionsDir)).map((path) => readSessionRecord(path)));
    return records.filter((record): record is SessionRecord => Boolean(record?.info.cwd && pathsEquivalent(record.info.cwd, workspace)));
  }
}

async function toChildSession(record: SessionRecord): Promise<ChildSession> {
  const path = record.info.path;
  const canonical = await realpath(path).catch(() => path);
  return {
    path,
    keys: [...new Set([normalizePath(path), normalizePath(canonical)])],
    agentId: record.subagent?.agentId ?? null,
    parentSession: record.subagent?.parentSession ?? null,
  };
}

/**
 * `roots` 下的全部后代，后代在前、祖先在后（后序）：先拆孙级再拆子级，
 * 孙级结算才不会把消息灌进一个马上要删的子会话。
 */
function descendantsLeafFirst(children: ChildSession[], roots: string[]): ChildSession[] {
  const byParent = new Map<string, ChildSession[]>();
  for (const child of children) {
    if (!child.parentSession) continue;
    const key = normalizePath(child.parentSession);
    byParent.set(key, [...(byParent.get(key) ?? []), child]);
  }
  const ordered: ChildSession[] = [];
  const seen = new Set<ChildSession>();
  const visit = (parentKey: string): void => {
    for (const child of byParent.get(parentKey) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      for (const key of child.keys) visit(key);
      ordered.push(child);
    }
  };
  for (const root of roots) visit(normalizePath(root));
  return ordered;
}

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function rmWithBusyRetry(target: string): Promise<void> {
  const delays = [0, 25, 50, 100, 200];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !BUSY_CODES.has(code) || attempt === delays.length - 1) throw error;
    }
  }
  throw lastError;
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

/** 列表 / 单会话操作用：隐藏会话视同不存在。 */
async function readSession(path: string): Promise<SessionInfo | null> {
  const record = await readSessionRecord(path);
  return record && !record.hidden ? record.info : null;
}

async function readSessionRecord(path: string): Promise<SessionRecord | null> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  let header: Record<string, unknown> | undefined;
  try {
    header = JSON.parse(lines[0]) as Record<string, unknown>;
  } catch {
    /* not JSON — fall through to path-based inference */
  }

  let name: string | null = null;
  let firstUser: string | null = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown> | null;
      if (!entry) continue;
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        name = entry.name.trim();
      } else if (!firstUser && entry.type === 'message') {
        const text = firstUserTextFromEntry(entry);
        if (text) firstUser = text;
      }
    } catch {
      /* Ignore malformed entries, including a partially written last line. */
    }
  }
  if (!name && firstUser) name = firstUser;

  const meta = readSubagentSessionMeta(lines);
  const hidden = meta !== undefined || isSystemWorkerSessionLines(lines);
  const headerParent = typeof header?.parentSession === 'string' && header.parentSession.trim() ? header.parentSession : null;
  const subagent = meta ? { ...meta, parentSession: meta.parentSession ?? headerParent } : undefined;

  if (header?.type === 'session') {
    return {
      hidden,
      ...(subagent ? { subagent } : {}),
      info: {
        id: typeof header.id === 'string' ? header.id : '',
        path,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
        name,
      },
    };
  }

  // pi sidecar no longer writes a session header; infer metadata from path.
  const cwd = inferCwdFromSessionPath(path);
  if (!cwd) return null;
  const timestamp = inferTimestampFromFilename(path);
  const id = inferIdFromFilename(path);
  return { hidden, ...(subagent ? { subagent } : {}), info: { id, path, cwd, timestamp, name } };
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

const SIDEBAR_TITLE_MAX = 80;

function firstUserTextFromEntry(entry: Record<string, unknown>): string | null {
  const nested = entry.message;
  const msg = (nested && typeof nested === 'object' ? nested : entry) as { role?: unknown; content?: unknown };
  if (msg.role !== 'user') return null;
  const raw = extractMessageText(msg.content).replace(/\s+/g, ' ').trim();
  return raw ? raw.slice(0, SIDEBAR_TITLE_MAX) : null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join(' ');
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
