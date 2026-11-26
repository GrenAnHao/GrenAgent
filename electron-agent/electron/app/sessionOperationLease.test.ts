import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import lockfile from 'proper-lockfile';
import {
  SessionOperationLeaseBlockedError,
  SessionOperationLeaseBusyError,
  SessionOperationLeaseLostError,
  __resetSessionOperationLeaseForTest,
  holdsSessionOperationLease,
  normalizeSessionOperationPath,
  sessionOperationLeaseKey,
  sessionOperationLeaseLockTarget,
  sessionOperationLeases,
  withSessionOperationLease,
} from './sessionOperationLease';

const roots: string[] = [];

afterEach(async () => {
  __resetSessionOperationLeaseForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gren-session-lease-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  const session = join(root, 'session.jsonl');
  const child = join(root, 'child.jsonl');
  return { root, agentDir, session, child };
}

describe('session operation lease', () => {
  it('keeps a missing path under a directory alias on the same lease key after creation', async () => {
    const { root, agentDir } = await setup();
    const real = join(root, 'physical');
    const alias = join(root, 'alias');
    await mkdir(real);
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const pending = join(alias, 'new-family', 'prepare');
    const physical = join(real, 'new-family', 'prepare');
    const before = await normalizeSessionOperationPath(pending);
    expect(before).toBe(await normalizeSessionOperationPath(physical));
    const lease = await sessionOperationLeases(agentDir).acquire([pending]);
    try {
      await mkdir(join(real, 'new-family'));
      await writeFile(physical, 'created');
      expect(await normalizeSessionOperationPath(pending)).toBe(before);
      await expect(lease.assertOwned()).resolves.toBeUndefined();
      await expect(sessionOperationLeases(agentDir).acquire([physical])).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);
    } finally { await lease.release(); }
  });
  it('shares one exclusive point across processes through the canonical path', async () => {
    const { agentDir, session } = await setup();
    // 另一个进程（这里用裸 proper-lockfile 模拟）先持有同一把锁。
    const key = sessionOperationLeaseKey(await normalizeSessionOperationPath(session));
    const target = sessionOperationLeaseLockTarget(agentDir, key);
    await mkdir(join(agentDir, 'session-operation-leases'), { recursive: true });
    const foreign = await lockfile.lock(target, { realpath: false });

    // 拼法不同（大小写 / 分隔符 / 相对形态）也算同一个键，不能借拼写绕过。
    const spelled = session.replace(/\\/g, '/').toUpperCase();
    const check = await sessionOperationLeases(agentDir).check([spelled]);
    expect(check.available).toBe(false);
    expect(check.busyPaths).toEqual([await normalizeSessionOperationPath(session)]);
    await expect(sessionOperationLeases(agentDir).acquire([spelled])).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);

    await foreign();
    const handle = await sessionOperationLeases(agentDir).acquire([session]);
    await handle.release();
  });

  it('reclaims a lock left behind by a crashed process only after it is stale', async () => {
    const { agentDir, session } = await setup();
    const coordinator = sessionOperationLeases(agentDir, { staleMs: 2_000 });
    const key = sessionOperationLeaseKey(await normalizeSessionOperationPath(session));
    const target = sessionOperationLeaseLockTarget(agentDir, key);
    await mkdir(`${target}.lock`, { recursive: true });
    // 崩溃留下的活锁目录：还在 stale 窗口内不能抢。
    await utimes(`${target}.lock`, new Date(), new Date());
    await expect(coordinator.acquire([session])).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);
    // 过了 stale 窗口才允许回收，不需要调用方手删别人的锁。
    const old = new Date(Date.now() - 60_000);
    await utimes(`${target}.lock`, old, old);
    const handle = await coordinator.acquire([session]);
    await handle.release();
  });

  it('allows owner reentrancy in-process and only unlocks when the last reference is released', async () => {
    const { agentDir, session, child } = await setup();
    const coordinator = sessionOperationLeases(agentDir);
    const outer = await coordinator.acquire([session], { owner: 'transfer-1' });
    const inner = await coordinator.acquire([session, child], { owner: 'transfer-1' });
    expect(inner.paths).toEqual(await coordinator.paths([session, child]));

    await outer.release();
    // 外层先放：内层仍持有这两条路径。
    expect((await coordinator.check([session])).available).toBe(false);
    await expect(coordinator.acquire([session], { owner: 'other' })).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);

    await inner.release();
    await inner.release();
    expect((await coordinator.check([session, child])).available).toBe(true);
  });

  it('does not grant a different owner access just because this process holds it', async () => {
    const { agentDir, session } = await setup();
    const coordinator = sessionOperationLeases(agentDir);
    const held = await coordinator.acquire([session], { owner: 'transfer-1' });
    await expect(coordinator.acquire([session], { owner: 'delete' })).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);
    await held.release();
    const next = await coordinator.acquire([session], { owner: 'delete' });
    await next.release();
  });

  it('takes multiple paths in canonical order and releases the whole batch on a conflict', async () => {
    const { agentDir, session, child } = await setup();
    const coordinator = sessionOperationLeases(agentDir);
    const batch = await coordinator.acquire([session, child], { waitMs: 0 });
    expect(batch.paths).toEqual(await coordinator.paths([child, session]));

    // 另一个 owner 只要碰到批次里的一条就整批失败，不会留下半锁。
    await expect(coordinator.acquire([session, child], { owner: 'someone' })).rejects.toBeInstanceOf(SessionOperationLeaseBusyError);
    const order = [...(await coordinator.paths([session, child]))].sort();
    const before = await coordinator.check([session, child]);
    expect(before.busyPaths.sort()).toEqual(order.slice());
    await batch.release();
  });

  it('reuses the lease of the current async scope for nested flows', async () => {
    const { agentDir, session, child } = await setup();
    await withSessionOperationLease(agentDir, [session], async () => {
      // 发送流程里再进结构修改：同上下文直接复用，不会等自己。
      await withSessionOperationLease(agentDir, [session], async () => {
        expect(await holdsSessionOperationLease(agentDir, [session])).toBe(true);
        // 子路径按需补取，退出内层只释放补取的部分。
        await withSessionOperationLease(agentDir, [child], async () => {
          expect(await holdsSessionOperationLease(agentDir, [child])).toBe(true);
        });
        expect(await holdsSessionOperationLease(agentDir, [child])).toBe(false);
        const other = await sessionOperationLeases(agentDir).acquire([child], { owner: 'other' });
        await other.release();
      });
      expect(await holdsSessionOperationLease(agentDir, [session])).toBe(true);
    });
    expect(await holdsSessionOperationLease(agentDir, [session])).toBe(false);
    expect((await sessionOperationLeases(agentDir).check([session, child])).available).toBe(true);
    expect((await sessionOperationLeases(agentDir).check([child])).available).toBe(true);
  });

  it('releases the lease when the scoped operation throws, including nested reentrancy', async () => {
    const { agentDir, session } = await setup();
    await expect(withSessionOperationLease(agentDir, [session], async () => {
      await withSessionOperationLease(agentDir, [session], async () => { throw new Error('boom'); });
    })).rejects.toThrow('boom');
    expect((await sessionOperationLeases(agentDir).check([session])).available).toBe(true);
  });

  it('keeps the scoped lease out of an explicitly different owner', async () => {
    const { agentDir, session } = await setup();
    await withSessionOperationLease(agentDir, [session], async () => {
      await expect(withSessionOperationLease(agentDir, [session], async () => undefined, { owner: 'other' }))
        .rejects.toBeInstanceOf(SessionOperationLeaseBusyError);
    });
  });

  it('reports an unfinished transfer journal as blocked even without a live writer', async () => {
    const { agentDir, session } = await setup();
    const coordinator = sessionOperationLeases(agentDir);
    coordinator.setBlockerProbe({
      blocked: async (query) => (query.paths ?? []).includes(await normalizeSessionOperationPath(session))
        ? [{ path: session, reason: '会话族有未完成迁移', operationId: 'op-1' }]
        : [],
    });

    await expect(coordinator.acquire([session])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([session])).rejects.toThrow('未完成迁移');
    const check = await coordinator.check([session]);
    expect(check).toMatchObject({ available: false, blocked: [{ operationId: 'op-1' }] });

    // 迁移 / 恢复自己必须能越过闸门取锁，否则永远无法收尾。
    const recovery = await coordinator.acquire([session], { allowBlocked: true, owner: 'recovery' });
    await recovery.release();
  });

  it('blocks project cleanup by journal workspace even after the moved header no longer matches the source', async () => {
    const { agentDir, session, child } = await setup();
    const sourceProject = join(agentDir, 'source-project');
    const targetProject = join(agentDir, 'target-project');
    const coordinator = sessionOperationLeases(agentDir);
    // applying 阶段：父 header 已经是目标，按源项目根本扫不到这个族。
    coordinator.setBlockerProbe({
      blocked: (query) => (query.workspaces ?? []).some((workspace) => workspace.toLowerCase() === sourceProject.toLowerCase())
        ? [{ reason: '源项目仍有未完成迁移', operationId: 'op-apply', familyPaths: [session, child] }]
        : [],
    });

    await expect(coordinator.assertAvailable([], { workspaces: [sourceProject] })).rejects.toThrow('未完成迁移');
    expect(await coordinator.blockedFamilyPaths({ workspaces: [sourceProject] })).toEqual([session, child]);
    // 别的项目不受影响。
    await expect(coordinator.assertAvailable([], { workspaces: [targetProject] })).resolves.toBeUndefined();
    await expect(coordinator.assertAvailable([child])).resolves.toBeUndefined();
  });

  it('fails closed after the lock is compromised instead of reporting a successful write', async () => {
    const { agentDir, session } = await setup();
    const coordinator = sessionOperationLeases(agentDir, { staleMs: 2_000 });
    const handle = await coordinator.acquire([session], { owner: 'transfer-1' });
    await handle.assertOwned();

    // 外部把锁目录删掉：心跳下一次检查就会发现失锁。
    const key = sessionOperationLeaseKey(await normalizeSessionOperationPath(session));
    await rm(`${sessionOperationLeaseLockTarget(agentDir, key)}.lock`, { recursive: true, force: true });
    // 心跳把锁判失效后 held 会被摘掉：等 assertHeld 开始拒绝。
    await waitFor(async () => coordinator.assertHeld([session], 'transfer-1').then(() => false, () => true), 4_000);

    await expect(handle.assertOwned()).rejects.toBeInstanceOf(SessionOperationLeaseLostError);
    await expect(coordinator.assertHeld([session], 'transfer-1')).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_LOST' });
    // 锁已经失效，新的合法写者可以进来；失锁者不能继续宣称持有。
    const other = await coordinator.acquire([session], { owner: 'other' });
    await other.release();
    await handle.release();
  });

  it('does not let a scope return success when it lost the lock mid-operation', async () => {
    const { agentDir, session } = await setup();
    // 先建好短 stale 的 coordinator，withSessionOperationLease 会复用同一个实例。
    sessionOperationLeases(agentDir, { staleMs: 2_000 });
    const key = sessionOperationLeaseKey(await normalizeSessionOperationPath(session));
    await expect(withSessionOperationLease(agentDir, [session], async () => {
      await rm(`${sessionOperationLeaseLockTarget(agentDir, key)}.lock`, { recursive: true, force: true });
      await waitFor(async () => !(await stat(`${sessionOperationLeaseLockTarget(agentDir, key)}.lock`).then(() => true, () => false)), 4_000);
      // 等心跳把锁判失效。
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }, { waitMs: 0 })).rejects.toBeInstanceOf(SessionOperationLeaseLostError);
    expect((await sessionOperationLeases(agentDir).check([session])).available).toBe(true);
  });

  it('fails closed when the journal probe cannot tell whether a transfer is unfinished', async () => {
    const { agentDir, session } = await setup();
    const coordinator = sessionOperationLeases(agentDir);
    coordinator.setBlockerProbe({ blocked: () => { throw new Error('journal unreadable'); } });
    await expect(coordinator.acquire([session])).rejects.toMatchObject({ code: 'SESSION_OPERATION_LEASE_BLOCKED' });
  });
});
