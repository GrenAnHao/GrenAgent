import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetSubagentControlPlaneForTest } from '../../../extensions/multi-agent/controlPlane.js';
import { __resetActivationsForTest } from '../../../extensions/multi-agent/activation.js';
import { __resetParentHostsForTest } from '../../../extensions/multi-agent/parent-host.js';
import { __resetSessionOperationLeaseForTest, sessionOperationLeases } from './sessionOperationLease';
import { WorkspaceService } from './workspaceService';

/**
 * 定向迁移用例：只覆盖 Task 3.4（迁移后缓存失效、源 scratch 保留根、整树删除归属）
 * 与 lease / 恢复闸门在 WorkspaceService 入口的接线。不跑旧用例。
 */
const directories: string[] = [];

afterEach(async () => {
  __resetSubagentControlPlaneForTest();
  __resetActivationsForTest();
  __resetParentHostsForTest();
  __resetSessionOperationLeaseForTest();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gren-workspace-transfer-'));
  directories.push(root);
  const agentDir = join(root, 'agent');
  const sessionsDir = join(agentDir, 'sessions', 'hash');
  await mkdir(sessionsDir, { recursive: true });
  const source = join(root, 'source-project');
  const target = join(root, 'target-project');
  await mkdir(source);
  await mkdir(target);
  return { root, agentDir, sessionsDir, source, target, service: new WorkspaceService(agentDir) };
}

const header = (id: string, cwd: string, timestamp = '2026-11-17T00:00:00Z') =>
  JSON.stringify({ type: 'session', id, cwd, timestamp });

const childHeader = (id: string, cwd: string, parentSession: string) => [
  JSON.stringify({ type: 'session', id, cwd, parentSession }),
  JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: id, parentSession, mode: 'continuable' } }),
];

/** 迁移后写入的托管事实：只声明宿主需要的源 scratch 保留根。 */
const transferMeta = (from: string, to: string, retentionRoots: string[]) => JSON.stringify({
  type: 'custom',
  customType: 'session_project_transfer',
  data: { version: 1, operationId: 'op-1', fromWorkspace: from, toWorkspace: to, retentionRoots },
});

describe('WorkspaceService session project transfer', () => {
  it('requires an explicit cache invalidation for a same-size, same-mtime header replacement', async () => {
    const { service, sessionsDir, source, target } = await setup();
    const path = join(sessionsDir, 'moved.jsonl');
    const pinned = new Date('2026-11-17T00:00:00Z');
    // 源 / 目标目录名等长：header 原子替换后文件大小不变，mtime 也被还原成原值。
    await writeFile(path, `${header('moved', source)}\n`);
    await utimes(path, pinned, pinned);
    await expect(service.listSessions(source)).resolves.toMatchObject([{ id: 'moved' }]);

    await writeFile(path, `${header('moved', target)}\n`);
    await utimes(path, pinned, pinned);
    expect((await stat(path)).mtimeMs).toBe(pinned.getTime());
    // 缓存按 size/mtime 判定，迁移不能靠时间戳推断出「已经变了」。
    await expect(service.listSessions(target)).resolves.toEqual([]);

    service.invalidateSessionRecords([path]);

    await expect(service.listSessions(target)).resolves.toMatchObject([{ id: 'moved', cwd: target }]);
    await expect(service.listSessions(source)).resolves.toEqual([]);
  });

  it('deleting the source project leaves the moved main session and its migrated children intact', async () => {
    const { service, sessionsDir, source, target } = await setup();
    const parent = join(sessionsDir, 'parent.jsonl');
    const child = join(sessionsDir, 'child.jsonl');
    const grandchild = join(sessionsDir, 'grandchild.jsonl');
    const leftover = join(sessionsDir, 'leftover.jsonl');
    // 迁移后 header 都指向目标项目，但物理路径仍在源项目的编码目录里。
    await writeFile(parent, `${header('parent', target)}\n`);
    await writeFile(child, `${childHeader('sa-child', target, parent).join('\n')}\n`);
    await writeFile(grandchild, `${childHeader('sa-grandchild', target, child).join('\n')}\n`);
    await writeFile(leftover, `${header('leftover', source)}\n`);

    await service.removeProject(source);

    await expect(readFile(parent, 'utf8')).resolves.toContain('"parent"');
    await expect(readFile(child, 'utf8')).resolves.toContain('sa-child');
    await expect(readFile(grandchild, 'utf8')).resolves.toContain('sa-grandchild');
    await expect(readFile(leftover, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.listSessions(target)).resolves.toMatchObject([{ id: 'parent' }]);
  });

  it('deleting the target parent still cascades to migrated children', async () => {
    const { service, sessionsDir, target } = await setup();
    const parent = join(sessionsDir, 'parent.jsonl');
    const child = join(sessionsDir, 'child.jsonl');
    const sibling = join(sessionsDir, 'sibling.jsonl');
    await writeFile(parent, `${header('parent', target)}\n`);
    await writeFile(child, `${childHeader('sa-child', target, parent).join('\n')}\n`);
    await writeFile(sibling, `${header('sibling', target)}\n`);

    await service.deleteSession(target, parent);

    await expect(readFile(parent, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(sibling, 'utf8')).resolves.toContain('sibling');
  });

  it('keeps a source scratch directory that transfer metadata still references', async () => {
    const { service, agentDir, sessionsDir } = await setup();
    const worksDir = await service.getWorksDir();
    const scratch = join(worksDir, 'scratch-source');
    await mkdir(scratch);
    const file = join(scratch, 'deliverable.md');
    await writeFile(file, '用户文件');
    // 会话已移到项目；源 scratch 只剩这份迁移历史引用。
    const path = join(sessionsDir, 'moved.jsonl');
    await writeFile(path, [
      header('moved', join(agentDir, 'project')),
      transferMeta(scratch, join(agentDir, 'project'), [scratch]),
    ].join('\n'));
    service.invalidateSessionRecords([path]);

    await expect(service.retentionRoots()).resolves.toEqual([scratch]);
    await expect(service.pruneOrphanConversations([])).resolves.toBe(0);
    await expect(readFile(file, 'utf8')).resolves.toBe('用户文件');
  });

  it('releases the source scratch retention root once the transfer no longer references it', async () => {
    const { service, agentDir, sessionsDir } = await setup();
    const worksDir = await service.getWorksDir();
    const scratch = join(worksDir, 'scratch-released');
    await mkdir(scratch);
    const path = join(sessionsDir, 'moved.jsonl');
    await writeFile(path, `${header('moved', join(agentDir, 'project'))}\n`);

    service.retainSourceScratchRoots([scratch]);
    await expect(service.pruneOrphanConversations([])).resolves.toBe(0);

    service.releaseSourceScratchRoots([scratch]);
    service.invalidateSessionRecords([path]);
    await expect(service.pruneOrphanConversations([])).resolves.toBe(1);
    await expect(realpath(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for the recovery gate before listing and never exposes a half-migrated family', async () => {
    const { service, sessionsDir, source, target } = await setup();
    const path = join(sessionsDir, 'moving.jsonl');
    await writeFile(path, `${header('moving', target)}\n`);
    let gateCalls = 0;
    let releaseGate: () => void = () => {};
    // 第一轮挂住，放开后正常放行（模拟恢复完成）。
    let held = true;
    service.setRecoveryGate(async () => {
      gateCalls += 1;
      if (!held) return;
      await new Promise<void>((resolveGate) => { releaseGate = () => { held = false; resolveGate(); }; });
    });

    const listing = service.listAllSessions();
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(gateCalls).toBeGreaterThan(0);
    // 闸门没放开之前不给结果：不会先列出半迁移状态。
    releaseGate();
    await expect(listing).resolves.toMatchObject([{ id: 'moving', cwd: target }]);
    await expect(service.listSessions(source)).resolves.toEqual([]);
  });

  it('reports a committed-needs-open family as blocked instead of listing or deleting it', async () => {
    const { service, sessionsDir, target } = await setup();
    const path = join(sessionsDir, 'needs-open.jsonl');
    await writeFile(path, `${header('needs-open', target)}\n`);

    service.markSessionPathsBlocked([{ path, reason: '已移动，打开失败' }]);

    await expect(service.listAllSessions()).resolves.toEqual([]);
    await expect(service.listSessions(target)).resolves.toEqual([]);
    await expect(service.deleteSession(target, path)).rejects.toThrow('SESSION_TRANSFER_BLOCKED');
    await expect(readFile(path, 'utf8')).resolves.toContain('needs-open');

    service.clearSessionPathsBlocked([path]);
    await expect(service.listSessions(target)).resolves.toMatchObject([{ id: 'needs-open' }]);
  });

  it('does not let ensureWorkspace wait on the recovery gate (committed recovery resolves the target through it)', async () => {
    const { service, target } = await setup();
    const gate = vi.fn(async () => new Promise<void>(() => {}));
    service.setRecoveryGate(gate);

    // 永久挂起的闸门：ensureWorkspace 必须在它之外完成，否则 recover → resolveWorkspace 会死锁。
    await expect(service.ensureWorkspace(target)).resolves.toBe(await realpath(target));
    expect(gate).not.toHaveBeenCalled();
    await expect(service.listProjects()).resolves.toEqual([await realpath(target)]);
  });

  it('serializes delete and rename against a live lease without stopping other projects', async () => {
    const { service, agentDir, sessionsDir, source, target } = await setup();
    const moving = join(sessionsDir, 'moving.jsonl');
    const other = join(sessionsDir, 'other.jsonl');
    await writeFile(moving, `${header('moving', source)}\n`);
    await writeFile(other, `${header('other', target)}\n`);
    service.invalidateSessionRecords([moving, other]);

    const lease = await sessionOperationLeases(agentDir).acquire([moving], { owner: 'transfer-op' });
    try {
      await expect(service.deleteSession(source, moving)).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_BUSY' });
      await expect(service.setSessionDisplayName(moving, '改名')).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_BUSY' });
      await expect(service.setSessionsArchived([moving], true)).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_BUSY' });
      // 目标项目其他会话不受影响。
      await expect(service.setSessionDisplayName(other, '其他')).resolves.toBeUndefined();
    } finally {
      await lease.release();
    }
    await expect(service.deleteSession(source, moving)).resolves.toBeUndefined();
  });

  it('blocks project cleanup by journal workspace even when the moved header already points at the target', async () => {
    const { service, agentDir, sessionsDir, source, target } = await setup();
    const moving = join(sessionsDir, 'moving.jsonl');
    await writeFile(moving, `${header('moving', target)}\n`);
    service.invalidateSessionRecords([moving]);
    // applying 阶段：源项目按 header 已经扫不到这个族，只有 journal 知道它属于源。
    sessionOperationLeases(agentDir).setBlockerProbe({
      blocked: (query) => (query.workspaces ?? []).some((workspace) => workspace === source)
        ? [{ reason: '源项目仍有未完成迁移', operationId: 'op-apply', familyPaths: [moving] }]
        : [],
    });

    await expect(service.removeProject(source)).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_BLOCKED' });
    await expect(readFile(moving, 'utf8')).resolves.toContain('moving');
    // 无关项目照常清理。
    await expect(service.removeProject(target)).resolves.toBeUndefined();
  });

  it('keeps pruning other scratch directories when one family is blocked by an unfinished transfer', async () => {
    const { service, agentDir } = await setup();
    const worksDir = await service.getWorksDir();
    const blockedDir = join(worksDir, 'blocked');
    const orphan = join(worksDir, 'orphan');
    await mkdir(blockedDir);
    await mkdir(orphan);
    service.retainSourceScratchRoots([blockedDir]);
    sessionOperationLeases(agentDir).setBlockerProbe({
      blocked: (query) => (query.workspaces ?? []).some((workspace) => workspace === blockedDir)
        ? [{ reason: '仍有未完成迁移', operationId: 'op-apply' }]
        : [],
    });

    await expect(service.pruneOrphanConversations([])).resolves.toBe(1);
    await expect(realpath(blockedDir)).resolves.toBeTruthy();
    await expect(realpath(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never deletes generated files or migrated history when pruning a scratch source', async () => {
    const { service, agentDir, sessionsDir } = await setup();
    const worksDir = await service.getWorksDir();
    const scratch = join(worksDir, 'scratch-generated');
    await mkdir(scratch);
    const generated = join(scratch, 'report.html');
    await writeFile(generated, '<h1>交付</h1>');
    const session = join(sessionsDir, 'moved.jsonl');
    await writeFile(session, [header('moved', join(agentDir, 'project')), transferMeta(scratch, join(agentDir, 'project'), [scratch])].join('\n'));

    await service.pruneOrphanConversations([]);

    await expect(readFile(generated, 'utf8')).resolves.toContain('交付');
    await expect(readFile(session, 'utf8')).resolves.toContain('"moved"');
  });
});
