import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSubagentSessionMeta, type SubagentSessionMeta } from './subagentSession.js';
import { isSystemWorkerSessionLines } from './systemWorkerSession.js';
import { readFirstLine } from './sessionIdentity.js';
import { firstLineOf, forEachLineContaining, linesContaining } from './sessionLineScan.js';

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

/** 同一份文件（大小、修改时间都没变）只解析一次；并发的扫描共用同一个 promise。 */
interface CachedRecord {
  size: number;
  mtimeMs: number;
  record: Promise<SessionRecord | null>;
}

interface ChildSession {
  path: string;
  /** 用来被孙级 parentSession 命中的归一化拼法：原路径 + realpath。 */
  keys: string[];
  agentId: string | null;
  parentSession: string | null;
}

/**
 * 子代理的控制面（registry、活着的子会话）在 agent-host 子进程里。删会话 / 会话目录前要先经它收口。
 * 默认在本进程内调用（测试与单进程场景），主进程用 setSubagentControl 换成 RPC。
 */
export interface SubagentControlPort {
  release(path: string): Promise<void>;
  releaseChildForDelete(workspace: string, agentId: string | null, path: string): Promise<{ quiescent: boolean }>;
}

const inProcessSubagentControl: SubagentControlPort = {
  release: async (path) => {
    (await import('../../../extensions/multi-agent/controlPlane.js')).releaseSubagentControlPlane(path);
  },
  releaseChildForDelete: async (workspace, agentId, path) =>
    (await import('../../../extensions/multi-agent/controlPlane.js')).releaseChildForDelete(workspace, agentId, path),
};

export class WorkspaceService {
  private readonly agentDir: string;
  private readonly worksDir: string;
  private readonly sessionsDir: string;
  private readonly drafts = new Set<string>();
  private readonly records = new Map<string, CachedRecord>();
  private closeWorkspace?: (workspace: string) => Promise<void>;
  private releaseSessions?: (sessionPaths: string[]) => Promise<void>;
  private subagentControl: SubagentControlPort = inProcessSubagentControl;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.worksDir = join(agentDir, 'works');
    this.sessionsDir = join(agentDir, 'sessions');
  }

  setSubagentControl(port: SubagentControlPort): void {
    this.subagentControl = port;
  }

  setWorkspaceCloser(closeWorkspace: (workspace: string) => Promise<void>): void {
    this.closeWorkspace = closeWorkspace;
  }

  /**
   * 删会话文件前先把它从运行时摘下（停掉在跑的回合、拆掉或换走持有它的 handle）。
   * 还挂着的会话会把后续条目 append 回同一路径，删了也会被重建成无头文件。抛错时不删。
   */
  setSessionReleaser(releaseSessions: (sessionPaths: string[]) => Promise<void>): void {
    this.releaseSessions = releaseSessions;
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
      const resolved = displayPath(await realpath(workspace));
      // Pi 在第一条助手消息之前不写 session jsonl。没对话的项目只能靠这里记住，否则重启后侧栏扫不到目录。
      await this.rememberProject(resolved);
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const worksDir = await this.getWorksDir();
      if (!isDirectChild(worksDir, workspace)) throw error;
      await mkdir(workspace, { recursive: true });
      return displayPath(await realpath(workspace));
    }
  }

  /** 已打开、但可能还没有任何会话文件的项目目录。重启后侧栏靠这份登记恢复。 */
  async listProjects(): Promise<string[]> {
    const saved = await this.readProjectRegistry();
    const existing: string[] = [];
    let dropped = false;
    for (const project of saved) {
      try {
        const info = await stat(project);
        if (!info.isDirectory()) {
          dropped = true;
          continue;
        }
        existing.push(displayPath(await realpath(project)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') dropped = true;
        else existing.push(project);
      }
    }
    if (dropped) await this.writeProjectRegistry(existing);
    return existing;
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    this.forgetRecordsExcept(files);
    const sessions = (await Promise.all(files.map((path) => this.readSession(path)))).filter((session): session is SessionInfo => session !== null);
    return sessions.filter((session) => session.cwd !== null).sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
  }

  async listSessions(workspace: string): Promise<SessionInfo[]> {
    // 先只看头一行筛掉别的项目，再逐行解析剩下的。全量解析所有项目的会话会在主进程里干耗几百毫秒。
    const files = await collectJsonlFiles(this.sessionsDir);
    const candidates = await Promise.all(files.map(async (path) => (await headerMayBelongTo(path, workspace) ? path : null)));
    const sessions = await Promise.all(candidates.filter((path): path is string => path !== null).map((path) => this.readSession(path)));
    return sessions
      .filter((session): session is SessionInfo => session !== null && session.cwd !== null && pathsEquivalent(session.cwd, workspace))
      .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
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
      await this.subagentControl.release(resolved);
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
        await this.subagentControl.release(target);
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
    await this.forgetProject(workspace);
  }

  async setSessionDisplayName(sessionPath: string, name: string): Promise<void> {
    const trimmed = name.replace(/[\r\n]+/g, ' ').trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await this.readSession(target);
    if (!info) throw new Error('SESSION_NOT_FOUND');
    await appendFile(target, `${JSON.stringify({ type: 'session_info', name: trimmed })}\n`);
  }

  async deleteSession(workspace: string, sessionPath: string): Promise<void> {
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await this.readSession(target); if (!info || !info.cwd || !pathsEquivalent(info.cwd, workspace)) throw new Error('session does not belong to workspace');
    // 先停父会话：它还在跑就可能再开子代理，换走时收口的子级结算也得落在文件删掉之前。
    await this.releaseSessions?.([...new Set([sessionPath, target])]);
    const children = await this.childSessionsIn(workspace);
    // 子会话 parentSession 是 SDK 落盘写法，与调用方传入 / realpath 后的拼法都可能不同，两者都作根。
    await this.removeChildSessions(workspace, descendantsLeafFirst(children, [sessionPath, target]));
    await rm(target, { force: true });
  }

  private async deleteSessionsForWorkspace(workspace: string): Promise<void> {
    const records = await this.sessionRecordsIn(workspace);
    if (records.length > 0) await this.releaseSessions?.(records.map((record) => record.info.path));
    const kept = await this.removeChildSessions(workspace, await this.orderedChildren(records));
    for (const record of records) {
      if (!kept.has(record.info.path)) await rm(record.info.path, { force: true });
    }
  }

  /** 只收口不删文件：deleteConversation 在 closeWorkspace 前调用。 */
  private async tearDownChildSessions(workspace: string): Promise<void> {
    for (const child of await this.orderedChildren(await this.sessionRecordsIn(workspace))) {
      await this.subagentControl.releaseChildForDelete(workspace, child.agentId, child.path);
    }
  }

  /**
   * 先收口活着的子代理再删文件：跑着的子级会把尾部 append 回同名路径，变成无头的假会话。
   * 等超时（子级可能还在写）的不删，留在盘上仍是隐藏的；返回这些保留下来的路径。
   */
  private async removeChildSessions(workspace: string, children: ChildSession[]): Promise<Set<string>> {
    const kept = new Set<string>();
    for (const child of children) {
      const { quiescent } = await this.subagentControl.releaseChildForDelete(workspace, child.agentId, child.path);
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

  private projectsPath(): string {
    return join(this.agentDir, 'opened-projects.json');
  }

  private async rememberProject(workspace: string): Promise<void> {
    const worksDir = await this.getWorksDir();
    if (isUnderPath(worksDir, workspace)) return;
    const projects = await this.readProjectRegistry();
    if (projects.some((project) => pathsEquivalent(project, workspace))) return;
    await this.writeProjectRegistry([...projects, workspace]);
  }

  private async forgetProject(workspace: string): Promise<void> {
    const projects = await this.readProjectRegistry();
    const next = projects.filter((project) => !pathsEquivalent(project, workspace));
    if (next.length === projects.length) return;
    await this.writeProjectRegistry(next);
  }

  private async readProjectRegistry(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.projectsPath(), 'utf8')) as { projects?: unknown };
      if (!Array.isArray(parsed.projects)) return [];
      return parsed.projects.filter((project): project is string => typeof project === 'string' && project.trim().length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  private async writeProjectRegistry(projects: string[]): Promise<void> {
    await writeFile(this.projectsPath(), JSON.stringify({ projects }), 'utf8');
  }

  private async sessionRecordsIn(workspace: string): Promise<SessionRecord[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    this.forgetRecordsExcept(files);
    const records = await Promise.all(files.map((path) => this.readSessionRecord(path)));
    return records.filter((record): record is SessionRecord => Boolean(record?.info.cwd && pathsEquivalent(record.info.cwd, workspace)));
  }

  /** 列表 / 单会话操作用：隐藏会话视同不存在。 */
  private async readSession(path: string): Promise<SessionInfo | null> {
    const record = await this.readSessionRecord(path);
    // 缓存里的对象会交给下一次扫描，调用方拿到的是副本。
    return record && !record.hidden ? { ...record.info } : null;
  }

  /**
   * 侧栏每次刷新都要扫全部会话，启动时一连好几次。文件没变就复用上次的结果，只花一次 stat。
   * 先 stat 再读：读到的内容只会比 stat 时更新，下次 stat 发现变了会重读，不会把旧内容当新的。
   */
  private async readSessionRecord(path: string): Promise<SessionRecord | null> {
    const info = await stat(path);
    const cached = this.records.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.record;
    const record = parseSessionRecord(path);
    const entry: CachedRecord = { size: info.size, mtimeMs: info.mtimeMs, record };
    this.records.set(path, entry);
    // 读失败不留缓存：文件可能正被删除或替换，下次重新读。
    record.catch(() => {
      if (this.records.get(path) === entry) this.records.delete(path);
    });
    return record;
  }

  /** 全量扫描时顺手丢掉已删除文件的缓存。 */
  private forgetRecordsExcept(files: string[]): void {
    if (this.records.size === 0) return;
    const present = new Set(files);
    for (const path of this.records.keys()) {
      if (!present.has(path)) this.records.delete(path);
    }
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

/**
 * 头一行是带 cwd 的 session 头时按它判断归属；没有头、读不出或解析失败的交给完整解析，
 * 规则和 parseSessionRecord 一致（它会按路径推断 cwd）。
 */
async function headerMayBelongTo(path: string, workspace: string): Promise<boolean> {
  let header: Record<string, unknown> | null = null;
  try {
    header = JSON.parse(await readFirstLine(path)) as Record<string, unknown> | null;
  } catch {
    return true;
  }
  if (header?.type !== 'session') return true;
  return typeof header.cwd === 'string' && pathsEquivalent(header.cwd, workspace);
}

/**
 * 只解析可能有用的行：标题（`"session_info"`）、首条用户消息（`"user"`）、
 * 子代理标记（`"subagent_meta"`）、旧短调用提示（JSON 里转义成 `\nTask kind: `）。
 * 这些标记都是对应判据的必要条件，命中的行仍按原规则判定，结果与逐行全量解析相同。
 */
async function parseSessionRecord(path: string): Promise<SessionRecord | null> {
  const buffer = await readFile(path);
  let header: Record<string, unknown> | undefined;
  try {
    header = JSON.parse(firstLineOf(buffer)) as Record<string, unknown>;
  } catch {
    /* not JSON — fall through to path-based inference */
  }

  // 在回调里赋值：用 as 声明，免得 TS 把它们收窄成 null。
  let name = null as string | null;
  forEachLineContaining(buffer, '"session_info"', (line) => {
    const entry = parseEntry(line);
    if (entry?.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) name = entry.name.trim();
  });
  let firstUser = null as string | null;
  forEachLineContaining(buffer, '"user"', (line) => {
    const entry = parseEntry(line);
    if (entry?.type !== 'message') return false;
    firstUser = firstUserTextFromEntry(entry);
    return firstUser !== null;
  });
  if (!name && firstUser) name = firstUser;

  const meta = readSubagentSessionMeta(linesContaining(buffer, '"subagent_meta"'));
  const hidden = meta !== undefined || isSystemWorkerSessionLines(linesContaining(buffer, '\\nTask kind: '));
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

function isUnderPath(root: string, candidate: string): boolean {
  const parent = normalizePath(root);
  const child = normalizePath(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = normalizePath(candidate).slice(normalizePath(parent).length).replace(/^\/+/, '');
  return relative.length > 0 && !relative.includes('/');
}

/** 坏行（含写了一半的末行）当作不存在。 */
function parseEntry(line: string): Record<string, unknown> | null {
  try {
    const entry = JSON.parse(line) as unknown;
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
  } catch {
    return null;
  }
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
