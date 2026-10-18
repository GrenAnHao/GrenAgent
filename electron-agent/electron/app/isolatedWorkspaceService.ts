// 独立工作区（A 轨）：宿主在 <主仓>/.gren/worktrees/<id>/ 克隆出一份，作为独立 workspace 打开。
// Note: 见 .agents/notes/implemented/architecture/2026-10-17-grenagent-hosted-worktree-dual-track.md
//
// 用 clone 不用 `git worktree`：worktree 的元数据在主仓 .git 里，沙箱根是 W 时提交会被拒，给 .git 开写又把主仓
// refs / hooks / config 交给模型。--no-hardlinks：硬链接的对象文件与主仓共用一份文件（Windows 上共用 DACL），
// 给 W 授写权会让主仓对象也可写。所有 git 都走 runSafeGit（hooks / fsmonitor 关、工作区定义的 filter 置空）。
// 身份靠和 W 平级的 marker，写闸在 extensions/safety 与 extensions/sandbox 里按 isolatedWorkspaceOf 判。

import { randomUUID } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runSafeGit } from '../../../extensions/_shared/git-safe.js';
import {
  ISOLATED_BRANCH_PREFIX,
  ISOLATED_MARKER_VERSION,
  isolatedMarkerPath,
  isolatedPathParts,
  isolatedPoolOf,
  isolatedWorkspaceOf,
  readIsolatedMarker,
  type IsolatedBaseKind,
  type IsolatedWorkspaceMarker,
} from '../../../extensions/_shared/isolated-workspace.js';

export const DEFAULT_ISOLATED_LIMIT = 15;
/** 启动时回收多少天没动过的独立工作区；0 表示不自动回收。 */
export const DEFAULT_ISOLATED_RECLAIM_DAYS = 30;
const FETCH_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** LFS 的 smudge 会去 W 的 origin（主仓路径）拉对象；和 B 轨一样跳过，指针文件照常检出。 */
const CHECKOUT_ENV = { GIT_LFS_SKIP_SMUDGE: '1' };

export interface CreateIsolatedWorkspaceInput {
  /** 主仓根目录（当前打开的项目）。 */
  project: string;
  /** 默认 fresh：远端默认分支 tip。head 是例外：接着本地 HEAD，与主线重叠时更容易冲突。 */
  base?: IsolatedBaseKind;
  /** 创建前 fetch 一次远端（只对 fresh 有意义）。 */
  fetch?: boolean;
  /**
   * 把主仓未提交的改动（已跟踪文件的 diff + 未跟踪文件）复制进 W。只读主仓、不 stash，主仓原样保留。
   * fresh 基准上按三方合并应用，冲突就放弃创建。
   */
  carryChanges?: boolean;
  signal?: AbortSignal;
}

/** 删除 / 回收前要看的状态。 */
export interface IsolatedWorkspaceState {
  id: string;
  exists: boolean;
  /** W 里有未提交的改动。 */
  dirty: boolean;
  /** W 的分支比基准多几个提交。 */
  ahead: number;
  /** 主仓已有 gren/<id> 且包含 W 的分支 tip（没有新提交也算）。 */
  synced: boolean;
  /** 最近一次在 W 里动 git 的时间（HEAD reflog / index 的 mtime），拿不到时是 createdAt。 */
  lastActivity: string;
}

export type IsolatedPathKind = 'active' | 'missing' | 'unmanaged' | 'none';

export interface IsolatedWorkspaceEntry extends IsolatedWorkspaceMarker {
  /** W 目录还在不在（marker 在、目录被手动删掉时为 false）。 */
  exists: boolean;
}

export interface IsolatedWorkspaceServiceOptions {
  /** 数量上限；传函数时每次创建现读（设置页可改）。 */
  limit?: number | (() => number | Promise<number>);
  now?: () => Date;
  newId?: () => string;
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** W 最近一次动 git 的时间：HEAD reflog / index 的 mtime，拿不到就是创建时间。 */
function lastActivityOf(marker: Pick<IsolatedWorkspaceMarker, 'path' | 'createdAt'>): number {
  let last = Date.parse(marker.createdAt) || 0;
  for (const file of [join(marker.path, '.git', 'logs', 'HEAD'), join(marker.path, '.git', 'index')]) {
    try {
      last = Math.max(last, statSync(file).mtimeMs);
    } catch {
      /* 没有就跳过 */
    }
  }
  return last;
}

async function git(cwd: string, args: string[], extra: { allowCodes?: number[]; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}) {
  return runSafeGit(cwd, args, {
    ...(extra.allowCodes ? { allowCodes: extra.allowCodes } : {}),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
}

export class IsolatedWorkspaceService {
  private readonly limitOf: () => Promise<number>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: IsolatedWorkspaceServiceOptions = {}) {
    const limit = options.limit ?? DEFAULT_ISOLATED_LIMIT;
    this.limitOf = async () => {
      const n = typeof limit === 'function' ? await limit() : limit;
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_ISOLATED_LIMIT;
    };
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID().slice(0, 8));
  }

  async create(input: CreateIsolatedWorkspaceInput): Promise<IsolatedWorkspaceMarker> {
    const signal = input.signal;
    const project = canonical(input.project);
    if (isolatedWorkspaceOf(project)) throw new Error('独立工作区里不能再建独立工作区，请回到主仓项目里创建');
    const top = await this.repositoryRoot(project, signal);
    if (!samePath(top, project)) {
      throw new Error(`独立工作区要从仓库根目录创建：当前项目 ${project} 是仓库 ${top} 的子目录`);
    }
    const limit = await this.limitOf();
    if (this.list(top).length >= limit) {
      throw new Error(`独立工作区已达上限（${limit} 个），先清理不用的再建`);
    }
    const base = await this.resolveBase(top, input.base ?? 'fresh', input.fetch === true, signal);

    const id = this.newId();
    const branch = `${ISOLATED_BRANCH_PREFIX}${id}`;
    const pool = isolatedPoolOf(top);
    mkdirSync(pool, { recursive: true });
    // 池目录自忽略，不改用户仓库根上的 .gitignore。
    try {
      writeFileSync(join(pool, '.gitignore'), '*\n', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const dest = join(pool, id);
    let carried: IsolatedWorkspaceMarker['carried'];
    try {
      mkdirSync(dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`独立工作区目录已存在：${dest}`);
      throw e;
    }

    try {
      await git(top, ['-c', 'core.longpaths=true', 'clone', '--no-hardlinks', '--no-checkout', '--quiet', '--', top, dest], {
        timeoutMs: CLONE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      // 本地克隆复制整个对象库，远端跟踪分支指向的提交也在里面；保险起见核一下。
      const has = await git(dest, ['cat-file', '-e', `${base.commit}^{commit}`], { allowCodes: [0, 1, 128], ...(signal ? { signal } : {}) });
      if (has.code !== 0) throw new Error(`克隆里找不到基准提交 ${base.commit}`);
      await git(dest, ['-c', 'core.longpaths=true', 'checkout', '--quiet', '--no-recurse-submodules', '-b', branch, base.commit], {
        env: CHECKOUT_ENV,
        ...(signal ? { signal } : {}),
      });
      if (input.carryChanges) carried = await this.carryChanges(top, dest, signal);
    } catch (e) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(`独立工作区创建失败，已清理 ${dest}：${String((e as Error)?.message ?? e)}`);
    }

    const marker: IsolatedWorkspaceMarker = {
      version: ISOLATED_MARKER_VERSION,
      id,
      path: canonical(dest),
      parentRoot: top,
      branch,
      base,
      createdAt: this.now().toISOString(),
      createdBy: 'grenagent',
      ...(carried ? { carried } : {}),
    };
    const markerPath = isolatedMarkerPath(top, id);
    const tmp = `${markerPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      renameSync(tmp, markerPath);
    } catch (e) {
      rmSync(tmp, { force: true });
      rmSync(dest, { recursive: true, force: true });
      throw new Error(`独立工作区标记写入失败，已清理 ${dest}：${String((e as Error)?.message ?? e)}`);
    }
    await this.excludePool(top, signal).catch(() => undefined);
    return marker;
  }

  /** 路径是不是独立工作区：active 托管且在；missing 形状对但目录和 marker 都不在了（已删）；unmanaged 目录在但没有 marker。 */
  probe(paths: string[]): Record<string, IsolatedPathKind> {
    const result: Record<string, IsolatedPathKind> = {};
    for (const path of paths) {
      const parts = isolatedPathParts(path);
      if (!parts) result[path] = 'none';
      else if (isolatedWorkspaceOf(path)) result[path] = 'active';
      else result[path] = isDirectory(path) ? 'unmanaged' : 'missing';
    }
    return result;
  }

  async state(project: string, id: string, signal?: AbortSignal): Promise<IsolatedWorkspaceState> {
    const top = canonical(project);
    const marker = readIsolatedMarker(top, id);
    if (!marker) throw new Error(`没有这个独立工作区：${id}`);
    const sig = signal ? { signal } : {};
    if (!isDirectory(marker.path)) {
      return { id, exists: false, dirty: false, ahead: 0, synced: false, lastActivity: marker.createdAt };
    }
    const w = marker.path;
    const dirty = (await git(w, ['status', '--porcelain', '--untracked-files=normal'], sig)).stdout.trim() !== '';
    const ref = `refs/heads/${marker.branch}`;
    const tipResult = await git(w, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowCodes: [0, 1, 128], ...sig });
    const tip = tipResult.code === 0 ? tipResult.stdout.trim() : '';
    let ahead = 0;
    if (tip) {
      const counted = await git(w, ['rev-list', '--count', `${marker.base.commit}..${tip}`], { allowCodes: [0, 128], ...sig });
      ahead = counted.code === 0 ? Number(counted.stdout.trim()) || 0 : 0;
    }
    let synced = ahead === 0 && tip !== '';
    if (!synced && tip) {
      const parentTip = await git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowCodes: [0, 1, 128], ...sig });
      if (parentTip.code === 0) {
        const has = await git(top, ['cat-file', '-e', `${tip}^{commit}`], { allowCodes: [0, 1, 128], ...sig });
        if (has.code === 0) {
          const contained = await git(top, ['merge-base', '--is-ancestor', tip, parentTip.stdout.trim()], { allowCodes: [0, 1, 128], ...sig });
          synced = contained.code === 0;
        }
      }
    }
    return { id, exists: true, dirty, ahead, synced, lastActivity: new Date(lastActivityOf(marker)).toISOString() };
  }

  /**
   * 删除：先删 marker（写闸随之解除前目录已不再被当作独立工作区），再删 W。主仓的 gren/<id> 分支保留。
   * W 有未提交改动或分支没回传时，没有 force 就拒绝。调用方负责先确认 W 没有会话在跑、并关掉它的 handle。
   */
  async remove(project: string, id: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<{ removed: true; state: IsolatedWorkspaceState }> {
    const top = canonical(project);
    const marker = readIsolatedMarker(top, id);
    if (!marker) throw new Error(`没有这个独立工作区：${id}`);
    const state = await this.state(top, id, options.signal);
    if (state.exists && !options.force && (state.dirty || !state.synced)) {
      const why = [state.dirty ? '有未提交的改动' : '', !state.synced ? `分支 ${marker.branch} 还没回传到主仓` : ''].filter(Boolean).join('，');
      throw new Error(`ISOLATED_UNSAVED: 独立工作区 ${id} ${why}；确认要丢掉这些工作再删除`);
    }
    rmSync(isolatedMarkerPath(top, id), { force: true });
    rmSync(marker.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { removed: true, state };
  }

  /**
   * 启动时回收：超过 maxAgeDays 没动过、没有未提交改动、已回传（或没有新提交）、当前没打开的才删；
   * W 目录已经被手动删掉的，只清掉留下的 marker。返回删掉的 id。
   */
  async reclaim(
    projects: string[],
    options: { maxAgeDays: number; isOpen?: (path: string) => boolean; now?: Date },
  ): Promise<Array<{ project: string; id: string; reason: 'idle' | 'orphan-marker' }>> {
    if (!(options.maxAgeDays > 0)) return [];
    const now = (options.now ?? this.now()).getTime();
    const cutoff = options.maxAgeDays * 24 * 3600 * 1000;
    const removed: Array<{ project: string; id: string; reason: 'idle' | 'orphan-marker' }> = [];
    for (const project of projects) {
      let entries: IsolatedWorkspaceEntry[];
      try {
        entries = this.list(project);
      } catch {
        continue;
      }
      for (const entry of entries) {
        try {
          if (!entry.exists) {
            rmSync(isolatedMarkerPath(entry.parentRoot, entry.id), { force: true });
            removed.push({ project, id: entry.id, reason: 'orphan-marker' });
            continue;
          }
          if (options.isOpen?.(entry.path)) continue;
          // 先用文件时间粗筛：没到期的不跑 git（启动时要等它跑完才开窗口）。
          if (now - lastActivityOf(entry) < cutoff) continue;
          const state = await this.state(entry.parentRoot, entry.id);
          if (state.dirty || !state.synced) continue;
          if (now - Date.parse(state.lastActivity) < cutoff) continue;
          await this.remove(entry.parentRoot, entry.id);
          removed.push({ project, id: entry.id, reason: 'idle' });
        } catch {
          /* 一个坏了不影响别的 */
        }
      }
    }
    return removed;
  }

  /** 把主仓未提交的改动复制进 dest。只读主仓。 */
  private async carryChanges(top: string, dest: string, signal?: AbortSignal): Promise<{ tracked: boolean; untracked: number }> {
    const sig = signal ? { signal } : {};
    const diff = (await git(top, ['diff', 'HEAD', '--binary', '--no-textconv', '--no-ext-diff', '--no-color'], sig)).stdout;
    let tracked = false;
    if (diff.trim()) {
      const patch = join(tmpdir(), `gren-carry-${randomUUID()}.patch`);
      writeFileSync(patch, diff);
      try {
        await git(dest, ['apply', '--3way', '--whitespace=nowarn', patch], sig);
        // apply --3way 会把结果放进暂存区；退回成未暂存，和主仓「未提交」的样子一致。
        await git(dest, ['reset', '--quiet'], sig);
      } catch (e) {
        throw new Error(`主仓的未提交改动在基准上应用不了（多半是和基准冲突），可以改选「基于当前 HEAD」：${String((e as Error)?.message ?? e)}`);
      } finally {
        rmSync(patch, { force: true });
      }
      tracked = true;
    }
    const listed = (await git(top, ['ls-files', '--others', '--exclude-standard', '-z'], sig)).stdout.split('\0').filter(Boolean);
    let untracked = 0;
    for (const rel of listed) {
      if (/^\.gren[\\/]/.test(rel)) continue;
      const from = join(top, rel);
      try {
        if (!lstatSync(from).isFile()) continue;
      } catch {
        continue;
      }
      const to = join(dest, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      untracked += 1;
    }
    return { tracked, untracked };
  }

  /** 主仓 .git/info/exclude 加一条 /.gren/：代码索引与只认根忽略规则的工具也跳过池目录。只追加，不改已有行。 */
  private async excludePool(top: string, signal?: AbortSignal): Promise<void> {
    const common = (await git(top, ['rev-parse', '--git-common-dir'], signal ? { signal } : {})).stdout.trim();
    const file = join(resolve(top, common), 'info', 'exclude');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => line.trim() === '/.gren/')) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}/.gren/\n`);
  }

  /** 主仓下所有托管的独立工作区（只认合格的 marker）。 */
  list(project: string): IsolatedWorkspaceEntry[] {
    const top = canonical(project);
    const pool = isolatedPoolOf(top);
    let names: string[];
    try {
      names = readdirSync(pool);
    } catch {
      return [];
    }
    const entries: IsolatedWorkspaceEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const marker = readIsolatedMarker(top, name.slice(0, -'.json'.length));
      if (marker) entries.push({ ...marker, exists: isDirectory(marker.path) });
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 回传：把 W 的分支 fetch 到主仓同名分支。只快进，不加 +；主仓那边分支被检出或已经分叉时 git 报错，原样抛出。
   */
  async syncBack(project: string, id: string, signal?: AbortSignal): Promise<{ branch: string; commit: string }> {
    const top = canonical(project);
    const marker = readIsolatedMarker(top, id);
    if (!marker) throw new Error(`没有这个独立工作区：${id}`);
    if (!isDirectory(marker.path)) throw new Error(`独立工作区目录已不在：${marker.path}`);
    const ref = `refs/heads/${marker.branch}`;
    const commit = (await git(marker.path, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal ? { signal } : {})).stdout.trim();
    await git(top, ['fetch', '--no-tags', '--quiet', '--', marker.path, `${ref}:${ref}`], {
      timeoutMs: FETCH_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return { branch: marker.branch, commit };
  }

  private async repositoryRoot(project: string, signal?: AbortSignal): Promise<string> {
    const r = await git(project, ['rev-parse', '--show-toplevel'], { allowCodes: [0, 128], ...(signal ? { signal } : {}) });
    if (r.code !== 0 || !r.stdout.trim()) throw new Error(`不是 git 仓库：${project}`);
    return canonical(r.stdout.trim());
  }

  private async resolveBase(
    top: string,
    kind: IsolatedBaseKind,
    fetch: boolean,
    signal?: AbortSignal,
  ): Promise<IsolatedWorkspaceMarker['base']> {
    const sig = signal ? { signal } : {};
    if (kind === 'head') {
      const commit = (await git(top, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], sig)).stdout.trim();
      const named = await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowCodes: [0, 1], ...sig });
      return { kind, ref: named.code === 0 ? named.stdout.trim() : 'HEAD', commit };
    }

    const remotes = (await git(top, ['remote'], sig)).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : undefined;
    if (!remote) {
      throw new Error(
        remotes.length === 0
          ? '仓库没有 remote，取不到远端默认分支；可以改选「基于当前 HEAD」'
          : `仓库有多个 remote 且没有 origin（${remotes.join(', ')}），不知道该取哪个默认分支；可以改选「基于当前 HEAD」`,
      );
    }
    if (fetch) {
      try {
        await git(top, ['fetch', '--no-tags', '--quiet', remote], { timeoutMs: FETCH_TIMEOUT_MS, ...sig });
      } catch (e) {
        throw new Error(`fetch ${remote} 失败，没有创建独立工作区：${String((e as Error)?.message ?? e)}`);
      }
    }
    const head = await git(top, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { allowCodes: [0, 1, 128], ...sig });
    const target = head.stdout.trim();
    if (head.code !== 0 || !target.startsWith(`refs/remotes/${remote}/`)) {
      throw new Error(
        `不知道 ${remote} 的默认分支（${remote}/HEAD 未设置）。运行 git remote set-head ${remote} --auto 后重试，或改选「基于当前 HEAD」`,
      );
    }
    const commit = (await git(top, ['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`], sig)).stdout.trim();
    return { kind: 'fresh', ref: target.slice('refs/remotes/'.length), commit };
  }
}
