import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIsolatedWorkspaceCacheForTest,
  isolatedMarkerPath,
  isolatedWorkspaceOf,
} from '../../../extensions/_shared/isolated-workspace.js';
import { IsolatedWorkspaceService } from './isolatedWorkspaceService';

const ID = ['iso00001', 'iso00002', 'iso00003', 'iso00004'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', text);
  return git(cwd, 'rev-parse', 'HEAD');
}

let tmp: string;
let remote: string;
let seed: string;
let repo: string;
let remoteTipAtClone: string;
let localHead: string;
let remoteTipLatest: string;

function service(limit?: number) {
  let n = 0;
  return new IsolatedWorkspaceService({
    ...(limit !== undefined ? { limit } : {}),
    newId: () => ID[n++]!,
    now: () => new Date('2026-10-18T00:00:00.000Z'),
  });
}

beforeEach(() => {
  __resetIsolatedWorkspaceCacheForTest();
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'gren-iso-svc-')));
  remote = join(tmp, 'remote.git');
  seed = join(tmp, 'seed');
  repo = join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  remoteTipAtClone = commit(seed, 'a.txt', 'A');
  git(seed, 'push', '-q', remote, 'main');
  git(tmp, 'clone', '-q', remote, repo);
  // 本地领先一个提交：HEAD 与 origin/main 不同。
  localHead = commit(repo, 'b.txt', 'B');
  // 远端又前进一个提交，repo 还没 fetch。
  remoteTipLatest = commit(seed, 'c.txt', 'C');
  git(seed, 'push', '-q', remote, 'main');
}, 60_000);

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 每次 runSafeGit 在 Windows 上要起两个 git 进程，删除 / 回收的用例一条要几十次。
const GIT_HEAVY = { timeout: 60_000 };

describe('IsolatedWorkspaceService.create', GIT_HEAVY, () => {
  it('defaults to fresh: the remote default branch tip, not the local HEAD', async () => {
    const marker = await service().create({ project: repo });
    expect(marker.base).toEqual({ kind: 'fresh', ref: 'origin/main', commit: remoteTipAtClone });
    expect(marker.base.commit).not.toBe(localHead);
    expect(marker.branch).toBe('gren/iso00001');
    expect(marker.path.toLowerCase()).toBe(join(repo, '.gren', 'worktrees', 'iso00001').toLowerCase());
    // .git 在 W 里面，检出的是基准提交。
    expect(existsSync(join(marker.path, '.git', 'HEAD'))).toBe(true);
    expect(git(marker.path, 'rev-parse', 'HEAD')).toBe(remoteTipAtClone);
    expect(git(marker.path, 'symbolic-ref', '--short', 'HEAD')).toBe('gren/iso00001');
    expect(existsSync(join(marker.path, 'b.txt'))).toBe(false);
  });

  it('fetch first picks up the newer remote tip', async () => {
    const marker = await service().create({ project: repo, fetch: true });
    expect(marker.base.commit).toBe(remoteTipLatest);
  });

  it('head is the explicit exception', async () => {
    const marker = await service().create({ project: repo, base: 'head' });
    expect(marker.base).toEqual({ kind: 'head', ref: 'main', commit: localHead });
    expect(existsSync(join(marker.path, 'b.txt'))).toBe(true);
  });

  it('writes a marker beside W that isolatedWorkspaceOf recognises, and leaves the parent status clean', async () => {
    const marker = await service().create({ project: repo });
    const onDisk = JSON.parse(readFileSync(isolatedMarkerPath(repo, 'iso00001'), 'utf8'));
    expect(onDisk).toMatchObject({ version: 1, id: 'iso00001', createdBy: 'grenagent', createdAt: '2026-10-18T00:00:00.000Z' });
    expect(isolatedWorkspaceOf(marker.path)?.id).toBe('iso00001');
    expect(readFileSync(join(repo, '.gren', 'worktrees', '.gitignore'), 'utf8')).toBe('*\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('does not touch the parent: no new branch, no hardlinked objects shared with W', async () => {
    const before = git(repo, 'for-each-ref', '--format=%(refname)');
    const marker = await service().create({ project: repo });
    expect(git(repo, 'for-each-ref', '--format=%(refname)')).toBe(before);
    const objects = readdirSync(join(marker.path, '.git', 'objects'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name));
    expect(objects.length).toBeGreaterThan(0);
    for (const file of objects) expect(statSync(file).nlink, file).toBe(1);
  });

  it('refuses fresh without a remote instead of silently using HEAD', async () => {
    const lone = join(tmp, 'lone');
    git(tmp, 'init', '-q', '-b', 'main', lone);
    commit(lone, 'x.txt', 'X');
    await expect(service().create({ project: lone })).rejects.toThrow(/没有 remote/);
    expect(existsSync(join(lone, '.gren', 'worktrees', 'iso00001'))).toBe(false);
    await expect(service().create({ project: lone, base: 'head' })).resolves.toMatchObject({ base: { kind: 'head' } });
  });

  it('refuses fresh when origin/HEAD is not set', async () => {
    git(repo, 'remote', 'set-head', 'origin', '-d');
    await expect(service().create({ project: repo })).rejects.toThrow(/origin\/HEAD 未设置/);
  });

  it('refuses a subdirectory project, nesting inside W, and going over the limit', async () => {
    mkdirSync(join(repo, 'sub'));
    await expect(service().create({ project: join(repo, 'sub') })).rejects.toThrow(/仓库根目录/);

    const svc = service(1);
    const first = await svc.create({ project: repo });
    await expect(svc.create({ project: first.path })).rejects.toThrow(/不能再建/);
    await expect(svc.create({ project: repo })).rejects.toThrow(/上限（1 个）/);
  });

  it('list only reports entries with a valid marker', async () => {
    const svc = service();
    await svc.create({ project: repo });
    mkdirSync(join(repo, '.gren', 'worktrees', 'handmade'));
    writeFileSync(join(repo, '.gren', 'worktrees', 'bogus.json'), '{"version":1}');
    const listed = svc.list(repo);
    expect(listed.map((e) => e.id)).toEqual(['iso00001']);
    expect(listed[0]?.exists).toBe(true);
  });
});

describe('IsolatedWorkspaceService carry / state / remove / reclaim / probe', GIT_HEAVY, () => {
  it('carries uncommitted tracked and untracked changes in by copying; the parent keeps them', async () => {
    writeFileSync(join(repo, 'a.txt'), 'A edited\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const marker = await service().create({ project: repo, base: 'head', carryChanges: true });
    expect(marker.carried).toEqual({ tracked: true, untracked: 1 });
    expect(readFileSync(join(marker.path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('A edited\n');
    expect(readFileSync(join(marker.path, 'new.txt'), 'utf8')).toBe('untracked\n');
    // 主仓原样：改动还在、没有 stash。
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('A edited\n');
    expect(git(repo, 'stash', 'list')).toBe('');
    // 带进来的是未暂存的改动。
    expect(git(marker.path, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(marker.path, 'status', '--porcelain')).toContain('a.txt');
  });

  it('gives up and cleans up when carried changes conflict with the fresh base', async () => {
    // 本地改 c.txt——但 fresh(fetch) 的基准里 c.txt 是另一份内容，本地 HEAD 没有 c.txt。
    writeFileSync(join(repo, 'b.txt'), 'B conflicting\n');
    git(seed, 'pull', '-q', remote, 'main');
    writeFileSync(join(seed, 'b.txt'), 'B from remote\n');
    git(seed, 'add', 'b.txt');
    git(seed, 'commit', '-q', '-m', 'remote b');
    git(seed, 'push', '-q', remote, 'main');
    await expect(service().create({ project: repo, fetch: true, carryChanges: true })).rejects.toThrow(/应用不了/);
    expect(existsSync(join(repo, '.gren', 'worktrees', 'iso00001'))).toBe(false);
    expect(existsSync(isolatedMarkerPath(repo, 'iso00001'))).toBe(false);
  });

  it('state tracks dirty / ahead / synced, and remove refuses unsaved work without force', async () => {
    const svc = service();
    const marker = await svc.create({ project: repo });
    expect(await svc.state(repo, marker.id)).toMatchObject({ exists: true, dirty: false, ahead: 0, synced: true });

    writeFileSync(join(marker.path, 'w.txt'), 'w\n');
    expect(await svc.state(repo, marker.id)).toMatchObject({ dirty: true });
    git(marker.path, 'add', 'w.txt');
    git(marker.path, 'commit', '-q', '-m', 'w');
    expect(await svc.state(repo, marker.id)).toMatchObject({ dirty: false, ahead: 1, synced: false });
    await expect(svc.remove(repo, marker.id)).rejects.toThrow(/ISOLATED_UNSAVED/);
    expect(existsSync(marker.path)).toBe(true);

    await svc.syncBack(repo, marker.id);
    expect(await svc.state(repo, marker.id)).toMatchObject({ synced: true });
    await expect(svc.remove(repo, marker.id)).resolves.toMatchObject({ removed: true });
    expect(existsSync(marker.path)).toBe(false);
    expect(existsSync(isolatedMarkerPath(repo, marker.id))).toBe(false);
    // 回传的分支留在主仓。
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/gren/iso00001')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('force removes unsaved work', async () => {
    const svc = service();
    const marker = await svc.create({ project: repo });
    writeFileSync(join(marker.path, 'w.txt'), 'w\n');
    await expect(svc.remove(repo, marker.id, { force: true })).resolves.toMatchObject({ removed: true, state: { dirty: true } });
    expect(existsSync(marker.path)).toBe(false);
  });

  it('reclaim only removes idle, clean, synced, closed workspaces, and clears orphan markers', async () => {
    const svc = service();
    const idle = await svc.create({ project: repo });
    const open = await svc.create({ project: repo });
    const unsaved = await svc.create({ project: repo });
    const orphan = await svc.create({ project: repo });
    writeFileSync(join(unsaved.path, 'x.txt'), 'x\n');
    rmSync(orphan.path, { recursive: true, force: true });
    const later = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    const removed = await svc.reclaim([repo], { maxAgeDays: 30, now: later, isOpen: (p) => p.toLowerCase() === open.path.toLowerCase() });
    expect(removed.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([`${idle.id}:idle`, `${orphan.id}:orphan-marker`].sort());
    expect(svc.list(repo).map((e) => e.id).sort()).toEqual([open.id, unsaved.id].sort());
    // 还没到期的不动。
    expect(await svc.reclaim([repo], { maxAgeDays: 30 })).toEqual([]);
    expect(await svc.reclaim([repo], { maxAgeDays: 0, now: later })).toEqual([]);
  });

  it('probe tells active / missing / unmanaged / none apart', async () => {
    const svc = service();
    const marker = await svc.create({ project: repo });
    const handmade = join(repo, '.gren', 'worktrees', 'handmade');
    mkdirSync(handmade);
    const gone = join(repo, '.gren', 'worktrees', 'gone0000');
    expect(svc.probe([marker.path, handmade, gone, repo])).toEqual({
      [marker.path]: 'active', [handmade]: 'unmanaged', [gone]: 'missing', [repo]: 'none',
    });
  });

  it('reads the limit from a getter each time, and excludes the pool in .git/info/exclude', async () => {
    let limit = 1;
    let n = 0;
    const svc = new IsolatedWorkspaceService({ limit: () => limit, newId: () => ID[n++]! });
    await svc.create({ project: repo });
    await expect(svc.create({ project: repo })).rejects.toThrow(/上限（1 个）/);
    limit = 2;
    await expect(svc.create({ project: repo })).resolves.toMatchObject({ id: 'iso00002' });
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(/\r?\n/).filter((l) => l === '/.gren/')).toHaveLength(1);
  });
});

describe('IsolatedWorkspaceService.syncBack', GIT_HEAVY, () => {
  it('fast-forwards the parent branch to W and refuses a non-fast-forward', async () => {
    const svc = service();
    const marker = await svc.create({ project: repo });
    const tip1 = commit(marker.path, 'w1.txt', 'W1');
    await expect(svc.syncBack(repo, marker.id)).resolves.toEqual({ branch: 'gren/iso00001', commit: tip1 });
    expect(git(repo, 'rev-parse', 'refs/heads/gren/iso00001')).toBe(tip1);

    git(marker.path, 'reset', '-q', '--hard', 'HEAD~1');
    commit(marker.path, 'w2.txt', 'W2');
    await expect(svc.syncBack(repo, marker.id)).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'refs/heads/gren/iso00001')).toBe(tip1);
  });

  it('rejects unknown ids', async () => {
    await expect(service().syncBack(repo, 'nope0000')).rejects.toThrow(/没有这个独立工作区/);
  });
});
