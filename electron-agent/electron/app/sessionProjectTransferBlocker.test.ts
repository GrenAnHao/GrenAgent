import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionProjectTransferJournal,
  sha256Text,
  type TransferJournalAfterImage,
  type TransferJournalFileImage,
} from './sessionProjectTransferJournal';
import { configureTransferJournalBlocker } from './sessionProjectTransferBlocker';
import {
  SessionOperationLeaseBlockedError,
  __resetSessionOperationLeaseForTest,
  sessionOperationLeases,
} from './sessionOperationLease';

const roots: string[] = [];

afterEach(async () => {
  __resetSessionOperationLeaseForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gren-transfer-blocker-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  const source = join(root, 'source-project');
  const target = join(root, 'target-project');
  const other = join(root, 'other-project');
  await Promise.all([mkdir(source), mkdir(target), mkdir(other)]);
  const sessionDir = join(agentDir, 'sessions', 'hash');
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'moved.jsonl');
  const childPath = join(sessionDir, 'child.jsonl');
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'moved', cwd: source })}\n`);
  await writeFile(childPath, `${JSON.stringify({ type: 'session', id: 'child', cwd: source })}\n`);
  return { root, agentDir, source, target, other, sessionPath, childPath };
}

const image = (path: string, content: string): TransferJournalFileImage => ({
  path, content, sha256: sha256Text(content), bytes: Buffer.byteLength(content, 'utf8'),
});

async function prepareTransfer(
  agentDir: string,
  input: { operationId: string; source: string; target: string; sessionPath: string; childPath: string; state?: 'prepared' | 'applying' },
) {
  const journal = new SessionProjectTransferJournal(agentDir);
  const before = image(input.sessionPath, '{"type":"session","id":"moved"}\n');
  const childBefore = image(input.childPath, '{"type":"session","id":"child"}\n');
  const after: TransferJournalAfterImage = {
    path: input.sessionPath,
    beforeSha256: before.sha256,
    content: before.content,
    sha256: before.sha256,
    bytes: before.bytes,
  };
  const childAfter: TransferJournalAfterImage = {
    path: input.childPath,
    beforeSha256: childBefore.sha256,
    content: childBefore.content,
    sha256: childBefore.sha256,
    bytes: childBefore.bytes,
  };
  await journal.savePrepared({
    operationId: input.operationId,
    sourceWorkspace: input.source,
    targetWorkspace: input.target,
    sessionId: 'moved',
    sessionPath: input.sessionPath,
    leafId: null,
    revision: 'rev-1',
    fingerprint: 'fp-1',
    family: [{ sessionPath: input.childPath, sessionId: 'child', parentSessionPath: input.sessionPath, agentId: 'sa-child', mode: 'continuable', depth: 1, sha256: childBefore.sha256, bytes: childBefore.bytes }],
    registryHash: sha256Text('[]'),
    registryRecordCount: 0,
    before: [before, childBefore],
    after: [after, childAfter],
    registry: { version: 1, rows: [], expectedSourceHash: sha256Text('[]'), expectedTargetHash: sha256Text('[]') },
    now: Date.now(),
  });
  const loaded = await journal.load(input.operationId);
  if (input.state === 'applying') await journal.transition(loaded!.manifest!, 'applying');
  return journal;
}

describe('transfer journal lease blocker adapter', () => {
  it('blocks the affected family by path and keeps unrelated sessions writable', async () => {
    const { agentDir, source, target, other, sessionPath, childPath } = await setup();
    await prepareTransfer(agentDir, { operationId: '11111111-1111-4111-8111-111111111111', source, target, sessionPath, childPath });
    configureTransferJournalBlocker(agentDir);
    const coordinator = sessionOperationLeases(agentDir);

    await expect(coordinator.acquire([sessionPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    // family 成员也算，不只主会话。
    await expect(coordinator.acquire([childPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    // 无关项目 / 其他会话照常。
    await expect(coordinator.assertAvailable([], { workspaces: [other] })).resolves.toBeUndefined();
    const unrelated = await coordinator.acquire([join(otherSessions(agentDir), 'unrelated.jsonl')]);
    await unrelated.release();
  });

  it('blocks project cleanup by journal source / target workspace after the header already moved', async () => {
    const { agentDir, source, target, other, sessionPath, childPath } = await setup();
    await prepareTransfer(agentDir, {
      operationId: '22222222-2222-4222-8222-222222222222', source, target, sessionPath, childPath, state: 'applying',
    });
    configureTransferJournalBlocker(agentDir);
    const coordinator = sessionOperationLeases(agentDir);

    // applying 中 header 已指向目标：源项目按 header 扫不到它，只有 journal 知道。
    await expect(coordinator.assertAvailable([], { workspaces: [source] })).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [target] })).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [other] })).resolves.toBeUndefined();

    const blocked = await coordinator.probe({ workspaces: [source] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ operationId: '22222222-2222-4222-8222-222222222222' });
    expect(blocked[0].familyPaths?.sort()).toEqual([norm(childPath), norm(sessionPath)].sort());
    // 恢复流程自己仍能取锁收尾。
    const recovery = await coordinator.acquire([sessionPath], { allowBlocked: true });
    await recovery.release();
  });

  it('releases the gate once the transfer reaches a terminal state', async () => {
    const { agentDir, source, target, sessionPath, childPath } = await setup();
    const operationId = '33333333-3333-4333-8333-333333333333';
    const journal = await prepareTransfer(agentDir, { operationId, source, target, sessionPath, childPath });
    configureTransferJournalBlocker(agentDir);
    const coordinator = sessionOperationLeases(agentDir);
    await expect(coordinator.acquire([sessionPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);

    const loaded = await journal.load(operationId);
    await journal.transition(loaded!.manifest!, 'opened', { opened: true });

    await expect(coordinator.acquire([sessionPath])).resolves.toBeTruthy();
  });

  it('fails closed on an unreadable journal but only for the family it can still locate', async () => {
    const { agentDir, source, target, other, sessionPath, childPath } = await setup();
    const operationId = '44444444-4444-4444-8444-444444444444';
    await prepareTransfer(agentDir, { operationId, source, target, sessionPath, childPath });
    // 未知版本：projection 会 fail-closed，但原始 manifest 仍能定位族。
    await writeFile(join(agentDir, 'session-transfers', operationId, 'manifest.json'), JSON.stringify({
      version: 99, kind: 'session-project-transfer', operationId, state: 'applying',
      sessionPath, sourceWorkspace: source, targetWorkspace: target,
    }));
    configureTransferJournalBlocker(agentDir);
    const coordinator = sessionOperationLeases(agentDir);

    await expect(coordinator.acquire([sessionPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [source] })).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [other] })).resolves.toBeUndefined();
  });

  it('returns synchronously so runtime construction can wire it before any command', () => {
    const { agentDir } = { agentDir: 'C:/virtual-agent' } as { agentDir: string };
    // 只是 setBlockerProbe：没有文件系统等待，constructor / createRuntimeGraph 里可直接调用。
    expect(configureTransferJournalBlocker(agentDir)).toBeUndefined();
  });

  it('blocks every family when the journal cannot locate the affected family at all', async () => {
    const { agentDir, source, target, other, sessionPath, childPath } = await setup();
    const operationId = '55555555-5555-4555-8555-555555555555';
    // 只有残缺 manifest（没有 sessionPath / family / 源目标）且缺快照：projection 与原始 manifest
    // 都定位不出族，必须全局阻塞，不能静默放行。
    await mkdir(join(agentDir, 'session-transfers', operationId), { recursive: true });
    await writeFile(join(agentDir, 'session-transfers', operationId, 'manifest.json'), JSON.stringify({
      version: 1, kind: 'session-project-transfer', operationId, state: 'applying',
    }));
    configureTransferJournalBlocker(agentDir);
    const coordinator = sessionOperationLeases(agentDir);

    await expect(coordinator.acquire([sessionPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.acquire([childPath])).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [other] })).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
    await expect(coordinator.assertAvailable([], { workspaces: [source, target] })).rejects.toBeInstanceOf(SessionOperationLeaseBlockedError);
  });

  it('blocks everything when the journal directory itself cannot be read', async () => {
    const { agentDir } = await setup();
    // session-transfers 是个文件而不是目录：projection 抛错，无法证明任何会话无关。
    await writeFile(join(agentDir, 'session-transfers'), 'not a directory');
    configureTransferJournalBlocker(agentDir);
    await expect(sessionOperationLeases(agentDir).probe({ paths: [] })).resolves.toMatchObject([
      { reason: expect.stringContaining('journal') },
    ]);
  });
});

function otherSessions(agentDir: string): string {
  return join(agentDir, 'sessions', 'other');
}

function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
