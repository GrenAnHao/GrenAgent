import { randomUUID } from 'node:crypto';
import { existsSync, type Stats } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSubagentSessionMeta, type SubagentSessionMeta } from './subagentSession.js';
import { isSystemWorkerSessionLines } from './systemWorkerSession.js';
import { readFirstLine } from './sessionIdentity.js';
import { firstLineOf, forEachLineContaining, linesContaining } from './sessionLineScan.js';
import { SessionSummaryCache } from './sessionSummaryCache.js';
import {
  SessionOperationLeaseBlockedError,
  SessionOperationLeaseBusyError,
  sessionOperationLeases,
  withSessionOperationLease,
} from './sessionOperationLease.js';
import { fallbackSessionTitle, firstUserMessage } from '../../../extensions/_shared/session-title.js';

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  name: string | null;
  /** 用户归档了这份会话：侧栏不列，只在「已归档」里出现。没归档时不带这个字段。 */
  archived?: true;
}

/** `hidden`：子代理 / 系统短调用会话——不进列表，但随所属工作区一起删除。 */
export interface SessionRecord {
  info: SessionInfo;
  hidden: boolean;
  /** 仅子代理会话：父会话被删时按 parentSession 级联。 */
  subagent?: SubagentSessionMeta;
  /**
   * 托管 `session_project_transfer` 迁移事实里记下的源 scratch 保留根。
   * 源目录仍被迁移历史或用户文件引用期间，自动 orphan prune 不能删它。
   */
  retentionRoots: string[];
}

/** 迁移 journal 的恢复闸门：list / read / 删除 / prune 前必须等它完成或如实报告 blocked。 */
export type SessionTransferRecoveryGate = (paths: string[]) => Promise<void>;

/** 一次迁移族写完后，宿主显式要求失效的记录缓存与列表投影。 */
export interface SessionTransferCacheChange {
  /** 需要重读的会话文件；同尺寸、同 mtime 的原子替换也算变化。 */
  paths?: string[];
  /** 迁移事实有变化的路径（缓存与保留根都要重算）。 */
  invalidate?: string[];
  /** 已提交但目标打开失败等：这些路径读出来要报 blocked 而不是半迁移状态。 */
  blocked?: Array<{ path: string; reason: string }>;
}

/** 同一份文件（大小、修改时间都没变）只解析一次；并发的扫描共用同一个 promise。 */
interface CachedRecord {
  stamp: Stats;
  record: Promise<SessionRecord | null>;
  published?: boolean;
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
  private readonly summaries: SessionSummaryCache;
  /** One queue shared by all callers: concurrent project/global lists must not multiply the limit. */
  private activeParses = 0;
  private readonly parseQueue: Array<() => void> = [];
  private readonly projectsChanged = new Set<() => void>();
  /** Host authority records already read from disk; reading this snapshot never visits project directories. */
  private projectSnapshot?: string[];
  private projectQueue: Promise<unknown> = Promise.resolve();
  private closeWorkspace?: (workspace: string) => Promise<void>;
  private releaseSessions?: (sessionPaths: string[]) => Promise<void>;
  private subagentControl: SubagentControlPort = inProcessSubagentControl;
  /** 归档登记表的读改写排成一队，并发的归档 / 取消归档 / 清理不会互相覆盖。 */
  private archiveQueue: Promise<unknown> = Promise.resolve();
  /**
   * 未完成迁移的恢复闸门。list / 读 / 删除 / prune 先等它；ensureWorkspace 与项目登记不能等，
   * 否则 committed 恢复里 resolveWorkspace → ensureWorkspace 会绕回自己。
   */
  private recoveryGate?: SessionTransferRecoveryGate;
  /** committed-needs-open 等已提交但不可暴露的会话：读写前如实报 blocked。 */
  private readonly blockedPaths = new Map<string, string>();
  /** 迁移 owner 显式登记的源 scratch 保留根（会话文件还没落盘 / 已提交待打开时也要保住）。 */
  private readonly retentionOverrides = new Map<string, string>();

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.worksDir = join(agentDir, 'works');
    this.sessionsDir = join(agentDir, 'sessions');
    this.summaries = new SessionSummaryCache(agentDir);
  }

  subscribeProjectsChanged(handler: () => void): () => void {
    this.projectsChanged.add(handler);
    return () => { this.projectsChanged.delete(handler); };
  }

  getProjectSnapshot(): string[] | undefined {
    return this.projectSnapshot ? [...this.projectSnapshot] : undefined;
  }

  /** Registry metadata only. Target existence/canonicalization belongs to the requested operation. */
  async readProjectSnapshot(): Promise<string[]> {
    return this.withProjectRegistry(async () => {
      try {
        const parsed = JSON.parse(await readFile(this.projectsPath(), 'utf8')) as { projects?: unknown };
        if (!Array.isArray(parsed.projects) || !parsed.projects.every((project) => typeof project === 'string' && project.trim().length > 0))
          throw new Error('Host project registry is invalid');
        this.projectSnapshot = [...parsed.projects];
        return [...this.projectSnapshot];
      } catch (error) {
        // A stale fast snapshot must not retain repository authority after a failed refresh.
        this.projectSnapshot = [];
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  }

  /** A fast classification for the renderer handshake; it grants no filesystem access. */
  isConversationWorkspaceSnapshot(workspace: string): boolean {
    return isUnderPath(this.worksDir, workspace);
  }

  /** Classification only: scratch conversations never grant project authority. */
  async isConversationWorkspace(workspace: string): Promise<boolean> {
    const worksDir = await this.getWorksDir();
    const resolved = await realpath(workspace).catch(() => undefined);
    return resolved !== undefined && isUnderPath(worksDir, resolved);
  }

  setSubagentControl(port: SubagentControlPort): void {
    this.subagentControl = port;
  }

  /** 迁移 journal 恢复闸门。传 undefined 取消（测试 / 单进程场景）。 */
  setRecoveryGate(gate: SessionTransferRecoveryGate | undefined): void {
    this.recoveryGate = gate;
  }

  /**
   * 宿主在迁移族写入后显式失效记录缓存：同尺寸 / 同 mtime 的原子替换靠它，不能靠目录名或时间戳推断。
   * 只影响列出的路径，其他项目和会话的缓存保持不变。
   */
  async invalidateSessionRecords(paths: string[]): Promise<void> {
    for (const path of paths) this.records.delete(path);
    await this.summaries.open();
    for (const path of paths) this.summaries.drop(path);
    await this.summaries.flush();
  }

  /** 已提交但目标尚未打开等：受影响会话读 / 删前报 blocked，而不是给出半迁移状态。 */
  markSessionPathsBlocked(entries: Array<{ path: string; reason: string }>): void {
    for (const entry of entries) this.blockedPaths.set(normalizePath(entry.path), entry.reason);
  }

  clearSessionPathsBlocked(paths: string[]): void {
    for (const path of paths) this.blockedPaths.delete(normalizePath(path));
  }

  /** 删除 / 重命名 / 归档前的同步闸门：未完成迁移的族不能当普通会话写入。 */
  assertSessionPathsAvailable(paths: string[]): void {
    for (const path of paths) {
      const reason = this.blockedPaths.get(normalizePath(path));
      if (reason !== undefined) throw new Error(`SESSION_TRANSFER_BLOCKED: ${reason}`);
    }
  }

  private async awaitRecovery(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.recoveryGate?.(paths);
  }

  /**
   * 与运行时共享的跨进程排他点。作用域内嵌套调用复用同一 owner，不会自等；
   * 锁前后的恢复闸门各查一次：等锁期间 migration 可能刚提交。
   *
   * workspaces 用来覆盖「header 已改成目标、按源项目扫不出这个族」的 applying 事务：
   * 只信当前 header 的路径集合会漏掉它们，项目级清理必须同时问 journal。
   */
  private async locked<T>(paths: string[], operation: () => Promise<T>, options: { workspaces?: string[] } = {}): Promise<T> {
    const coordinator = sessionOperationLeases(this.agentDir);
    const workspaces = options.workspaces?.filter((workspace) => workspace.trim().length > 0);
    const unique = [...new Set(paths)].filter((path) => path.trim().length > 0);
    const ensureClear = async (): Promise<void> => {
      await this.awaitRecovery(unique);
      const blocked = await coordinator.probe({ paths: unique, ...(workspaces?.length ? { workspaces } : {}) });
      if (blocked.length > 0) throw new SessionOperationLeaseBlockedError(blocked);
    };
    await ensureClear();
    if (unique.length === 0) return operation();
    return withSessionOperationLease(this.agentDir, unique, async () => {
      await ensureClear();
      return operation();
    });
  }

  /**
   * 会话族闭包：给定根会话，找出所有子孙（按 subagent metadata 的 parentSession 链）。
   * 只用于删除 / 清理这类整族写操作；不扩到同项目其他会话。
   */
  private async descendantPaths(roots: string[]): Promise<string[]> {
    const rootKeys = new Set<string>();
    for (const root of roots) {
      rootKeys.add(normalizePath(root));
      const resolved = await realpath(root).catch(() => root);
      rootKeys.add(normalizePath(resolved));
    }
    const files = await collectJsonlFiles(this.sessionsDir);
    const records = await Promise.all(files.map((path) => this.readSessionRecord(path)));
    const children = new Map<string, ChildSession[]>();
    for (const record of records) {
      if (!record?.subagent || !record.subagent.parentSession) continue;
      const child = await toChildSession(record);
      for (const key of child.keys) children.set(key, [...(children.get(key) ?? []), child]);
    }
    const found = new Map<string, string>();
    const visit = (parentKey: string): void => {
      for (const child of children.get(parentKey) ?? []) {
        if (rootKeys.has(normalizePath(child.path)) || found.has(normalizePath(child.path))) continue;
        found.set(normalizePath(child.path), child.path);
        for (const key of child.keys) visit(key);
      }
    };
    for (const key of rootKeys) visit(key);
    return [...found.values()];
  }

  /** 某个工作区的会话族（含子级）：删除 / 清理前一次性拿齐，避免删到一半树。 */
  private async workspaceFamilyPaths(workspace: string): Promise<string[]> {
    const records = await this.sessionRecordsIn(workspace);
    const paths = records.map((record) => record.info.path);
    return [...new Set([...paths, ...(await this.descendantPaths(paths))])];
  }

  /** 已提交但目标未打开的会话：删除 / 归档 / 重命名前拒绝，不能把半迁移当普通会话处理。 */
  private blockedFamilyReason(paths: string[]): string | undefined {
    for (const path of paths) {
      const reason = this.blockedPaths.get(normalizePath(path));
      if (reason !== undefined) return reason;
    }
    return undefined;
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
    return this.withProjectRegistry(async () => {
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
      this.projectSnapshot = [...existing];
      return existing;
    });
  }

  /** Cold start checks one managed JSONL, not the sidebar. A moved session keeps its path but changes cwd. */
  async lookupStartupSession(sessionPath: string): Promise<SessionInfo | null> {
    if (!isAbsolute(sessionPath) || !sessionPath.endsWith('.jsonl')) return null;
    const path = resolve(sessionPath);
    const child = relative(this.sessionsDir, path);
    if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) return null;
    // Recovery can replace the file, so validate the actual file only after the journal settles.
    await this.awaitRecovery([path]);
    this.assertSessionPathsAvailable([path]);
    try {
      const [root, target] = await Promise.all([realpath(this.sessionsDir), realpath(path)]);
      // The recursive sidebar listing does not follow symlinks. The direct lookup must not add that authority.
      if (relative(join(root, child), target) !== '' || !(await stat(target)).isFile()) return null;
      if ((await this.readArchiveRegistry()).some(entry => pathsEquivalent(entry, path))) return null;
      const found = await this.readSession(path);
      return found?.cwd && (await stat(found.cwd)).isDirectory() ? found : null;
    } catch (error) {
      if (isMissingStartupPath(error)) return null;
      throw error;
    }
  }

  /** A scratch is created directly below works. Pi writes its sessions to the cwd bucket;
   *  project transfers cannot target internal works directories. Archived sessions still count as used. */
  async startupScratchHasSessions(workspace: string): Promise<boolean> {
    if (!isAbsolute(workspace)) return true;
    const works = await this.getWorksDir();
    const scratch = resolve(workspace);
    if (relative(works, dirname(scratch)) !== '') return true;
    try {
      if (relative(scratch, await realpath(scratch)) !== '' || !(await stat(scratch)).isDirectory()) return true;
    } catch (error) {
      if (!isMissingStartupPath(error)) throw error;
      // A pruned empty draft can be recreated by ensureWorkspace; still check for history below.
    }
    await this.awaitRecovery([scratch]);
    // SDK removed a leading separator in newer POSIX buckets; also recognize the legacy spelling.
    const folders = new Set([scratch.replace(/^[/\\]/, ''), scratch].map(s => '--' + s.replace(/[/\\:]/g, '-') + '--'));
    for (const folder of folders) {
      const bucket = join(this.sessionsDir, folder);
      try {
        if (!(await lstat(bucket)).isDirectory()) return true;
      } catch (error) {
        if (isMissingStartupPath(error)) continue;
        throw error;
      }
      for (const path of await collectJsonlFiles(bucket)) {
        if (this.blockedPaths.has(normalizePath(path))) return true;
        const session = await this.readSession(path);
        if (session?.cwd && pathsEquivalent(session.cwd, scratch)) return true;
      }
    }
    return false;
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    // 恢复闸门先跑：半迁移的会话不能出现在列表里，也不能被当成不存在。
    await this.awaitRecovery(files);
    const sessions = visibleRecords(await this.catalogRecords(files));
    const archived = await this.readArchiveRegistry();
    if (archived.length > 0) {
      // 文件已经不在的登记顺手去掉（外部删了、或删除时没经过 deleteSession）。
      const present = new Set(files.map(normalizePath));
      if (archived.some((path) => !present.has(normalizePath(path)))) {
        await this.updateArchiveRegistry((list) => list.filter((path) => present.has(normalizePath(path))));
      }
    }
    return markArchived(sessions.filter((session) => session.cwd !== null && !this.blockedPaths.has(normalizePath(session.path))), archived)
      .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
  }

  async listSessions(workspace: string): Promise<SessionInfo[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    await this.awaitRecovery(files);
    const listed = visibleRecords(await this.catalogRecords(files, workspace)).filter((session) =>
      session.cwd !== null && pathsEquivalent(session.cwd, workspace) && !this.blockedPaths.has(normalizePath(session.path)));
    return markArchived(listed, await this.readArchiveRegistry())
      .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
  }

  /**
   * 归档 / 取消归档。只记路径，会话文件原地不动；路径必须是 sessions 目录下列得出来的会话（隐藏会话不行）。
   * 按调用方给的拼法记（就是列表里的 path），比较时归一化。
   */
  async setSessionsArchived(sessionPaths: string[], archived: boolean): Promise<void> {
    if (sessionPaths.length === 0) return;
    // 归档也算结构修改：与迁移 / 删除同一把 lease，未完成事务期间拒绝。
    await this.locked(sessionPaths, async () => {
      const blocked = this.blockedFamilyReason(sessionPaths);
      if (blocked) throw new Error(`SESSION_TRANSFER_BLOCKED: ${blocked}`);
      if (archived) {
        const root = await realpath(this.sessionsDir).catch(() => { throw new Error('sessions directory unavailable'); });
        for (const sessionPath of sessionPaths) {
          const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
          if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
          if (!(await this.readSession(target))) throw new Error('SESSION_NOT_FOUND');
        }
      }
      const keys = new Set(sessionPaths.map(normalizePath));
      await this.updateArchiveRegistry((list) => {
        const rest = list.filter((path) => !keys.has(normalizePath(path)));
        return archived ? [...rest, ...dedupePaths(sessionPaths)] : rest;
      });
    });
  }

  async pruneOrphanConversations(keep: string[]): Promise<number> {
    const worksDir = await this.getWorksDir();
    // 未完成迁移的族先恢复完再决定谁是孤儿，避免把半迁移的 scratch 目录删掉。
    await this.awaitRecovery([worksDir]);
    const files = await collectJsonlFiles(this.sessionsDir);
    await this.awaitRecovery(files);
    const records = await this.catalogRecords(files);
    const used = new Set(visibleRecords(records).flatMap(session =>
      session.cwd && !this.blockedPaths.has(normalizePath(session.path)) ? [normalizePath(session.cwd)] : []));
    // 迁移历史仍引用源 scratch 的保留根：本操作不顺带清理源目录，自动 prune 也不行。
    const retained = new Set([...keep, ...this.retainedRootsFrom(records)].map(normalizePath));
    let removed = 0;
    let confirmedProtected: Set<string> | undefined;

    for (const entry of await readdir(worksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(worksDir, entry.name);
      const resolved = displayPath(await realpath(candidate));
      if (!isDirectChild(worksDir, resolved)) continue;
      const normalized = normalizePath(resolved);
      if (used.has(normalized) || retained.has(normalized) || this.drafts.has(normalized)) continue;
      // Display summaries can keep a scratch, never authorize deleting one. Only a real
      // deletion candidate needs source confirmation: any session may retain this directory.
      confirmedProtected ??= await this.confirmedScratchRoots();
      if (confirmedProtected.has(normalized)) continue;
      // 目录里只剩隐藏会话（子代理 / 系统短调用）时才会走到这里，随目录一起清掉，避免 JSONL 孤儿。
      // 先删会话再释放 registry：子级收尾写 registry 必须落在关闭之前，否则懒重建的 registry.db 会顶住 rm。
      const family = await this.workspaceFamilyPaths(resolved);
      let removedHere = false;
      try {
        removedHere = await this.locked(family, async () => {
          if (this.blockedFamilyReason(family)) return false;
          await this.deleteSessionsForWorkspace(resolved);
          await this.subagentControl.release(resolved);
          await rmWithBusyRetry(resolved);
          return true;
        }, { workspaces: [resolved] });
      } catch (error) {
        // 只有受影响目录暂拒；其他 scratch 目录继续清理。
        if (error instanceof SessionOperationLeaseBlockedError || error instanceof SessionOperationLeaseBusyError) continue;
        throw error;
      }
      if (!removedHere) continue;
      removed += 1;
    }
    return removed;
  }

  /**
   * 托管迁移事实里登记的源 scratch 保留根（去重后的原始拼法）。
   * 由所有会话记录里的 `session_project_transfer.retentionRoots` 汇总；任一引用还在就保留。
   */
  async retentionRoots(): Promise<string[]> {
    const files = await collectJsonlFiles(this.sessionsDir);
    return this.retainedRootsFrom(await this.catalogRecords(files));
  }

  private retainedRootsFrom(records: Array<SessionRecord | null>): string[] {
    const roots = new Map<string, string>();
    for (const record of records) {
      for (const root of record?.retentionRoots ?? []) roots.set(normalizePath(root), root);
    }
    // 显式登记过的保留根即使对应会话文件已经不在也保留（用户文件还在的窗口）。
    for (const [key, root] of this.retentionOverrides) roots.set(key, root);
    return [...roots.values()];
  }

  private async confirmedScratchRoots(): Promise<Set<string>> {
    const files = await collectJsonlFiles(this.sessionsDir);
    await this.awaitRecovery(files);
    const records = await Promise.all(files.map((path) => this.readSessionRecord(path)));
    const protectedRoots = new Set(this.retentionOverrides.keys());
    for (const record of records) {
      if (!record) continue;
      if (!record.hidden && record.info.cwd) protectedRoots.add(normalizePath(record.info.cwd));
      for (const root of record.retentionRoots) protectedRoots.add(normalizePath(root));
    }
    return protectedRoots;
  }

  /** 宿主 / 迁移 owner 可直接登记保留根（例如 journal 里已有、但会话尚未落盘的事务）。 */
  retainSourceScratchRoots(roots: string[]): void {
    for (const root of roots) if (root.trim()) this.retentionOverrides.set(normalizePath(root), root);
  }

  releaseSourceScratchRoots(roots: string[]): void {
    for (const root of roots) this.retentionOverrides.delete(normalizePath(root));
  }

  async deleteConversation(workspace: string): Promise<void> {
    const worksDir = await this.getWorksDir();
    const family = await this.workspaceFamilyPaths(workspace);
    await this.locked(family, async () => {
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
    }, { workspaces: [workspace] });
  }

  /**
   * 删独立工作区目录前：收口子代理、关掉 handle、释放子代理注册表。会话文件不删——W 删掉后历史仍可只读查看。
   */
  async releaseWorkspace(workspace: string): Promise<void> {
    await this.tearDownChildSessions(workspace);
    try {
      await this.closeWorkspace?.(workspace);
    } finally {
      await this.subagentControl.release(workspace);
    }
  }

  async removeProject(workspace: string): Promise<void> {
    // 只对本项目会话族加锁；目标项目 / 其他运行中的会话不停机。
    const family = await this.workspaceFamilyPaths(workspace);
    await this.locked(family, async () => {
      await this.deleteSessionsForWorkspace(workspace);
    }, { workspaces: [workspace] });
    // 项目登记不属于会话族，锁外做；ensureWorkspace 也必须能进这里，不能等恢复闸门。
    await this.forgetProject(workspace);
  }

  async setSessionDisplayName(sessionPath: string, name: string): Promise<void> {
    const trimmed = name.replace(/[\r\n]+/g, ' ').trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    // 重命名也是族结构修改：迁移执行中 / 未恢复完不能往同一文件追加。
    await this.locked([sessionPath, target], async () => {
      const blocked = this.blockedFamilyReason([sessionPath, target]);
      if (blocked) throw new Error(`SESSION_TRANSFER_BLOCKED: ${blocked}`);
      const info = await this.readSession(target);
      if (!info) throw new Error('SESSION_NOT_FOUND');
      await appendFile(target, `${JSON.stringify({ type: 'session_info', name: trimmed })}\n`);
    });
  }

  async deleteSession(workspace: string, sessionPath: string): Promise<void> {
    const sessionsRoot = join(this.agentDir, 'sessions');
    const root = await realpath(sessionsRoot).catch(() => { throw new Error('sessions directory unavailable'); });
    const target = await realpath(sessionPath).catch(() => { throw new Error('session file not found'); });
    if (!isWithin(root, target) || !target.endsWith('.jsonl')) throw new Error('session file not in sessions directory');
    const info = await this.readSession(target); if (!info || !info.cwd || !pathsEquivalent(info.cwd, workspace)) throw new Error('session does not belong to workspace');
    // 删除 / 重命名 / 归档与迁移共用同一把族 lease；未完成事务的族不能当普通会话删。
    const family = [...new Set([sessionPath, target, ...(await this.descendantPaths([target]))])];
    await this.locked(family, async () => {
      const blocked = this.blockedFamilyReason(family);
      if (blocked) throw new Error(`SESSION_TRANSFER_BLOCKED: ${blocked}`);
      // 先停父会话：它还在跑就可能再开子代理，换走时收口的子级结算也得落在文件删掉之前。
      await this.releaseSessions?.([...new Set([sessionPath, target])]);
      const children = await this.childSessionsIn(workspace);
      // 子会话 parentSession 是 SDK 落盘写法，与调用方传入 / realpath 后的拼法都可能不同，两者都作根。
      await this.removeChildSessions(workspace, descendantsLeafFirst(children, [sessionPath, target]));
      await rm(target, { force: true });
      await this.forgetArchived([sessionPath, target]);
    }, { workspaces: [workspace] });
  }

  private async deleteSessionsForWorkspace(workspace: string): Promise<void> {
    const records = await this.sessionRecordsIn(workspace);
    if (records.length > 0) await this.releaseSessions?.(records.map((record) => record.info.path));
    const kept = await this.removeChildSessions(workspace, await this.orderedChildren(records));
    for (const record of records) {
      if (!kept.has(record.info.path)) await rm(record.info.path, { force: true });
    }
    await this.forgetArchived(records.map((record) => record.info.path));
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
    await this.withProjectRegistry(async () => {
      const projects = await this.readProjectRegistry();
      if (projects.some((project) => pathsEquivalent(project, workspace))) return;
      await this.writeProjectRegistry([...projects, workspace]);
    });
  }

  private async forgetProject(workspace: string): Promise<void> {
    await this.withProjectRegistry(async () => {
      const projects = await this.readProjectRegistry();
      const next = projects.filter((project) => !pathsEquivalent(project, workspace));
      if (next.length === projects.length) return;
      await this.writeProjectRegistry(next);
    });
  }

  private withProjectRegistry<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.projectQueue.then(operation);
    this.projectQueue = next.catch(() => {});
    return next;
  }

  private async readProjectRegistry(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.projectsPath(), 'utf8')) as { projects?: unknown };
      if (!Array.isArray(parsed.projects)) return this.projectSnapshot = [];
      const projects = parsed.projects.filter((project): project is string => typeof project === 'string' && project.trim().length > 0);
      this.projectSnapshot = [...projects];
      return projects;
    } catch (error) {
      this.projectSnapshot = [];
      return [];
    }
  }

  private async writeProjectRegistry(projects: string[]): Promise<void> {
    await writeFile(this.projectsPath(), JSON.stringify({ projects }), 'utf8');
    this.projectSnapshot = [...projects];
    for (const handler of this.projectsChanged) {
      try { handler(); } catch { /* A subscriber cannot undo persisted authority. */ }
    }
  }

  private archivePath(): string {
    return join(this.agentDir, 'archived-sessions.json');
  }

  /** 读不出（不存在、坏 JSON）当作空表：归档状态丢了只是会话回到侧栏，不丢数据。 */
  private async readArchiveRegistry(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.archivePath(), 'utf8')) as { sessions?: unknown };
      if (!Array.isArray(parsed.sessions)) return [];
      return parsed.sessions.filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
    } catch {
      return [];
    }
  }

  private updateArchiveRegistry(update: (list: string[]) => string[]): Promise<void> {
    const run = this.archiveQueue.then(async () => {
      const before = await this.readArchiveRegistry();
      const after = update(before);
      if (after.length === before.length && after.every((path, index) => path === before[index])) return;
      await writeFile(this.archivePath(), JSON.stringify({ sessions: after }), 'utf8');
    });
    // 一次写失败不卡住后面的排队。
    this.archiveQueue = run.catch(() => undefined);
    return run;
  }

  private async forgetArchived(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const keys = new Set(paths.map(normalizePath));
    await this.updateArchiveRegistry((list) => list.filter((path) => !keys.has(normalizePath(path))));
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
    return this.sourceRecord(path, await stat(path)).record;
  }

  private sourceRecord(path: string, info: Stats): CachedRecord {
    const cached = this.records.get(path);
    if (cached && cached.stamp.size === info.size && cached.stamp.mtimeMs === info.mtimeMs) return cached;
    const record = this.withParseSlot(() => parseSessionRecord(path));
    const entry: CachedRecord = { stamp: info, record };
    this.records.set(path, entry);
    // 读失败不留缓存：文件可能正被删除或替换，下次重新读。
    record.catch(() => {
      if (this.records.get(path) === entry) this.records.delete(path);
    });
    return entry;
  }

  private async withParseSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeParses >= 4) await new Promise<void>(resolve => this.parseQueue.push(resolve));
    else this.activeParses++;
    try {
      return await work();
    } finally {
      const next = this.parseQueue.shift();
      if (next) next(); // hand the existing slot directly to the next reader
      else this.activeParses--;
    }
  }

  /** Directory membership comes from this scan, never from the disk cache. Project-only
   * lists read other projects' headers only on cache misses; a populated index needs stat only. */
  private async catalogRecords(files: string[], workspace?: string): Promise<Array<SessionRecord | null>> {
    await this.summaries.open();
    this.forgetRecordsExcept(files);
    this.summaries.keepOnly(new Set(files));
    const rows = await Promise.all(files.map(async path => {
      let info: Stats;
      try { info = await stat(path); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        this.summaries.drop(path);
        return null;
      }
      let entry = this.records.get(path);
      if (!entry || entry.stamp.size !== info.size || entry.stamp.mtimeMs !== info.mtimeMs) {
        const fromDisk = this.summaries.get(path, info);
        if (fromDisk !== undefined) return fromDisk;
        if (workspace && !await this.withParseSlot(() => headerMayBelongTo(path, workspace))) return null;
        entry = this.sourceRecord(path, info);
      }
      let parsed: SessionRecord | null;
      try { parsed = await entry.record; } catch (error) {
        // File deleted after stat but before its bounded read slot.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!this.records.has(path)) this.summaries.drop(path);
        return null;
      }
      if (!entry.published && this.records.get(path) === entry) {
        this.summaries.put(path, entry.stamp, parsed);
        entry.published = true;
      }
      return parsed;
    }));
    await this.summaries.flush();
    return rows;
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

function isMissingStartupPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function visibleRecords(records: Array<SessionRecord | null>): SessionInfo[] {
  return records.flatMap(record => record && !record.hidden ? [{ ...record.info }] : []);
}

function markArchived(sessions: SessionInfo[], archived: string[]): SessionInfo[] {
  if (archived.length === 0) return sessions;
  const keys = new Set(archived.map(normalizePath));
  return sessions.map((session) => (keys.has(normalizePath(session.path)) ? { ...session, archived: true } : session));
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = normalizePath(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const transfer = readSessionProjectTransfer(linesContaining(buffer, 'session_project_transfer'));
  const hidden = meta !== undefined || isSystemWorkerSessionLines(linesContaining(buffer, '\\nTask kind: '));
  const headerParent = typeof header?.parentSession === 'string' && header.parentSession.trim() ? header.parentSession : null;
  const subagent = meta ? { ...meta, parentSession: meta.parentSession ?? headerParent } : undefined;

  if (header?.type === 'session') {
    return {
      hidden,
      ...(subagent ? { subagent } : {}),
      retentionRoots: transfer.retentionRoots,
      info: {
        id: typeof header.id === 'string' ? header.id : '',
        path,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
        name,
      },
    };
  }

  // Infer session metadata from the path when no header metadata is present.
  const cwd = inferCwdFromSessionPath(path);
  if (!cwd) return null;
  const timestamp = inferTimestampFromFilename(path);
  const id = inferIdFromFilename(path);
  return { hidden, ...(subagent ? { subagent } : {}), retentionRoots: transfer.retentionRoots, info: { id, path, cwd, timestamp, name } };
}

/**
 * 托管 `session_project_transfer` 迁移事实（版本化 custom entry）。这里只读列表现有解析需要的最少字段：
 * 源 scratch 保留根。历史目录段 / 逐引用来源属于迁移 owner，不在这里重新解释。
 * 未知版本或坏行忽略：它们不能把会话变成列表或删除的另一类数据。
 */
function readSessionProjectTransfer(lines: string[]): { retentionRoots: string[] } {
  const roots = new Map<string, string>();
  let latest: Record<string, unknown> | undefined;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown } | null;
      if (entry?.type !== 'custom' || entry.customType !== 'session_project_transfer') continue;
      if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) continue;
      latest = entry.data as Record<string, unknown>;
    } catch {
      /* 坏行当作没有 */
    }
  }
  if (!latest) return { retentionRoots: [] };
  const rootsField = latest.retentionRoots ?? latest.sourceScratchRoots;
  if (Array.isArray(rootsField)) {
    for (const root of rootsField) if (typeof root === 'string' && root.trim()) roots.set(normalizePath(root), root);
  }
  return { retentionRoots: [...roots.values()] };
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

/**
 * 没有生成标题时侧栏用首条用户消息兑底。技能展开、粘贴块、命令块、图片说明先拆掉，
 * 不然侧栏显示的是 `<pi:attachment …` / `<skill name=…`。
 */
function firstUserTextFromEntry(entry: Record<string, unknown>): string | null {
  const nested = entry.message;
  const msg = (nested && typeof nested === 'object' ? nested : entry) as { role?: unknown; content?: unknown };
  const first = firstUserMessage([{ type: 'message', message: msg }]);
  return first ? fallbackSessionTitle(first.text, first.images) : null;
}

function isWithin(parent: string, candidate: string): boolean {
  const root = normalizePath(parent);
  const child = normalizePath(candidate);
  // 先确认前缀真是 parent 目录：只按长度切掉前缀时，同长的兄弟目录也会被当成在 parent 里。
  if (!child.startsWith(`${root}/`)) return false;
  const relative = child.slice(root.length + 1);
  return relative.length > 0 && !relative.split('/').includes('..');
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
