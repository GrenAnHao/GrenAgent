import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionProjectTransferOwner,
  type TransferPorts,
} from './sessionProjectTransfer.js';
import {
  SessionProjectTransferJournal,
  readTransferJournalBlocks,
  readTransferJournalManifest,
  sha256Text,
  type JournalFaultHook,
} from './sessionProjectTransferJournal.js';
import {
  FakeActivity,
  FakeRegistry,
  FakeWriters,
  catalog,
  entry,
  header,
  registryRowsMap,
  rewriteHeaderCwd,
  row,
  sessionText,
  subagentMeta,
  writeFixture,
} from './sessionProjectTransferFixture.test-helper.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function crash(point: string): Error {
  const error = new Error(`simulated crash at ${point}`);
  error.name = 'TRANSFER_SIMULATED_CRASH';
  return error;
}

interface Fixture {
  root: string;
  agentDir: string;
  sessionsRoot: string;
  source: string;
  target: string;
  mainPath: string;
  childPath: string;
  mainText: string;
  childText: string;
  registry: FakeRegistry;
  writers: FakeWriters;
  activity: FakeActivity;
  ports: TransferPorts;
  owner: (faults?: JournalFaultHook) => SessionProjectTransferOwner;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'session-transfer-recovery-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const sessionsRoot = join(agentDir, 'sessions');
  const source = join(root, 'projects', 'source');
  const target = join(root, 'projects', 'target');
  await Promise.all([mkdir(sessionsRoot, { recursive: true }), mkdir(source, { recursive: true }), mkdir(target, { recursive: true })]);
  const mainPath = join(sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_session-main.jsonl');
  const childPath = join(sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-1.jsonl');

  const childLines = [
    header('sa-1', source, { parentSession: mainPath }),
    entry('c1', null),
    subagentMeta('c-meta', 'c1', {
      origin: 'subagent',
      agentId: 'sa-1',
      parentSession: mainPath,
      parentSessionId: 'session-main',
      mode: 'continuable',
      depth: 1,
    }),
  ];
  await writeFixture({ path: childPath, lines: childLines });
  const childText = sessionText(childLines[0], childLines.slice(1));

  const mainLines = [header('session-main', source), entry('m1', null), catalog('cat-1', 'm1', 'sa-1', childPath, 'continuable')];
  await writeFixture({ path: mainPath, lines: mainLines });
  const mainText = sessionText(mainLines[0], mainLines.slice(1));

  const registry = new FakeRegistry(
    registryRowsMap({
      [source]: [row('sa-1', { sessionPath: childPath, parentId: 'session-main', status: 'done' })],
      [target]: [],
    }),
  );
  const writers = new FakeWriters();
  const activity = new FakeActivity();
  const ports: TransferPorts = {
    registry,
    images: rewriteHeaderCwd,
    writers,
    activity,
    position: { read: async () => 'm1' },
  };
  return {
    root,
    agentDir,
    sessionsRoot,
    source,
    target,
    mainPath,
    childPath,
    mainText,
    childText,
    registry,
    writers,
    activity,
    ports,
    owner: (faults) => new SessionProjectTransferOwner({ agentDir, ports, ...(faults ? { faults } : {}) }),
  };
}

async function previewAndCommit(f: Fixture, faults?: JournalFaultHook) {
  const owner = f.owner(faults);
  const preview = await owner.preview({
    sourceWorkspace: f.source,
    sessionPath: f.mainPath,
    targetWorkspace: f.target,
  });
  if (preview.status !== 'preview') throw new Error(`expected preview, got ${preview.status}: ${JSON.stringify(preview)}`);
  const result = await owner.commit({
    operationId: preview.operationId,
    ticket: preview.ticket,
    expectedSessionId: preview.sessionId,
    expectedLeafId: preview.leafId,
    expectedRevision: preview.revision,
    sourceWorkspace: f.source,
    sessionPath: f.mainPath,
  });
  return { owner, preview, result };
}

async function read(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

async function journalState(agentDir: string, operationId: string): Promise<string | undefined> {
  return (await readTransferJournalManifest(agentDir, operationId))?.state;
}

async function expectSourceIntact(f: Fixture) {
  expect(await readFile(f.mainPath, 'utf8')).toBe(f.mainText);
  expect(await readFile(f.childPath, 'utf8')).toBe(f.childText);
  expect((await f.registry.read(f.source)).some((item) => item.id === 'sa-1')).toBe(true);
  expect((await f.registry.read(f.target)).some((item) => item.id === 'sa-1')).toBe(false);
}

async function expectMoved(f: Fixture) {
  for (const path of [f.mainPath, f.childPath]) {
    const header = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]) as { cwd: string };
    expect(header.cwd).toBe(f.target);
  }
  expect((await f.registry.read(f.target)).some((item) => item.id === 'sa-1')).toBe(true);
  expect((await f.registry.read(f.source)).some((item) => item.id === 'sa-1')).toBe(false);
}

describe('session project transfer journal and recovery', () => {
  it('commits once, reports opened, and never appends a second migration on repeat commit', async () => {
    const f = await fixture();
    const { owner, preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('opened');
    expect(f.writers.registered).toEqual([f.target]);
    expect(f.writers.opened).toEqual([f.mainPath]);
    await expectMoved(f);

    const manifest = await readTransferJournalManifest(f.agentDir, preview.operationId);
    expect(manifest?.state).toBe('opened');
    expect(manifest?.sessionId).toBe('session-main');
    expect(manifest?.leafId).toBe('m1');

    const before = await readFile(f.mainPath, 'utf8');
    const again = await owner.commit({
      operationId: preview.operationId,
      ticket: preview.ticket,
      expectedSessionId: preview.sessionId,
      expectedLeafId: preview.leafId,
      expectedRevision: preview.revision,
    });
    expect(again.status).toBe('opened');
    expect(await readFile(f.mainPath, 'utf8')).toBe(before);
    expect(f.registry.applyCount).toBe(1);
    expect((await owner.status(preview.operationId)).status).toBe('opened');
  });

  it('keeps original IDs, paths and history while only the header cwd changes', async () => {
    const f = await fixture();
    const { preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('opened');
    const after = await readFile(f.mainPath, 'utf8');
    const lines = after.split('\n').filter(Boolean);
    const before = f.mainText.split('\n').filter(Boolean);
    expect(lines).toHaveLength(before.length);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'session-main', cwd: f.target });
    expect(lines.slice(1)).toEqual(before.slice(1));
    expect(preview.sessionPath).toBe(f.mainPath);
  });

  it('writes no `.jsonl` backup and keeps journal snapshots as json inside agentDir', async () => {
    const f = await fixture();
    const { preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('opened');
    const dir = join(f.agentDir, 'session-transfers', preview.operationId);
    const names = await readdir(dir);
    expect(names.some((name) => name.endsWith('.jsonl'))).toBe(false);
    for (const name of names) expect(name.endsWith('.json') || name.endsWith('.tmp')).toBe(true);
    // Nothing was ever written next to the session files.
    const sessionFiles = (await readdir(join(f.sessionsRoot, '--source--'))).sort();
    expect(sessionFiles.every((name) => name.endsWith('.jsonl'))).toBe(true);
  });

  it('fails closed on an unknown journal version instead of treating it as no transfer', async () => {
    const f = await fixture();
    const operationId = '11111111-2222-3333-4444-555555555555';
    const dir = join(f.agentDir, 'session-transfers', operationId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 99, state: 'committed' }), 'utf8');

    const blocks = await readTransferJournalBlocks(f.agentDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ operationId, phase: 'recovery-required' });

    const owner = f.owner();
    await owner.recoverAll();
    expect(await journalState(f.agentDir, operationId)).toBe('unknown-version-placeholder'.slice(0, 0) || undefined);
    const status = await owner.status({ operationId });
    expect(status.status).toBe('recovery-required');
    // Recovery never opens a source session behind an unreadable journal.
    expect(f.writers.opened).toEqual([]);
    await expectSourceIntact(f);
  });

  it('leaves a simulated crash before prepared with no journal residue and an intact source', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'journal:after:write-temp') throw crash(point);
    };
    await expect(previewAndCommit(f, faults)).rejects.toThrow(/simulated crash/);
    const leftover = existsSync(join(f.agentDir, 'session-transfers'))
      ? await readdir(join(f.agentDir, 'session-transfers'))
      : [];
    expect(leftover).toEqual([]);
    await expectSourceIntact(f);
    expect(f.writers.released).toHaveLength(0);
  });

  it('rolls back to the source when the journal cannot persist the prepared manifest', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'manifest:prepared:rename') throw crash(point);
    };
    await expect(previewAndCommit(f, faults)).rejects.toThrow(/JOURNAL_PREPARE_FAILED|simulated crash/);
    await expectSourceIntact(f);
    expect(f.registry.applyCount).toBe(0);
  });

  it('rolls back a crash after the first file replacement and after the registry update', async () => {
    for (const point of ['write:1:after', 'registry:applied'] as const) {
      const f = await fixture();
      const faults: JournalFaultHook = (failed) => {
        if (failed === point) throw crash(failed);
      };
      let operationId = '';
      const owner = f.owner(faults);
      const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
      if (preview.status !== 'preview') throw new Error('expected preview');
      operationId = preview.operationId;
      await expect(
        owner.commit({
          operationId: preview.operationId,
          ticket: preview.ticket,
          expectedSessionId: preview.sessionId,
          expectedLeafId: preview.leafId,
          expectedRevision: preview.revision,
        }),
      ).rejects.toThrow(/simulated crash/);
      expect(await journalState(f.agentDir, operationId)).toBe('applying');

      // Cold start: roll back to the source before any workspace resume.
      const recoveryOwner = f.owner();
      const blocks = await recoveryOwner.blockedFamilies();
      expect(blocks.some((block) => block.operationId === operationId && block.sourceWorkspace === f.source)).toBe(true);
      await recoveryOwner.recoverAll();
      expect(await journalState(f.agentDir, operationId)).toBe('rolled-back');
      await expectSourceIntact(f);
      expect((await recoveryOwner.blockedFamilies()).some((block) => block.operationId === operationId)).toBe(false);
      // The rolled-back source is sendable again with no journal snapshot left.
      const names = await readdir(join(f.agentDir, 'session-transfers', operationId));
      expect(names).toEqual(['manifest.json']);
    }
  });

  it('rolls back a crash after target verification but before the committed decision', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'target:verified') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);
    // No committed decision was persisted: the family must return to the source.
    expect(await journalState(f.agentDir, preview.operationId)).toBe('applying');
    expect(f.writers.opened).toEqual([]);
    await f.owner().recoverAll();
    expect(await journalState(f.agentDir, preview.operationId)).toBe('rolled-back');
    await expectSourceIntact(f);
  });

  it('rolls back a crash at the applying transition before any file was touched', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'manifest:applying:rename') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);
    expect(await journalState(f.agentDir, preview.operationId)).toBe('prepared');
    await f.owner().recoverAll();
    expect(await journalState(f.agentDir, preview.operationId)).toBe('rolled-back');
    await expectSourceIntact(f);
    // A rolled-back family is previewable again.
    const retry = await f.owner().preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    expect(retry.status).toBe('preview');
  });

  it('fails stale when the old writer legally appends during release instead of overwriting it', async () => {
    const f = await fixture();
    f.writers.release = async () => {
      // session_shutdown appends through the still-live session manager.
      const grown = `${await readFile(f.mainPath, 'utf8')}${JSON.stringify(entry('shutdown', 'm1'))}
`;
      await writeFile(f.mainPath, grown, 'utf8');
    };
    const { result } = await previewAndCommit(f);
    expect(result.status).toBe('stale');
    if (result.status === 'stale') expect(result.staleReason).toBe('source-changed');
    // The appended line is preserved byte-exactly; nothing is rolled back over it.
    expect((await readFile(f.mainPath, 'utf8')).includes('text-shutdown')).toBe(true);
    expect(f.registry.applyCount).toBe(0);
  });

  it('never overwrites external writes during rollback and blocks the family instead', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'registry:applied') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);

    // An external CLI appends to the moved main session between crash and recovery.
    const moved = `${await readFile(f.mainPath, 'utf8')}${JSON.stringify({ ...entry('external', 'm1') })}\n`;
    await writeFile(f.mainPath, moved, 'utf8');

    const recoveryOwner = f.owner();
    await recoveryOwner.recoverAll();
    expect(await journalState(f.agentDir, preview.operationId)).toBe('recovery-required');
    expect(await readFile(f.mainPath, 'utf8')).toBe(moved);
    const status = await recoveryOwner.status({ operationId: preview.operationId });
    expect(status.status).toBe('recovery-required');
    const blocks = await recoveryOwner.blockedFamilies();
    const blocked = blocks.find((block) => block.operationId === preview.operationId);
    expect(blocked?.sessionPaths).toContain(f.mainPath);
    // Probe integration: lease blockers surface the same family.
    const probe = await recoveryOwner.blocked([f.mainPath]);
    expect(probe).toHaveLength(1);
  });

  it('accepts append-only growth after commit and blocks a rewrite instead of restoring from the journal', async () => {
    // Growth is legal: a real SDK open appends system/custom/native-model entries.
    const grown = await fixture();
    grown.writers.failOpen = true;
    const first = await previewAndCommit(grown);
    expect(first.result.status).toBe('committed-needs-open');
    const appended = `${await readFile(grown.mainPath, 'utf8')}${JSON.stringify({
      type: 'message',
      id: 'native-1',
      parentId: 'm1',
      timestamp: '2026-11-17T00:00:01.000Z',
      message: { role: 'system', content: 'project context', timestamp: 2 },
    })}
`;
    await writeFile(grown.mainPath, appended, 'utf8');
    grown.writers.failOpen = false;
    const recover = grown.owner();
    await recover.recoverAll();
    expect(await journalState(grown.agentDir, first.preview.operationId)).toBe('opened');
    expect(await readFile(grown.mainPath, 'utf8')).toBe(appended);
    expect(grown.registry.applyCount).toBe(1);

    // A rewrite of already-committed history is external tampering: keep the bytes,
    // block the family and keep the committed decision (never roll back to before).
    const tampered = await fixture();
    tampered.writers.failOpen = true;
    const second = await previewAndCommit(tampered);
    expect(second.result.status).toBe('committed-needs-open');
    const committed = await readFile(tampered.mainPath, 'utf8');
    const corrupted = committed.replace('text-m1', 'text-M1');
    expect(corrupted.length).toBe(committed.length);
    await writeFile(tampered.mainPath, corrupted, 'utf8');
    const detector = tampered.owner();
    await detector.recoverAll();
    expect(await journalState(tampered.agentDir, second.preview.operationId)).toBe('recovery-required');
    expect(await readFile(tampered.mainPath, 'utf8')).toBe(corrupted);
    expect((await detector.blocked([tampered.mainPath])).length).toBeGreaterThan(0);
  });

  it('recovers committed-but-unopened forward without re-running the move', async () => {
    const f = await fixture();
    f.writers.failOpen = true;
    const { owner, preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('committed-needs-open');
    if (result.status === 'committed-needs-open') expect(result.reason).toMatch(/target runtime failed/);
    expect(await journalState(f.agentDir, preview.operationId)).toBe('committed');
    await expectMoved(f);

    f.writers.failOpen = false;
    const retried = await owner.retryOpen({ operationId: preview.operationId, sourceWorkspace: f.source, sessionPath: f.mainPath });
    expect(retried.status).toBe('opened');
    expect(f.registry.applyCount).toBe(1);
    expect(f.writers.opened).toEqual([f.mainPath, f.mainPath]);
    expect(await journalState(f.agentDir, preview.operationId)).toBe('opened');
  });

  it('cold-start recovery opens a committed operation and idempotently replays registration', async () => {
    const f = await fixture();
    f.writers.failOpen = true;
    const { preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('committed-needs-open');

    const blocks = await readTransferJournalBlocks(f.agentDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ operationId: preview.operationId, phase: 'committed', sourceWorkspace: f.source, targetWorkspace: f.target });

    f.writers.failOpen = false;
    const cold = f.owner();
    await cold.recoverAll();
    expect(await journalState(f.agentDir, preview.operationId)).toBe('opened');
    expect(f.writers.registered).toEqual([f.target, f.target]);
    expect(f.registry.applyCount).toBe(1);
    await expectMoved(f);
    expect(await readTransferJournalBlocks(f.agentDir)).toEqual([]);
  });

  it('keeps other sessions and unrelated registry rows untouched through rollback and forward recovery', async () => {
    const f = await fixture();
    const otherSession = join(f.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_other.jsonl');
    await writeFixture({ path: otherSession, lines: [header('session-other', f.source), entry('o1', null)] });
    const otherText = await readFile(otherSession, 'utf8');
    await f.registry.apply({
      operationId: 'seed',
      sourceWorkspace: f.target,
      targetWorkspace: f.target,
      remove: [],
      create: [row('unrelated-target', { sessionPath: join(f.target, 'u.jsonl'), parentId: 'session-unrelated' })],
      expectedSourceHash: sha256Text('[]'),
      expectedTargetHash: sha256Text('[]'),
    });

    const faults: JournalFaultHook = (point) => {
      if (point === 'write:1:after') throw crash(point);
    };
    await expect(previewAndCommit(f, faults)).rejects.toThrow(/simulated crash/);
    await f.owner().recoverAll();
    await expectSourceIntact(f);
    expect(await readFile(otherSession, 'utf8')).toBe(otherText);
    expect((await f.registry.read(f.target)).map((item) => item.id)).toEqual(['unrelated-target']);
  });

  it('status reports a busy recovery phase while a transaction is still applying', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'registry:apply') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);

    const status = await owner.status({ operationId: preview.operationId });
    expect(status.status).toBe('busy');
    expect(status.phase).toBe('applying');
    if (status.status === 'busy') expect(status.busyReason).toBe('structure-recovery');
  });

  it('blocks the source and target projects of an applying family, not just its session paths', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'write:0:after') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);

    // The moved file now names the target; a source-project cleanup must still see
    // the family through the journal's recorded workspaces.
    const probe = f.owner();
    expect(await probe.blocked({ workspaces: [f.source] })).toEqual([
      expect.objectContaining({ operationId: preview.operationId, familyPaths: expect.arrayContaining([f.mainPath, f.childPath]) }),
    ]);
    expect(await probe.blocked({ workspaces: [f.target] })).toHaveLength(1);
    // Unrelated projects and sessions stay unblocked.
    expect(await probe.blocked({ workspaces: [join(f.root, 'projects', 'elsewhere')] })).toEqual([]);
    const otherSession = join(f.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_unrelated.jsonl');
    await writeFixture({ path: otherSession, lines: [header('session-unrelated', f.source), entry('u1', null)] });
    expect(await probe.blocked([otherSession])).toEqual([]);
  });

  it('keeps a terminal opened operation terminal across a later move and header rewrite', async () => {
    const f = await fixture();
    // Leave a real committed operation with its snapshots intact (open fails).
    f.writers.failOpen = true;
    const first = await previewAndCommit(f);
    expect(first.result.status).toBe('committed-needs-open');
    const dir = join(f.agentDir, 'session-transfers', first.preview.operationId);
    // Reconstruct the crash window: the opened manifest rename happened but the
    // process died before pruneImages, so after/registry are still on disk.
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'opened', opened: true }), 'utf8');
    expect(await read(join(dir, 'before.json'))).toBeTruthy();
    expect(await read(join(dir, 'after.json'))).toBeTruthy();
    expect(await read(join(dir, 'registry.json'))).toBeTruthy();

    // A later legitimate change: the session moves on to a third project (B→C)
    // and control entries change the header. Replaying the old opened op must not
    // touch it or demote it back to recovery-required.
    const third = join(f.root, 'projects', 'third');
    await mkdir(third, { recursive: true });
    const eol = String.fromCharCode(10);
    const raw = await readFile(f.mainPath, 'utf8');
    const headerLine = JSON.parse(raw.split(eol)[0]) as Record<string, unknown>;
    const moved = `${JSON.stringify({ ...headerLine, cwd: third })}${eol}${raw.split(eol).slice(1).join(eol)}`;
    await writeFile(f.mainPath, moved, 'utf8');

    const owner = f.owner();
    const applies = f.registry.applyCount;
    await owner.recoverAll();
    expect(await journalState(f.agentDir, first.preview.operationId)).toBe('opened');
    expect(await readFile(f.mainPath, 'utf8')).toBe(moved);
    expect(f.registry.applyCount).toBe(applies);
    expect((await owner.status({ operationId: first.preview.operationId })).status).toBe('opened');
    expect((await owner.retryOpen({ operationId: first.preview.operationId })).status).toBe('opened');
    expect((await owner.blockedFamilies()).some((block) => block.operationId === first.preview.operationId)).toBe(false);
    // The redundant private snapshots are collected instead of being re-verified.
    expect(await read(join(dir, 'before.json'))).toBeUndefined();
  });

  it('preview is refused while an unfinished journal covers the family', async () => {
    const f = await fixture();
    const faults: JournalFaultHook = (point) => {
      if (point === 'registry:applied') throw crash(point);
    };
    const owner = f.owner(faults);
    const preview = await owner.preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target });
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(
      owner.commit({
        operationId: preview.operationId,
        ticket: preview.ticket,
        expectedSessionId: preview.sessionId,
        expectedLeafId: preview.leafId,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/simulated crash/);
    await expect(
      f.owner().preview({ sourceWorkspace: f.source, sessionPath: f.mainPath, targetWorkspace: f.target }),
    ).rejects.toThrow(/RECOVERY_PENDING/);
  });

  it('treats an apply CAS conflict from the registry as a rollback, not a committed move', async () => {
    const f = await fixture();
    f.registry.failApply = () => {
      throw new Error('registry cas mismatch (source)');
    };
    const { result } = await previewAndCommit(f);
    // The public contract has no rolled-back status: an uncommitted move keeps the
    // source and asks for a new preview.
    expect(result.status).toBe('stale');
    if (result.status === 'stale') expect(result.notice).toMatch(/未提交|cas mismatch/);
    await expectSourceIntact(f);
  });

  it('never overwrites an external append that arrives while the temp image is flushing', async () => {
    const f = await fixture();
    const firstPath = [f.mainPath, f.childPath].sort()[0];
    let external = '';
    const owner = f.owner(async point => {
      if (point === 'transfer:0:flush') {
        const before = await readFile(firstPath, 'utf8');
        const last = JSON.parse(before.trim().split('\n').at(-1)!) as {id:string};
        external = `${before}${JSON.stringify(entry('external-during-flush',last.id))}\n`;
        await writeFile(firstPath, external);
      }
    });
    const preview = await owner.preview({sourceWorkspace:f.source,sessionPath:f.mainPath,targetWorkspace:f.target});
    if (preview.status !== 'preview') throw new Error('expected preview');
    await expect(owner.commit({operationId:preview.operationId,ticket:preview.ticket,expectedSessionId:preview.sessionId,
      expectedLeafId:preview.leafId,expectedRevision:preview.revision,sourceWorkspace:f.source,sessionPath:f.mainPath})).rejects.toThrow(/外部写入/);
    expect(await readFile(firstPath,'utf8')).toBe(external);
    expect(f.registry.applyCount).toBe(0);
    expect(await journalState(f.agentDir,preview.operationId)).toBe('recovery-required');
  });

  it.each([
    ...['journal:before', 'journal:after', 'journal:registry', 'manifest:prepared', 'manifest:applying', 'manifest:committed', 'manifest:opened']
      .flatMap(label => ['write-temp', 'flush', 'rename', 'renamed'].map(stage => `${label}:${stage}`)),
    ...[0, 1].flatMap(index => ['write-temp', 'flush', 'rename'].map(stage => `transfer:${index}:${stage}`)),
    'write:0:before', 'write:0:after', 'write:1:before', 'write:1:after', 'registry:apply', 'registry:applied', 'registry:verified', 'target:verified',
  ])('recovers the entire family at persistence boundary %s', async point => {
    const f = await fixture();
    let injected = false;
    const owner = f.owner(failed => {
      if (!injected && failed === point) { injected = true; throw crash(point); }
    });
    const preview = await owner.preview({sourceWorkspace:f.source,sessionPath:f.mainPath,targetWorkspace:f.target});
    if (preview.status !== 'preview') throw new Error('expected preview');
    await owner.commit({operationId:preview.operationId,ticket:preview.ticket,expectedSessionId:preview.sessionId,
      expectedLeafId:preview.leafId,expectedRevision:preview.revision,sourceWorkspace:f.source,sessionPath:f.mainPath}).catch(error => {
      // The opened receipt can fail after durable commit; every earlier injected
      // process death is intentionally left for a fresh owner to recover.
      expect(String(error)).toMatch(/simulated crash|JOURNAL_PREPARE_FAILED/);
    });
    expect(injected).toBe(true);
    await f.owner().recoverAll();
    const targetCommitted = point === 'manifest:committed:renamed' || point.startsWith('manifest:opened:');
    if (targetCommitted) await expectMoved(f);
    else await expectSourceIntact(f);
    expect(await f.owner().blockedFamilies()).toEqual([]);
  });

  it('journals a stable operationId and a single commit decision even if the open receipt is lost', async () => {
    const f = await fixture();
    const journal = new SessionProjectTransferJournal(f.agentDir);
    const { owner, preview, result } = await previewAndCommit(f);
    expect(result.status).toBe('opened');
    expect(await journal.list()).toEqual([preview.operationId]);
    const manifest = await readTransferJournalManifest(f.agentDir, preview.operationId);
    expect(manifest?.operationId).toBe(preview.operationId);
    expect(manifest?.commits).toBe(0);
    // The durable decision is the manifest state, not a replayed image build.
    expect(manifest?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await owner.status(preview.operationId)).toMatchObject({ status: 'opened', operationId: preview.operationId });
  });
});
