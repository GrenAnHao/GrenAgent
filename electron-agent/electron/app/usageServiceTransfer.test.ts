import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageLedger } from '../../../extensions/usage-ledger/ledger.js';
import { UsageOriginRegistry, defaultOriginRegistryPath } from '../../../extensions/usage-ledger/originRegistry.js';
import { UsageService } from './usageService';
import { sessionOperationLeases } from './sessionOperationLease';

/**
 * 定向迁移用例（Task 4.3）：只覆盖移动后的会话定位更新与「不新增历史调用」口径。
 * 旧 usageService 用例不在本文件复跑。
 */
const directories: string[] = [];
const ledgers: UsageLedger[] = [];

afterEach(async () => {
  __reset();
  for (const ledger of ledgers.splice(0)) ledger.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function __reset(): void {
  /* 占位：保留对称的清理入口，避免 afterEach 分支分叉。 */
}

const header = (id: string, cwd: string) =>
  JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-11-17T10:00:00Z' });

const assistant = (timestamp: string, messageTimestamp: number, totalTokens: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'message',
    id: `e${messageTimestamp}`,
    timestamp,
    message: {
      role: 'assistant', provider: 'openai', model: 'gpt-5', timestamp: messageTimestamp,
      content: [{ type: 'text', text: 'x'.repeat(120) }],
      usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: totalTokens / 100 } },
      ...extra,
    },
  });

async function setup(options: { leaseWaitMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gren-usage-transfer-'));
  directories.push(root);
  const agent = join(root, 'agent');
  const sessionDir = join(agent, 'sessions', 'hash');
  await mkdir(sessionDir, { recursive: true });
  const source = join(root, 'source-project');
  const target = join(root, 'target-project');
  await mkdir(source);
  await mkdir(target);
  const ledger = new UsageLedger(join(agent, 'usage', 'ledger.db'));
  ledgers.push(ledger);
  const service = new UsageService(agent, { ledger, ...options });
  const sessionPath = join(sessionDir, 'moved.jsonl');
  await writeFile(sessionPath, `${header('s1', source)}\n${assistant('2026-11-17T10:00:01Z', 1, 10)}\n${assistant('2026-11-17T10:01:00Z', 2, 20)}\n`);
  return { root, agent, sessionDir, source, target, ledger, service, sessionPath };
}

/** 模拟迁移写完 header：同一物理路径、同尺寸替换，cwd 指向目标。 */
async function moveFileTo(sessionPath: string, cwd: string, extraLines: string[] = []): Promise<void> {
  const original = await import('node:fs/promises').then((fs) => fs.readFile(sessionPath, 'utf8'));
  const lines = original.split('\n').filter(Boolean);
  lines[0] = header('s1', cwd);
  await writeFile(sessionPath, `${[...lines, ...extraLines].join('\n')}\n`);
}

describe('UsageService session project transfer', () => {
  it('moves the project grouping without adding calls, tokens or cost', async () => {
    const { service, ledger, source, target, sessionPath } = await setup();
    const before = await service.report();
    expect(before.byProject).toEqual([expect.objectContaining({ cwd: source, sessions: 1 })]);
    expect(before.totals).toMatchObject({ sessions: 1, messages: 2, totalTokens: 30 });
    expect(before.totals.cost).toBeCloseTo(0.3);

    await moveFileTo(sessionPath, target);
    await expect(service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }])).resolves.toBe(1);
    const after = await service.report();

    expect(after.byProject).toEqual([expect.objectContaining({ cwd: target, sessions: 1 })]);
    expect(after.totals).toEqual(before.totals);
    expect(after.byDay).toEqual(before.byDay);
    expect(after.byModel).toEqual(before.byModel);
    expect(after.calls).toEqual(before.calls);
    // 账本里没有新增调用行，历史仍按原条目计一次。
    expect(after.recentSessions[0]).toMatchObject({ id: 's1', path: sessionPath, tokens: 30 });
    expect(after.recentSessions[0].cost).toBeCloseTo(0.3);
    expect(ledger.report().totals.messages).toBe(2);
  });

  it('reconcile after a move reports nothing new and keeps the target grouping', async () => {
    const { service, source, target, sessionPath } = await setup();
    await service.report();
    await moveFileTo(sessionPath, target, [
      JSON.stringify({ type: 'custom', customType: 'session_project_transfer', data: { version: 1, operationId: 'op-1', fromWorkspace: source, toWorkspace: target, retentionRoots: [] } }),
    ]);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }]);

    await expect(service.reconcile()).resolves.toEqual({ files: 1, added: 0 });
    const report = await service.report();
    expect(report.totals.messages).toBe(2);
    expect(report.byProject).toEqual([expect.objectContaining({ cwd: target })]);
  });

  it('survives repeated moves and a cold restart without recounting', async () => {
    const { agent, ledger, service, source, target, sessionPath } = await setup();
    const third = join(agent, 'third-project');
    await mkdir(third);
    await service.report();

    await moveFileTo(sessionPath, target);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }]);
    await moveFileTo(sessionPath, third);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: third }]);

    const restarted = new UsageService(agent, { ledger });
    const report = await restarted.report();
    expect(report.byProject).toEqual([expect.objectContaining({ cwd: third })]);
    expect(report.totals).toMatchObject({ messages: 2, totalTokens: 30 });
    expect(report.totals.cost).toBeCloseTo(0.3);
    expect((await restarted.reconcile()).added).toBe(0);
    expect(await restarted.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: source }])).toBe(1);
    expect(ledger.report().byProject).toEqual([expect.objectContaining({ cwd: source })]);
  });

  it('keeps legacy origin, canonical ledger key and path ownership unchanged', async () => {
    const { agent, ledger, service, sessionPath, target } = await setup();
    await service.report();
    const registry = new UsageOriginRegistry(defaultOriginRegistryPath(agent));
    let before: { kind: string; key: string | null };
    try {
      const ref = { sessionId: 's1', entryId: 'e1' };
      before = { kind: registry.resolveUsageOrigin(ref).kind, key: registry.ledgerKey(ref) };
      expect(before.kind).toBe('local-origin');
      expect(before.key).toBeTruthy();
      expect(registry.ownsSessionPath('s1', sessionPath)).toBe(true);
    } finally {
      registry.close();
    }

    await moveFileTo(sessionPath, target);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }]);

    const after = new UsageOriginRegistry(defaultOriginRegistryPath(agent));
    try {
      const ref = { sessionId: 's1', entryId: 'e1' };
      expect(after.resolveUsageOrigin(ref).kind).toBe(before.kind);
      expect(after.ledgerKey(ref)).toBe(before.key);
      expect(after.ownsSessionPath('s1', sessionPath)).toBe(true);
      // 没有创建 clone / import 那种新身份行。
      expect(after.sessionPath('s1')).toBeDefined();
    } finally {
      after.close();
    }
    expect(ledger.report().totals.messages).toBe(2);
  });

  it('refuses to relocate a session whose registered physical path would change', async () => {
    const { service, sessionPath, target } = await setup();
    await service.report();

    // 迁移只改 header cwd，不搬 JSONL：换 path 的请求必须被拒绝，不能悄悄替来源换个物理身份。
    await expect(service.updateSessionLocation([
      { sessionId: 's1', sessionPath: join(sessionPath, '..', 'elsewhere.jsonl'), cwd: target },
    ])).rejects.toThrow('USAGE_SESSION_PATH_MISMATCH');
    expect((await service.report()).byProject).toEqual([expect.objectContaining({ sessions: 1 })]);
  });

  it('keeps external-history and unverified sessions out of local totals after a move', async () => {
    const { agent, sessionDir, service, target } = await setup();
    await service.report();
    const typed = join(sessionDir, 'typed.jsonl');
    await writeFile(typed, `${header('external', target)}\n${assistant('2026-11-17T11:00:00Z', 9, 999, { responseModel: 'poison' })}\n`);
    const registry = new UsageOriginRegistry(defaultOriginRegistryPath(agent));
    try {
      registry.prepare({ operationId: 'import-op', kind: 'import', targetSessionId: 'external', mappings: [{ targetEntryId: 'e9' }] });
      registry.commit('import-op');
    } finally {
      registry.close();
    }
    await service.reconcile();
    const before = await service.report();

    // 账本里只是会话定位行（历史已登记），移动可以更新它；但外部历史没有本地调用，不增加 totals。
    await expect(service.updateSessionLocation([{ sessionId: 'external', sessionPath: typed, cwd: target }])).resolves.toBe(1);
    const after = await service.report();
    // 外部历史没有本地来源，不因移动提升为本机调用，也不新增账本行；
    // 本用例只移动 external，s1 仍在源项目，所以项目分组不变。
    expect(after.totals).toEqual(before.totals);
    expect(after.byProject).toEqual(before.byProject);
    expect(after.recentSessions.some((session) => session.id === 'external')).toBe(false);
  });

  it('does not create a ledger row for a session that has no usage yet', async () => {
    const { service, sessionDir, target } = await setup();
    const fresh = join(sessionDir, 'fresh.jsonl');
    await writeFile(fresh, `${header('fresh', target)}\n`);

    await expect(service.updateSessionLocation([{ sessionId: 'fresh', sessionPath: fresh, cwd: target }])).resolves.toBe(0);
    expect((await service.report()).recentSessions.some((session) => session.id === 'fresh')).toBe(false);
  });

  it('waits for the recovery gate before reading, but relocates without waiting', async () => {
    const { service, sessionPath, target } = await setup();
    await service.report();
    let gateCalls = 0;
    service.setRecoveryGate(async () => {
      gateCalls += 1;
      throw new Error('TRANSFER_RECOVERY_PENDING');
    });

    await expect(service.report()).rejects.toThrow('TRANSFER_RECOVERY_PENDING');
    await expect(service.reconcile()).rejects.toThrow('TRANSFER_RECOVERY_PENDING');
    expect(gateCalls).toBe(2);

    // 更新定位本身就是恢复流程的一部分（committed 恢复先补定位再 retry-open），不能等闸门。
    await moveFileTo(sessionPath, target);
    await expect(service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }])).resolves.toBe(1);
    expect(gateCalls).toBe(2);

    service.setRecoveryGate(undefined);
    await service.reconcile({ skipRecoveryGate: true });
    expect((await service.report()).byProject).toEqual([expect.objectContaining({ cwd: target })]);
  });
});

describe('UsageService reconcile during a concurrent transfer', () => {
  it('does not backfill a session whose file is being moved and leaves the import incomplete', async () => {
    // 等待上限压到最小：本用例要的是「等不到就跳过」，不是真的等 2 秒。
    const { agent, ledger, service, target, sessionPath } = await setup({ leaseWaitMs: 20 });
    // 首次报表只登记历史；之后迁移开始持有该文件的 lease（写入前已 prepared）。
    await service.report();
    // 退回旧版本标记，模拟「迁移期间又有一次补录」从干净状态开始。
    ledger.setMeta('import_version', '1');
    const lease = await sessionOperationLeases(agent).acquire([sessionPath], { owner: 'transfer-op' });
    try {
      await expect(service.reconcile()).resolves.toEqual({ files: 1, added: 0 });
      // 没读到这个文件就不能宣称导入完成，否则半更新 header 的旧定位会被当最终口径。
      expect(ledger.getMeta('import_version')).toBe('1');
    } finally {
      await lease.release();
    }

    // 迁移结束后补录正常完成，并且不重复计入历史。
    await moveFileTo(sessionPath, target);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }]);
    await expect(service.reconcile()).resolves.toEqual({ files: 1, added: 0 });
    expect(ledger.getMeta('import_version')).toBe('2');
    expect((await service.report()).totals.messages).toBe(2);
    expect((await service.report()).byProject).toEqual([expect.objectContaining({ cwd: target })]);
  });

  it('reads from the post-commit header instead of overwriting the relocated cwd', async () => {
    const { ledger, service, source, target, sessionPath } = await setup();
    await service.report();
    expect((await service.report()).byProject).toEqual([expect.objectContaining({ cwd: source })]);

    // 迁移提交后：header 已是目标，账本定位也更新；随后一次全局补录必须保持目标分组。
    await moveFileTo(sessionPath, target);
    await service.updateSessionLocation([{ sessionId: 's1', sessionPath, cwd: target }]);
    await ledger.setMeta('import_version', '1');
    await service.reconcile();

    const report = await service.report();
    expect(report.byProject).toEqual([expect.objectContaining({ cwd: target })]);
    expect(report.totals).toMatchObject({ messages: 2, totalTokens: 30 });
    expect(ledger.getMeta('import_version')).toBe('2');
  });

  it('keeps scanning other sessions while one family is blocked by an unfinished transfer', async () => {
    const { agent, sessionDir, ledger, service, target, sessionPath } = await setup();
    const other = join(sessionDir, 'other.jsonl');
    // 两条都是既有会话（首轮报表冻结 legacy），之后各自追加一条新调用。
    await writeFile(other, `${header('s2', target)}
`);
    await service.report();
    await appendFile(sessionPath, `${assistant('2026-11-17T13:00:00Z', 3, 5)}
`);
    await appendFile(other, `${assistant('2026-11-17T13:00:01Z', 4, 7)}
`);
    ledger.setMeta('import_version', '1');

    sessionOperationLeases(agent).setBlockerProbe({
      blocked: (query) => (query.paths ?? []).some((candidate) => candidate.endsWith("/moved.jsonl"))
        ? [{ reason: '该族有未完成迁移', operationId: 'op-1', path: sessionPath }]
        : [],
    });
    try {
      // blocked 的文件不读（不报错整轮失败），其他会话照常补录；但本轮不算导入完成。
      await expect(service.reconcile()).resolves.toEqual({ files: 2, added: 1 });
      expect(ledger.getMeta('import_version')).toBe('1');
    } finally {
      sessionOperationLeases(agent).setBlockerProbe(undefined);
    }
    // 迁移结束后重试，把被跳过的会话补上，历史不重计。
    await expect(service.reconcile()).resolves.toEqual({ files: 2, added: 1 });
    expect(ledger.getMeta('import_version')).toBe('2');
    expect((await service.report()).totals.messages).toBe(4);
  });

  it('waits for a short-held lease instead of skipping the session', async () => {
    const { agent, service, target, sessionPath } = await setup();
    await writeFile(sessionPath, `${header('s1', target)}\n${assistant('2026-11-17T10:00:00Z', 1, 10)}\n${assistant('2026-11-17T10:01:00Z', 2, 20)}\n`);
    const short = new UsageService(agent, { ledger: (await import('../../../extensions/usage-ledger/ledger.js')).sharedLedger(join(agent, 'usage', 'ledger.db')), leaseWaitMs: 2_000 });
    void short;
    const held = await sessionOperationLeases(agent).acquire([sessionPath], { owner: 'send-flow' });
    setTimeout(() => { void held.release(); }, 150);
    // 短暂并发（一次命令发送）会让出：等待后仍按真实内容补录。
    await expect(service.reconcile()).resolves.toMatchObject({ files: 1, added: 2 });
  });
});
