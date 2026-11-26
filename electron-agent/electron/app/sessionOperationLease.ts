import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

/**
 * 会话操作 lease：让主进程（WorkspaceService）与 agent-host（PiRuntimeService / 迁移 owner）
 * 对同一会话族达成同一个跨进程排他点。锁本身只认规范物理路径，不认调用方来源。
 *
 * - 一把锁一个路径：`<agentDir>/session-operation-leases/<sha256(规范路径)>`，
 *   proper-lockfile 在它旁边建 `.lock` 目录；进程崩溃后靠 mtime 刷新失效，不手删活锁。
 * - 同进程内按 owner token 重入（引用计数），并支持 AsyncLocalStorage 作用域重入：
 *   `withSessionOperationLease` 内再取同一路径不会自己等自己，嵌套流程（发送 → 结构修改、
 *   stagedFork → sessionWorkflow）不用把 owner 透传到底。
 * - 取锁顺序按规范路径排序，多把锁失败时整批释放，避免半锁。
 * - 正常操作先拿锁再读写：迁移 owner 与普通命令不能靠「先检查后写」的窗口绕过。
 * - 持有期间被判定失锁（心跳失败 / 锁目录被外部删除 / 超过 stale）是 fail-closed：
 *   提交屏障 `assertOwned` / `assertHeld` 抛 SESSION_OPERATION_LEASE_LOST，作用域不会带着成功结果返回。
 * - 恢复闸门：`setBlockerProbe` 让未完成 journal / 已阻塞的迁移族在没有活进程时也返回 busy，
 *   而不是只信进程内 map；探针失败按 fail-closed 处理。
 */

/**
 * proper-lockfile 的本地窄类型：仓库里的 ambient d.ts 只声明了 lock/lockSync，
 * 这里只补本模块用到的 check / onCompromised / retries，不改共享声明文件。
 */
interface LockApi {
  lock(file: string, options: {
    realpath?: boolean;
    stale?: number;
    update?: number;
    retries?: number | { retries: number };
    onCompromised?: (error: Error) => void;
  }): Promise<() => Promise<void>>;
  check(file: string, options: { realpath?: boolean; stale?: number }): Promise<boolean>;
}

const locks = lockfile as unknown as LockApi;

const DEFAULT_STALE_MS = 30_000;
const MIN_STALE_MS = 2_000;
const RETRY_DELAY_MS = 50;

export interface SessionOperationLeaseBlocker {
  /** 命中的会话路径（调用方拼法或规范拼法均可）；不填表示整个请求被阻塞。 */
  path?: string;
  /** 该事务涉及但当前 header 已改变、按路径扫不出来的族；项目级清理必须一并加锁 / 拒绝。 */
  familyPaths?: string[];
  reason: string;
  operationId?: string;
}

/**
 * 未完成迁移的查询条件。只给路径不够：applying 中父 header 已经是目标、
 * 源项目按 header 扫不到它，必须同时按 journal 里记录的 source / target workspace 匹配。
 */
export interface SessionOperationLeaseQuery {
  /** 调用方拼法，内部会归一化。 */
  paths?: string[];
  /** 项目 / scratch 目录；由探针对照 journal 的 from / to workspace 及原族路径。 */
  workspaces?: string[];
}

/**
 * 未完成迁移的检测端口。由 journal / 迁移 owner 提供；本模块不认识 journal 文件格式。
 * 只要返回非空就按 blocked 处理；抛错也按 blocked 处理（fail closed）。
 */
export interface SessionOperationLeaseBlockerPort {
  blocked(query: SessionOperationLeaseQuery): Promise<readonly SessionOperationLeaseBlocker[]> | readonly SessionOperationLeaseBlocker[];
}

export interface SessionOperationLeaseOptions {
  /** 重入 token；嵌套操作复用同一个 owner 才允许共享锁。 */
  owner?: string;
  /** 等待已被别人持有的锁的毫秒数；默认 0，遇到冲突立即返回 busy（命令不能被一次迁移无限拖住）。 */
  waitMs?: number;
  /** 迁移执行 / 恢复自身需要越过 journal 闸门取锁；普通命令不许打开。 */
  allowBlocked?: boolean;
}

export interface SessionOperationLeaseHandle {
  readonly owner: string;
  /** 规范路径，已排序去重。 */
  readonly paths: readonly string[];
  /**
   * 提交屏障：确认这批路径此刻仍由本 handle 持有。锁在操作中途失效（心跳失败、锁目录被外部删除、
   * 超过 stale）时抛 SESSION_OPERATION_LEASE_LOST，调用方不能再报告成功。
   */
  assertOwned(): Promise<void>;
  /** 幂等：重复调用只释放一次；同 owner 的其他 handle 仍持有时不解除底层锁。 */
  release(): Promise<void>;
}

export interface SessionOperationLeaseCheck {
  /** 进程内持有者 + 磁盘锁 + journal 闸门都放行时为 true。 */
  available: boolean;
  paths: string[];
  /** 被别人持有（或磁盘上有活锁）的规范路径。 */
  busyPaths: string[];
  /** 仅本进程内能看到的持有者；跨进程 owner token 不落盘。 */
  holders: Array<{ path: string; owner: string }>;
  /** 未完成 journal / 迁移阻塞原因。 */
  blocked: SessionOperationLeaseBlocker[];
}

export class SessionOperationLeaseBusyError extends Error {
  readonly code = 'SESSION_OPERATION_LEASE_BUSY';
  constructor(readonly busyPaths: string[]) {
    super(`SESSION_OPERATION_LEASE_BUSY: ${busyPaths.join(', ')}`);
    this.name = 'SessionOperationLeaseBusyError';
  }
}

export class SessionOperationLeaseLostError extends Error {
  readonly code = 'SESSION_OPERATION_LEASE_LOST';
  constructor(readonly lostPaths: string[], reason?: string) {
    super(`SESSION_OPERATION_LEASE_LOST: ${lostPaths.join(', ')}${reason ? ` (${reason})` : ''}`);
    this.name = 'SessionOperationLeaseLostError';
  }
}

export class SessionOperationLeaseBlockedError extends Error {
  readonly code = 'SESSION_OPERATION_LEASE_BLOCKED';
  constructor(readonly blocked: SessionOperationLeaseBlocker[]) {
    super(`SESSION_OPERATION_LEASE_BLOCKED: ${blocked.map((reason) => reason.reason).join('; ')}`);
    this.name = 'SessionOperationLeaseBlockedError';
  }
}

interface HeldLock {
  key: string;
  owner: string;
  release: () => Promise<void>;
  refs: number;
}

interface DirectoryState {
  /** 进程内取 / 放锁排成一队，本进程的重入判断不会和真实加锁交错。 */
  queue: Promise<unknown>;
  held: Map<string, HeldLock>;
  /** 已失效的锁：只用来给原持有者 fail-closed 出原因，不阻止新的合法写者。 */
  lost: Map<string, Error>;
}

const states = new Map<string, DirectoryState>();
const coordinators = new Map<string, SessionOperationLeaseCoordinator>();

interface LeaseScope {
  directory: string;
  owner: string;
  covered: Set<string>;
}

const scopes = new AsyncLocalStorage<LeaseScope[]>();

/**
 * 规范 lease 键：绝对路径 + 尽量 realpath；分隔符统一、去掉尾部分隔符、大小写统一。
 * 两个进程必须对同一会话算出同一个键，因此不依赖调用方的路径拼法。
 * 尚未创建的日志／prepare sentinel 也解析最近已有祖先，避免目录别名让创建前后的键改变。
 */
export async function normalizeSessionOperationPath(path: string): Promise<string> {
  if (!path.trim()) throw new Error('SESSION_OPERATION_PATH_EMPTY');
  const absolute = resolve(path);
  let ancestor = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = join(await realpath(ancestor), ...missing.slice().reverse());
      return canonical.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** 规范路径的稳定摘要，用作锁目录名；同一路径在 main / agent-host 得到同一值。 */
export function sessionOperationLeaseKey(normalizedPath: string): string {
  return createHash('sha256').update(normalizedPath).digest('hex').slice(0, 40);
}

/** proper-lockfile 的锁目标（实际 `.lock` 目录在它旁边）；导出是为了跨进程探针和故障演练。 */
export function sessionOperationLeaseLockTarget(agentDir: string, leaseId: string): string {
  return join(resolve(agentDir), 'session-operation-leases', leaseId);
}

export function sessionOperationLeases(agentDir: string, options: { staleMs?: number } = {}): SessionOperationLeaseCoordinator {
  const directory = resolve(agentDir);
  let coordinator = coordinators.get(directory);
  if (!coordinator) {
    coordinator = new SessionOperationLeaseCoordinator(directory, options);
    coordinators.set(directory, coordinator);
  }
  return coordinator;
}

export class SessionOperationLeaseCoordinator {
  readonly directory: string;
  private readonly staleMs: number;
  private blockerProbe?: SessionOperationLeaseBlockerPort;

  constructor(readonly agentDir: string, options: { staleMs?: number } = {}) {
    this.directory = resolve(agentDir);
    this.staleMs = Math.max(options.staleMs ?? DEFAULT_STALE_MS, MIN_STALE_MS);
  }

  setBlockerProbe(probe: SessionOperationLeaseBlockerPort | undefined): void {
    this.blockerProbe = probe;
  }

  async paths(paths: string[]): Promise<string[]> {
    const unique = new Set<string>();
    for (const path of paths) unique.add(await normalizeSessionOperationPath(path));
    return [...unique].sort();
  }

  /** 取锁成功后 caller 必须 release；同 owner 可重入，引用计数归零才真正解锁。 */
  async acquire(paths: string[], options: SessionOperationLeaseOptions = {}): Promise<SessionOperationLeaseHandle> {
    return this.acquireNormalized(await this.paths(paths), options);
  }

  private async acquireNormalized(normalizedPaths: string[], options: SessionOperationLeaseOptions): Promise<SessionOperationLeaseHandle> {
    const owner = options.owner?.trim() || `lease-${randomUUID()}`;
    const waitMs = Math.max(options.waitMs ?? 0, 0);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const result = await this.tryAcquire(normalizedPaths, owner);
      if ('handle' in result) {
        if (options.allowBlocked) return result.handle;
        const blocked = await this.blockers(normalizedPaths);
        if (blocked.length > 0) {
          await result.handle.release();
          throw new SessionOperationLeaseBlockedError(blocked);
        }
        return result.handle;
      }
      if (Date.now() >= deadline) throw new SessionOperationLeaseBusyError(result.busyPaths);
      await delay(Math.min(RETRY_DELAY_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /**
   * 不取锁地确认可以操作；被占用或迁移未完成时抛错。供迁移预览等只读闸门使用。
   * 项目级清理要同时带上 workspaces：header 已改成目标的族按路径扫不出来。
   */
  async assertAvailable(paths: string[], options: { workspaces?: string[] } = {}): Promise<void> {
    const normalized = await this.paths(paths);
    const check = await this.checkNormalized(normalized, options.workspaces);
    if (check.busyPaths.length > 0) throw new SessionOperationLeaseBusyError(check.busyPaths);
    if (check.blocked.length > 0) throw new SessionOperationLeaseBlockedError(check.blocked);
  }

  async check(paths: string[], options: { workspaces?: string[] } = {}): Promise<SessionOperationLeaseCheck> {
    return this.checkNormalized(await this.paths(paths), options.workspaces);
  }

  /**
   * 提交屏障：这些路径必须仍由 owner（省略时任意本进程持有者）实际持有。
   * 中途失锁时抛 SESSION_OPERATION_LEASE_LOST；没有持有并不等于失锁，同样拒绝。
   */
  async assertHeld(paths: string[], owner?: string): Promise<void> {
    const normalized = await this.paths(paths);
    const state = this.state();
    const lost = normalized.filter((key) => !this.owned(key, state, owner));
    if (lost.length > 0) throw new SessionOperationLeaseLostError(lost, this.lostReason(state, lost));
  }

  private owned(key: string, state: DirectoryState, owner?: string): boolean {
    const held = state.held.get(key);
    return Boolean(held) && (owner === undefined || held!.owner === owner);
  }

  private lostReason(state: DirectoryState, keys: string[]): string | undefined {
    for (const key of keys) {
      const error = state.lost.get(key);
      if (error) return error.message;
    }
    return undefined;
  }

  private async checkNormalized(normalizedPaths: string[], workspaces?: string[]): Promise<SessionOperationLeaseCheck> {
    const state = this.state();
    const holders: Array<{ path: string; owner: string }> = [];
    const busy = new Set<string>();
    for (const key of normalizedPaths) {
      const held = state.held.get(key);
      if (held) {
        holders.push({ path: key, owner: held.owner });
        busy.add(key);
        continue;
      }
      if (await this.lockedOnDisk(key)) busy.add(key);
    }
    const blocked = await this.blockers(normalizedPaths, workspaces);
    return {
      available: busy.size === 0 && blocked.length === 0,
      paths: normalizedPaths,
      busyPaths: [...busy],
      holders,
      blocked,
    };
  }

  private async tryAcquire(normalizedPaths: string[], owner: string): Promise<{ handle: SessionOperationLeaseHandle } | { busyPaths: string[] }> {
    const state = this.state();
    return this.serialize(state, async () => {
      // 同 owner 已持有的路径直接复用；任何一个被别的 owner 持有就整批失败，避免半锁。
      for (const key of normalizedPaths) {
        const held = state.held.get(key);
        if (held && held.owner !== owner) return { busyPaths: [key] };
      }
      const acquired: Array<{ key: string; release: () => Promise<void> }> = [];
      for (const key of normalizedPaths) {
        if (state.held.has(key)) continue;
        try {
          acquired.push({ key, release: await this.lockKey(key, (error) => this.markCompromised(state, key, error)) });
        } catch (error) {
          for (const entry of acquired.reverse()) await safeUnlock(entry.release);
          if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return { busyPaths: [key] };
          throw error;
        }
      }
      const created = new Set(acquired.map((entry) => entry.key));
      for (const entry of acquired) {
        state.lost.delete(entry.key);
        state.held.set(entry.key, { key: entry.key, owner, release: entry.release, refs: 1 });
      }
      for (const key of normalizedPaths) {
        if (created.has(key)) continue;
        state.held.get(key)!.refs += 1;
      }
      return { handle: this.handle(owner, normalizedPaths, state) };
    });
  }

  private handle(owner: string, normalizedPaths: string[], state: DirectoryState): SessionOperationLeaseHandle {
    let released = false;
    return {
      owner,
      paths: normalizedPaths,
      assertOwned: async () => {
        const lost = normalizedPaths.filter((key) => !this.owned(key, state, owner));
        if (lost.length > 0) throw new SessionOperationLeaseLostError(lost, this.lostReason(state, lost));
        if (released) throw new SessionOperationLeaseLostError([...normalizedPaths], 'lease already released');
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.serialize(state, async () => {
          for (const key of normalizedPaths) {
            const held = state.held.get(key);
            if (!held || held.owner !== owner) continue;
            held.refs -= 1;
            if (held.refs > 0) continue;
            state.held.delete(key);
            await safeUnlock(held.release);
          }
        });
      },
    };
  }

  /** 锁目录名只能是摘要：规范路径本身含盘符 / 分隔符，Windows 上不能做目录名。 */
  private lockTarget(key: string): string {
    return sessionOperationLeaseLockTarget(this.directory, sessionOperationLeaseKey(key));
  }

  private async lockKey(key: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
    const leasesDir = join(this.directory, 'session-operation-leases');
    await mkdir(leasesDir, { recursive: true });
    let compromised: Error | undefined;
    const release = await locks.lock(this.lockTarget(key), {
      // 锁目标是 synthetic 路径（不是真实文件），realpath 会 ENOENT。
      realpath: false,
      stale: this.staleMs,
      update: Math.max(1_000, Math.min(5_000, Math.floor(this.staleMs / 2))),
      retries: 0,
      // 默认实现会在定时器里抛出未捕获异常；这里标记失效，让提交屏障 fail-closed。
      onCompromised: (error: Error) => {
        compromised = error;
        onCompromised(error);
      },
    });
    return async () => {
      try {
        await release();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (compromised || code === 'ERELEASED' || code === 'ENOTACQUIRED' || code === 'ENOENT') return;
        throw error;
      }
    };
  }

  /**
   * 锁在持有期间被判定失效（心跳发现 mtime 不再是我们的 / 锁目录被外部删除 / 超过 stale）：
   * 立刻摘掉进程内持有并记下原因，持有者的 assertOwned / assertHeld 会拒绝后续写入。
   */
  private markCompromised(state: DirectoryState, key: string, error: Error): void {
    if (state.held.has(key)) state.held.delete(key);
    state.lost.set(key, error);
  }

  private async lockedOnDisk(key: string): Promise<boolean> {
    try {
      return await locks.check(this.lockTarget(key), { realpath: false, stale: this.staleMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * 查询未完成迁移（prepared / applying / committed-needs-open 都算）。路径会归一化；
   * workspaces 用来覆盖 header 已改、按路径扫不出来的族。探针抛错也 fail closed。
   */
  async probe(query: SessionOperationLeaseQuery): Promise<SessionOperationLeaseBlocker[]> {
    const paths = query.paths?.length ? await this.paths(query.paths) : [];
    return this.blockers(paths, query.workspaces);
  }

  /** 被未完成迁移占住的族路径（供项目级清理把这些路径也纳入 lease）。 */
  async blockedFamilyPaths(query: SessionOperationLeaseQuery): Promise<string[]> {
    const blocked = await this.probe(query);
    return [...new Set(blocked.flatMap((entry) => entry.familyPaths ?? (entry.path ? [entry.path] : [])))];
  }

  private async blockers(normalizedPaths: string[], workspaces?: string[]): Promise<SessionOperationLeaseBlocker[]> {
    const probe = this.blockerProbe;
    if (!probe) return [];
    try {
      return [...(await probe.blocked({ paths: normalizedPaths, ...(workspaces?.length ? { workspaces } : {}) }))];
    } catch {
      // 看不懂 journal / 探针坏了都不能放行：按「无法确认迁移状态」阻塞。
      return [{ reason: '无法确认未完成迁移事务的状态，请稍后重试' }];
    }
  }

  private state(): DirectoryState {
    let state = states.get(this.directory);
    if (!state) {
      state = { queue: Promise.resolve(), held: new Map(), lost: new Map() };
      states.set(this.directory, state);
    }
    return state;
  }

  private serialize<T>(state: DirectoryState, operation: () => Promise<T>): Promise<T> {
    const next = state.queue.then(operation, operation);
    state.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * 在 lease 作用域内执行：当前异步上下文已覆盖的路径直接复用（嵌套流程不需要透传 owner），
 * 缺的路径按排序补取，退出时只释放本次补取的部分。
 * 操作成功结束前复核仍然持锁：中途失锁会抛 LOST，不会把半途而废的结果说成成功。
 */
export async function withSessionOperationLease<T>(
  agentDir: string,
  paths: string[],
  operation: () => Promise<T>,
  options: SessionOperationLeaseOptions = {},
): Promise<T> {
  const coordinator = sessionOperationLeases(agentDir);
  const existing = scopes.getStore() ?? [];
  const scope = existing.find((entry) => entry.directory === coordinator.directory);
  const contextOwner = scope?.owner;
  // 显式换了 owner 就是独立的写者，不蹭当前上下文里的锁。
  const reuseContext = options.owner === undefined || options.owner === contextOwner;
  const covered = reuseContext && scope ? new Set(scope.covered) : new Set<string>();
  const normalized = await coordinator.paths(paths);
  const missing = normalized.filter((key) => !covered.has(key));
  const owner = options.owner?.trim() || contextOwner || `lease-${randomUUID()}`;
  const handle = missing.length > 0 ? await coordinator.acquire(missing, { ...options, owner }) : undefined;
  const nextScope: LeaseScope = {
    directory: coordinator.directory,
    owner,
    covered: new Set([...covered, ...(handle?.paths ?? [])]),
  };
  const next = [...existing.filter((entry) => entry.directory !== coordinator.directory), nextScope];
  let completed = false;
  try {
    const value = await scopes.run(next, operation);
    completed = true;
    return value;
  } finally {
    try {
      // 作用域结束前复核：中途失锁的操作不能带着成功结果返回。
      if (handle && completed) await handle.assertOwned();
      // 复用了外层作用域的锁也要确认外层没有在中途失锁。
      if (!handle) await coordinator.assertHeld(normalized, owner);
    } finally {
      if (handle) await handle.release();
    }
  }
}

/** 当前异步上下文是否已经持有这些路径的 lease（用于内部 release 等不该重复加锁的入口）。 */
export async function holdsSessionOperationLease(agentDir: string, paths: string[]): Promise<boolean> {
  const coordinator = sessionOperationLeases(agentDir);
  const scope = (scopes.getStore() ?? []).find((entry) => entry.directory === coordinator.directory);
  if (!scope) return false;
  const normalized = await coordinator.paths(paths);
  return normalized.every((key) => scope.covered.has(key));
}

/** 仅供定向测试清理进程内状态；跨进程锁仍要靠 proper-lockfile 的 stale 机制。 */
export function __resetSessionOperationLeaseForTest(): void {
  states.clear();
  coordinators.clear();
}

async function safeUnlock(release: () => Promise<void>): Promise<void> {
  try {
    await release();
  } catch {
    /* 释放失败（锁已被判失效 / 已删）不应掩盖调用方自己的错误。 */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
