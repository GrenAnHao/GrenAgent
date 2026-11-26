/**
 * Lease-loss fail-closed cases for the transfer owner.
 *
 * The owner takes the family lease directly (not through the ALS helper), so
 * `assertOwned` is the only signal that a heartbeat failure or an external lock
 * removal happened. A lost lease means another process may already own the
 * family: these cases assert the writer stops *all* session/registry/journal
 * writes at that boundary, never claims `opened`, and lets the rightful owner
 * re-read the manifest under its own lease.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionProjectTransferOwner,
  TransferLeaseLostError,
  type TransferLeasePort,
  type TransferPorts,
} from './sessionProjectTransfer.js';
import { readTransferJournalManifest } from './sessionProjectTransferJournal.js';
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

/** Lease that holds until `shouldLose(assertionIndex)` flips it. */
function lossyLease(shouldLose: (assertion: number) => boolean) {
  let assertions = 0;
  const state = { released: 0, acquired: 0, assertions: 0, lost: false };
  const port: TransferLeasePort = {
    async acquire() {
      state.acquired += 1;
      let lost = false;
      return {
        async assertOwned() {
          assertions += 1;
          state.assertions = assertions;
          if (shouldLose(assertions)) {
            lost = true;
            state.lost = true;
            throw new Error('lock directory was removed');
          }
          if (lost) throw new Error('lock already lost');
        },
        async release() {
          state.released += 1;
        },
      };
    },
  };
  return { port, state };
}

interface Fixture {
  root: string;
  agentDir: string;
  source: string;
  target: string;
  mainPath: string;
  childPath: string;
  mainText: string;
  childText: string;
  registry: FakeRegistry;
  writers: FakeWriters;
  ports: (lease: TransferLeasePort) => TransferPorts;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'session-transfer-lease-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const sessionsRoot = join(agentDir, 'sessions');
  const source = join(root, 'projects', 'source');
  const target = join(root, 'projects', 'target');
  await Promise.all([
    mkdir(sessionsRoot, { recursive: true }),
    mkdir(source, { recursive: true }),
    mkdir(target, { recursive: true }),
  ]);
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

  const mainLines = [
    header('session-main', source),
    entry('m1', null),
    catalog('cat-1', 'm1', 'sa-1', childPath, 'continuable'),
  ];
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
  return {
    root,
    agentDir,
    source,
    target,
    mainPath,
    childPath,
    mainText,
    childText,
    registry,
    writers,
    ports: (lease) => ({
      registry,
      images: rewriteHeaderCwd,
      writers,
      activity,
      position: { read: async () => 'm1' },
      lease,
    }),
  };
}

async function preview(f: Fixture, owner: SessionProjectTransferOwner) {
  const result = await owner.preview({
    sourceWorkspace: f.source,
    sessionPath: f.mainPath,
    targetWorkspace: f.target,
  });
  if (result.status !== 'preview') throw new Error(`expected preview, got ${result.status}`);
  return result;
}

function commitInput(previewAck: Awaited<ReturnType<typeof preview>>) {
  return {
    operationId: previewAck.operationId,
    ticket: previewAck.ticket,
    expectedSessionId: previewAck.sessionId,
    expectedLeafId: previewAck.leafId,
    expectedRevision: previewAck.revision,
    sourceWorkspace: previewAck.sourceWorkspace,
    sessionPath: previewAck.sessionPath,
  } as const;
}

async function stateOf(agentDir: string, operationId: string): Promise<string | undefined> {
  return (await readTransferJournalManifest(agentDir, operationId))?.state;
}

describe('session project transfer lease loss', () => {
  it('stops before any write when the lease is already lost', async () => {
    const f = await fixture();
    const lease = lossyLease((n) => n === 1);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port) });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    await expect(readFile(f.mainPath, 'utf8')).resolves.toBe(f.mainText);
    await expect(readFile(f.childPath, 'utf8')).resolves.toBe(f.childText);
    expect(f.registry.applyCount).toBe(0);
    expect(f.writers.opened).toEqual([]);
    // Nothing was prepared, so there is no journal claiming a move.
    expect(await stateOf(f.agentDir, p.operationId)).toBeUndefined();
  });

  it('rechecks ownership after temp flush and leaves the original file untouched on loss', async () => {
    const f = await fixture();
    let flushed = false;
    const lease = lossyLease(() => flushed);
    const owner = new SessionProjectTransferOwner({
      agentDir: f.agentDir, ports: f.ports(lease.port),
      faults: point => { if (point === 'transfer:0:flush') flushed = true; },
    });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    expect(await readFile(f.mainPath, 'utf8')).toBe(f.mainText);
    expect(await readFile(f.childPath, 'utf8')).toBe(f.childText);
    expect(f.registry.applyCount).toBe(0);
    expect(await stateOf(f.agentDir, p.operationId)).toBe('applying');
  });

  it('leaves the applying phase untouched when ownership is lost between replacements', async () => {
    const f = await fixture();
    let firstReplaced = false;
    const lease = lossyLease(() => firstReplaced);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port),
      faults: point => { if (point === 'write:0:after') firstReplaced = true; },
    });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    // The lost writer must not transition the journal (a newer owner may hold it).
    expect(await stateOf(f.agentDir, p.operationId)).toBe('applying');
    // Exactly one file had been replaced; the second was never touched.
    const movedChild = JSON.parse((await readFile(f.childPath, 'utf8')).split('\n')[0]) as { cwd: string };
    expect(movedChild.cwd).toBe(f.target);
    await expect(readFile(f.mainPath, 'utf8')).resolves.toBe(f.mainText);
    expect(f.registry.applyCount).toBe(0);
    expect(f.writers.opened).toEqual([]);
  });

  it('does not apply registry rows or roll back over files when the lease is lost', async () => {
    const f = await fixture();
    let replacements = 0;
    const lease = lossyLease(() => replacements === 2);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port),
      faults: point => { if (/^write:[01]:after$/.test(point)) replacements += 1; },
    });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    expect(f.registry.applyCount).toBe(0);
    expect(f.registry.rolledBack).toEqual([]);
    expect(await stateOf(f.agentDir, p.operationId)).toBe('applying');
    expect(f.writers.opened).toEqual([]);
  });

  it('never records a committed decision from a lost lease', async () => {
    const f = await fixture();
    let targetVerified = false;
    const lease = lossyLease(() => targetVerified);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port),
      faults: point => { if (point === 'target:verified') targetVerified = true; },
    });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    expect(await stateOf(f.agentDir, p.operationId)).toBe('applying');
    expect(f.writers.registered).toEqual([]);
    expect(f.writers.opened).toEqual([]);
  });

  it('does not claim opened when ownership is lost while opening the target', async () => {
    const f = await fixture();
    let targetOpened = false;
    const open = f.writers.open.bind(f.writers);
    f.writers.open = async input => { await open(input); targetOpened = true; };
    const lease = lossyLease(() => targetOpened);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port) });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toThrow(/TRANSFER_RECOVERY_REQUIRED/);
    // The durable commit decision was already written by *this* writer under a valid
    // lease; only the opened receipt is missing, so recovery can finish it.
    expect(await stateOf(f.agentDir, p.operationId)).toBe('committed');
    expect(f.writers.opened).toHaveLength(1);
  });

  it('skips recovery entirely when the recovery lease cannot be acquired', async () => {
    const f = await fixture();
    const ok = new SessionProjectTransferOwner({
      agentDir: f.agentDir,
      ports: {
        ...f.ports(lossyLease(() => false).port),
        writers: Object.assign(Object.create(Object.getPrototypeOf(f.writers)) as FakeWriters, f.writers, {
          open: async () => {
            throw new Error('runtime unavailable');
          },
        }),
      },
    });
    const p = await preview(f, ok);
    expect((await ok.commit(commitInput(p))).status).toBe('committed-needs-open');

    const before = {
      main: await readFile(f.mainPath, 'utf8'),
      child: await readFile(f.childPath, 'utf8'),
      applies: f.registry.applyCount,
    };
    const busy = new SessionProjectTransferOwner({
      agentDir: f.agentDir,
      ports: {
        ...f.ports({
          async acquire() {
            throw new Error('SESSION_OPERATION_LEASE_BUSY');
          },
        }),
      },
    });
    await busy.recoverAll();
    expect(await readFile(f.mainPath, 'utf8')).toBe(before.main);
    expect(await readFile(f.childPath, 'utf8')).toBe(before.child);
    expect(f.registry.applyCount).toBe(before.applies);
    expect(await stateOf(f.agentDir, p.operationId)).toBe('committed');
  });

  it('stops recovery on a mid-open lock loss without writing the journal', async () => {
    const f = await fixture();
    const ok = new SessionProjectTransferOwner({
      agentDir: f.agentDir,
      ports: {
        ...f.ports(lossyLease(() => false).port),
        writers: Object.assign(Object.create(Object.getPrototypeOf(f.writers)) as FakeWriters, f.writers, {
          open: async () => {
            throw new Error('runtime unavailable');
          },
        }),
      },
    });
    const p = await preview(f, ok);
    expect((await ok.commit(commitInput(p))).status).toBe('committed-needs-open');
    const committedMain = await readFile(f.mainPath, 'utf8');
    const applies = f.registry.applyCount;

    const lease = lossyLease((n) => n === 1);
    const recovery = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port) });
    await recovery.recoverAll();
    // Neither the committed fact nor the files changed without ownership.
    expect(await stateOf(f.agentDir, p.operationId)).toBe('committed');
    expect(await readFile(f.mainPath, 'utf8')).toBe(committedMain);
    expect(f.registry.applyCount).toBe(applies);
    expect(f.writers.opened).toEqual([]);
  });

  it('never deletes a journal whose preparation is still in flight in another owner', async () => {
    const f = await fixture();
    // In-memory cross-owner coordinator: a second owner cannot take a path that
    // the first still holds (this is what proper-lockfile gives across processes).
    const held = new Map<string, string>();
    const coordinator: TransferLeasePort = {
      async acquire(paths, options) {
        const owner = options?.owner ?? 'anonymous';
        const normalized = paths.map((path) => path.toLowerCase().split(String.fromCharCode(92)).join('/'));
        for (const key of normalized) {
          const current = held.get(key);
          if (current !== undefined && current !== owner) {
            throw new Error('SESSION_OPERATION_LEASE_BUSY');
          }
        }
        for (const key of normalized) held.set(key, owner);
        return {
          async assertOwned() {
            for (const key of normalized) {
              if (held.get(key) !== owner) throw new Error('lock lost');
            }
          },
          async release() {
            for (const key of normalized) if (held.get(key) === owner) held.delete(key);
          },
        };
      },
    };

    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let sawPreparing!: () => void;
    const preparing = new Promise<void>((resolve) => {
      sawPreparing = resolve;
    });
    const slow = new SessionProjectTransferOwner({
      agentDir: f.agentDir,
      ports: { ...f.ports(coordinator) },
      faults: async (point) => {
        if (point !== 'manifest:prepared:write-temp') return;
        sawPreparing();
        await prepareGate;
      },
    });
    const previewAck = await preview(f, slow);
    const slowCommit = slow
      .commit(commitInput(previewAck))
      .catch((error: unknown) => error as Error);

    await preparing;
    const journalDir = join(f.agentDir, 'session-transfers', previewAck.operationId);
    // The writer is mid-preparation: snapshots exist, the manifest does not yet.
    expect(await readFile(join(journalDir, 'before.json'), 'utf8').catch(() => undefined)).toBeTruthy();

    // A competing owner in the same process must not delete the live preparation.
    const competing = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(coordinator) });
    await competing.recoverAll();
    expect(await readFile(join(journalDir, 'before.json'), 'utf8').catch(() => undefined)).toBeTruthy();

    releasePrepare();
    const result = await slowCommit;
    expect(result).toMatchObject({ status: 'opened' });
    expect(await stateOf(f.agentDir, previewAck.operationId)).toBe('opened');
    expect(f.registry.applyCount).toBe(1);
  });

  it('discards a genuinely abandoned partial journal once the prepare sentinel is free', async () => {
    const f = await fixture();
    const operationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const journalDir = join(f.agentDir, 'session-transfers', operationId);
    await mkdir(journalDir, { recursive: true });
    // A crash after before/after were written but before the manifest rename.
    await writeFile(join(journalDir, 'before.json'), JSON.stringify({ version: 1, files: [] }), 'utf8');
    await writeFile(join(journalDir, 'after.json'), JSON.stringify({ version: 1, files: [] }), 'utf8');
    expect(await readFile(join(journalDir, 'before.json'), 'utf8').catch(() => undefined)).toBeTruthy();

    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lossyLease(() => false).port) });
    await owner.recoverAll();
    // No live holder: the shell is removed so it can never resurrect as a half-move.
    expect(await readFile(join(journalDir, 'before.json'), 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await owner.blockedFamilies()).toEqual([]);
    await expect(readFile(f.mainPath, 'utf8')).resolves.toBe(f.mainText);
  });

  it('reports the loss to the caller as a recovery-required error', async () => {
    const f = await fixture();
    const lease = lossyLease((n) => n === 1);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port) });
    const p = await preview(f, owner);
    await expect(owner.commit(commitInput(p))).rejects.toMatchObject({
      code: 'TRANSFER_RECOVERY_REQUIRED',
      operationId: p.operationId,
    });
    // The family still blocks send/delete until a rightful owner recovers it.
    expect(await readFile(f.mainPath, 'utf8')).toBe(f.mainText);
  });

  it('holds and releases a compatible lease handle exactly once on success', async () => {
    const f = await fixture();
    const lease = lossyLease(() => false);
    const owner = new SessionProjectTransferOwner({ agentDir: f.agentDir, ports: f.ports(lease.port) });
    const p = await preview(f, owner);
    expect((await owner.commit(commitInput(p))).status).toBe('opened');
    // Family lease + the per-operation preparation sentinel.
    expect(lease.state.acquired).toBe(2);
    expect(lease.state.released).toBe(2);
    expect(lease.state.assertions).toBeGreaterThanOrEqual(4);
    expect(lease.state.lost).toBe(false);
  });

  it('exposes the lease-lost error type to adapters', () => {
    expect(new TransferLeaseLostError('x').code).toBe('TRANSFER_LEASE_LOST');
  });
});
