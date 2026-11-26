import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionProjectTransferOwner, type TransferPorts } from './sessionProjectTransfer.js';
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

import type { TransferPreviewAck } from './sessionProjectTransfer.js';

function familyMembers(preview: TransferPreviewAck) {
  return preview.familyMembers ?? [];
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Setup {
  root: string;
  agentDir: string;
  sessionsRoot: string;
  source: string;
  target: string;
  other: string;
  mainPath: string;
  mainId: string;
  registry: FakeRegistry;
  writers: FakeWriters;
  activity: FakeActivity;
  owner: SessionProjectTransferOwner;
  ports: TransferPorts;
  mainText: string;
}

async function setup(options: {
  children?: Array<{ id: string; mode: 'one-shot' | 'continuable'; extraRows?: number }>;
  mainLines?: (paths: { childPath: (id: string) => string }) => Array<Record<string, unknown>>;
  registryRows?: (paths: { childPath: (id: string) => string }) => ReturnType<typeof row>[];
  targetRows?: ReturnType<typeof row>[];
} = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'session-transfer-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const sessionsRoot = join(agentDir, 'sessions');
  const source = join(root, 'projects', 'source');
  const target = join(root, 'projects', 'target');
  const other = join(root, 'projects', 'other');
  await Promise.all([mkdir(sessionsRoot, { recursive: true }), mkdir(source, { recursive: true }), mkdir(target, { recursive: true }), mkdir(other, { recursive: true })]);
  const mainId = 'session-main';
  const mainPath = join(sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_session-main.jsonl');
  const childPath = (id: string): string => join(sessionsRoot, '--source--', `2026-11-17T00-00-00-000Z_${id}.jsonl`);

  const children = options.children ?? [{ id: 'sa-1', mode: 'one-shot' as const }];
  for (const child of children) {
    const lines = [
      header(child.id, source, { parentSession: mainPath }),
      entry(`${child.id}-m1`, null),
      subagentMeta(`${child.id}-meta`, `${child.id}-m1`, {
        origin: 'subagent',
        agentId: child.id,
        parentSession: mainPath,
        parentSessionId: mainId,
        mode: child.mode,
        depth: 1,
      }),
    ];
    await writeFixture({ path: childPath(child.id), lines });
  }

  const mainLines = [
    header(mainId, source),
    entry('m1', null),
    ...children.map((child, index) => catalog(`cat-${index}`, 'm1', child.id, childPath(child.id), child.mode)),
    ...(options.mainLines?.({ childPath }) ?? []),
  ];
  await writeFixture({ path: mainPath, lines: mainLines });
  const mainText = sessionText(mainLines[0], mainLines.slice(1));

  const baseRows = options.registryRows?.({ childPath }) ?? children.map((child) =>
    row(child.id, {
      sessionPath: childPath(child.id),
      parentId: mainId,
      status: 'done',
    }),
  );
  // A big unrelated project history: the owner must read all rows but only move the family.
  const unrelated = Array.from({ length: 120 }, (_, index) => row(`other-${index}`, { sessionPath: join(source, `s-${index}.jsonl`), parentId: 'session-other' }));
  const registry = new FakeRegistry(
    registryRowsMap({
      [source]: [...baseRows, ...unrelated],
      [target]: options.targetRows ?? [],
      [other]: [],
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
  const owner = new SessionProjectTransferOwner({ agentDir, ports });
  return { root, agentDir, sessionsRoot, source, target, other, mainPath, mainId, registry, writers, activity, owner, ports, mainText };
}

async function previewOk(owner: SessionProjectTransferOwner, fixture: Setup) {
  const result = await owner.preview({
    sourceWorkspace: fixture.source,
    sessionPath: fixture.mainPath,
    targetWorkspace: fixture.target,
  });
  if (result.status !== 'preview') throw new Error(`expected preview, got ${result.status}`);
  return result;
}

function commitFor(preview: Awaited<ReturnType<typeof previewOk>>) {
  return {
    operationId: preview.operationId,
    ticket: preview.ticket,
    expectedSessionId: preview.sessionId,
    expectedLeafId: preview.leafId,
    expectedRevision: preview.revision,
  };
}

describe('session project transfer preview', () => {
  it('closes over the full log and every registry row, not only the visible catalog', async () => {
    const fixture = await setup({
      children: [
        { id: 'sa-1', mode: 'continuable' },
        { id: 'sa-2', mode: 'one-shot' },
      ],
      mainLines: () => [
        // A grandchild only reachable through the child's own registry row.
        entry('m2', 'm1'),
      ],
      registryRows: ({ childPath }) => [
        row('sa-1', { sessionPath: childPath('sa-1'), parentId: 'session-main', status: 'done' }),
        row('sa-2', { sessionPath: childPath('sa-2'), parentId: 'session-main', status: 'done' }),
        row('sa-3', { sessionPath: childPath('sa-3'), parentId: 'sa-1', status: 'done' }),
      ],
    });
    // sa-3 exists on disk but is only linked through sa-1's registry row.
    await writeFixture({
      path: join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-3.jsonl'),
      lines: [
        header('sa-3', fixture.source, { parentSession: join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-1.jsonl') }),
        entry('sa-3-m1', null),
        subagentMeta('sa-3-meta', 'sa-3-m1', {
          origin: 'subagent',
          agentId: 'sa-3',
          parentSession: join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-1.jsonl'),
          parentSessionId: 'sa-1',
          mode: 'one-shot',
          depth: 2,
        }),
      ],
    });

    const preview = await previewOk(fixture.owner, fixture);
    expect(preview.sessionId).toBe('session-main');
    expect(preview.leafId).toBe('m1');
    expect(familyMembers(preview).map((member) => member.sessionId).sort()).toEqual(['sa-1', 'sa-2', 'sa-3', 'session-main']);
    expect(preview.family.childSessionCount).toBe(3);
    expect(preview.family.registryRecordCount).toBe(3);
    // 120 unrelated rows in the same project are never part of the family.
    expect(preview.family.registryRecordCount).toBeLessThan(120);
    expect(preview.policy).toEqual({ fileTransfer: 'none', modelRequests: 0, permissionSource: 'target' });
  });

  it('treats a realpath-equivalent target as no-op without writing anything', async () => {
    const fixture = await setup();
    const alias = join(fixture.root, 'source-alias');
    await symlink(fixture.source, alias, 'junction').catch(async () => {
      await mkdir(alias, { recursive: true });
      await writeFile(join(alias, 'keep.txt'), 'x');
    });
    const result = await fixture.owner.preview({
      sourceWorkspace: fixture.source,
      sessionPath: fixture.mainPath,
      targetWorkspace: alias,
    });
    if (result.status !== 'no-op') {
      // On platforms without symlink privileges the alias is a distinct directory.
      expect(result.status).toBe('preview');
      return;
    }
    expect(result.reason).toBe('same-workspace');
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
    expect(await readFile(fixture.mainPath, 'utf8')).toBe(fixture.mainText);
  });

  it('rejects missing, non-directory and internal app-data targets without creating them', async () => {
    const fixture = await setup();
    const missing = join(fixture.root, 'not-there');
    await expect(
      fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: fixture.mainPath, targetWorkspace: missing }),
    ).rejects.toThrow(/TARGET_INVALID/);
    expect(existsSync(missing)).toBe(false);

    const file = join(fixture.root, 'file.txt');
    await writeFile(file, 'x');
    await expect(
      fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: fixture.mainPath, targetWorkspace: file }),
    ).rejects.toThrow(/不是目录|TARGET_INVALID/);

    for (const internal of [join(fixture.agentDir, 'works'), join(fixture.agentDir, 'sessions'), fixture.agentDir]) {
      await mkdir(internal, { recursive: true });
      await expect(
        fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: fixture.mainPath, targetWorkspace: internal }),
      ).rejects.toThrow(/内部数据目录/);
    }
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
  });

  it('rejects sessions outside the managed root, symlinked session files and broken headers', async () => {
    const fixture = await setup();
    const outside = join(fixture.root, 'outside.jsonl');
    await writeFile(outside, sessionText(header('outside', fixture.source), [entry('x', null)]));
    await expect(
      fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: outside, targetWorkspace: fixture.target }),
    ).rejects.toThrow(/OUT_OF_BOUNDS/);

    const linked = join(fixture.sessionsRoot, '--source--', 'linked.jsonl');
    await symlink(fixture.mainPath, linked).catch(() => undefined);
    if (existsSync(linked)) {
      await expect(
        fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: linked, targetWorkspace: fixture.target }),
      ).rejects.toThrow(/SYMLINK|OUT_OF_BOUNDS/);
    }

    const badHead = join(fixture.sessionsRoot, '--source--', 'bad.jsonl');
    await writeFile(badHead, '{"type":"session","id":\n');
    await expect(
      fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: badHead, targetWorkspace: fixture.target }),
    ).rejects.toThrow(/BAD_HEADER/);

    const wrongWorkspace = join(fixture.sessionsRoot, '--source--', 'wrong.jsonl');
    await writeFile(wrongWorkspace, sessionText(header('wrong', fixture.other), [entry('x', null)]));
    await expect(
      fixture.owner.preview({ sourceWorkspace: fixture.source, sessionPath: wrongWorkspace, targetWorkspace: fixture.target }),
    ).rejects.toThrow(/WORKSPACE_MISMATCH/);
  });

  it('leaves a fork/clone-derived sibling main session in its own project', async () => {
    const forkPath = join('--source--', '2026-11-17T00-00-00-000Z_session-fork.jsonl');
    const fixture = await setup({
      children: [],
      mainLines: () => [entry('m2', 'm1')],
      registryRows: () => [],
    });
    // A visible main session that merely records parentSession (SDK fork/clone).
    const forkAbs = join(fixture.sessionsRoot, forkPath);
    await writeFixture({ path: forkAbs, lines: [header('session-fork', fixture.source, { parentSession: fixture.mainPath }), entry('f1', null)] });

    const preview = await previewOk(fixture.owner, fixture);
    expect(familyMembers(preview).map((member) => member.sessionId)).toEqual(['session-main']);

    // The forked main may itself move, but it never drags the original session in.
    const own = await fixture.owner.preview({
      sourceWorkspace: fixture.source,
      sessionPath: forkAbs,
      targetWorkspace: fixture.target,
    });
    expect(own.status).toBe('preview');
    if (own.status === 'preview') {
      expect(familyMembers(own).map((member) => member.sessionId)).toEqual(['session-fork']);
      expect(own.warnings).toContain('root-has-parent');
    }
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
  });

  it('discovers a metadata-only child and grandchild that catalog and registry both lost', async () => {
    const fixture = await setup({ children: [], registryRows: () => [] });
    const eol = String.fromCharCode(10);
    const childPath = join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-meta.jsonl');
    const grandPath = join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-meta-2.jsonl');
    await writeFixture({
      path: childPath,
      lines: [
        header('sa-meta', fixture.source, { parentSession: fixture.mainPath }),
        entry('c1', null),
        subagentMeta('c-meta', 'c1', {
          origin: 'subagent',
          agentId: 'sa-meta',
          parentSession: fixture.mainPath,
          parentSessionId: 'session-main',
          mode: 'continuable',
          depth: 1,
        }),
      ],
    });
    await writeFixture({
      path: grandPath,
      lines: [
        header('sa-meta-2', fixture.source, { parentSession: childPath }),
        entry('g1', null),
        subagentMeta('g-meta', 'g1', {
          origin: 'subagent',
          agentId: 'sa-meta-2',
          parentSession: childPath,
          parentSessionId: 'sa-meta',
          mode: 'one-shot',
          depth: 2,
        }),
      ],
    });

    const preview = await previewOk(fixture.owner, fixture);
    const ids = familyMembers(preview).map((member) => member.sessionId).sort();
    expect(ids).toEqual(['sa-meta', 'sa-meta-2', 'session-main']);
    expect(preview.family.childSessionCount).toBe(2);
    // The lineage is preserved for the grandchild.
    const members = familyMembers(preview);
    expect(members.find((member) => member.sessionId === 'sa-meta-2')?.parentSessionPath).toBe(childPath);
  });

  it('refuses a metadata child whose settlement cannot be proven instead of dropping it', async () => {
    const fixture = await setup({
      children: [],
      registryRows: () => [row('sa-unknown', { sessionPath: null, parentId: 'session-main', status: 'running' })],
    });
    const childPath = join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_sa-unknown.jsonl');
    await writeFixture({
      path: childPath,
      lines: [
        header('sa-unknown', fixture.source, { parentSession: fixture.mainPath }),
        entry('u1', null),
        subagentMeta('u-meta', 'u1', {
          origin: 'subagent',
          agentId: 'sa-unknown',
          parentSession: fixture.mainPath,
          parentSessionId: 'session-main',
          mode: 'weird-mode',
          depth: 1,
        }),
      ],
    });
    await expect(previewOk(fixture.owner, fixture)).rejects.toThrow(/UNSETTLED|UNPROVEN|尚未结算/);
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
  });

  it('does not pull a header-only fork sibling in through metadata discovery', async () => {
    const fixture = await setup({ children: [], registryRows: () => [] });
    // Only a header parentSession (SDK fork/clone), no subagent_meta at all.
    const forkPath = join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_session-fork2.jsonl');
    await writeFixture({
      path: forkPath,
      lines: [header('session-fork2', fixture.source, { parentSession: fixture.mainPath }), entry('f1', null)],
    });
    const preview = await previewOk(fixture.owner, fixture);
    expect(familyMembers(preview).map((member) => member.sessionId)).toEqual(['session-main']);
  });

  it('fails closed on a broken child link, a cycle and an unsettled subagent', async () => {
    const broken = await setup({
      children: [],
      mainLines: () => [catalog('cat-x', 'm1', 'sa-x', 'D:/nowhere/sa-x.jsonl')],
      registryRows: () => [],
    });
    await expect(previewOk(broken.owner, broken)).rejects.toThrow();
    expect(existsSync(join(broken.agentDir, 'session-transfers'))).toBe(false);

    const cycle = await setup({
      children: [],
      mainLines: () => [entry('m2', 'm1')],
      registryRows: () => [],
    });
    const a = join(cycle.sessionsRoot, '--source--', 'a.jsonl');
    const b = join(cycle.sessionsRoot, '--source--', 'b.jsonl');
    await writeFixture({
      path: a,
      lines: [
        header('a', cycle.source, { parentSession: b }),
        entry('a1', null),
        subagentMeta('a-meta', 'a1', { agentId: 'a', parentSession: b, parentSessionId: 'b', mode: 'one-shot' }),
      ],
    });
    await writeFixture({
      path: b,
      lines: [
        header('b', cycle.source, { parentSession: a }),
        entry('b1', null),
        subagentMeta('b-meta', 'b1', { agentId: 'b', parentSession: a, parentSessionId: 'a', mode: 'one-shot' }),
      ],
    });
    await writeFile(
      cycle.mainPath,
      sessionText(header('session-main', cycle.source), [entry('m1', null), catalog('c-a', 'm1', 'a', a), catalog('c-b', 'm1', 'b', b)]),
    );
    const cycleRegistry = new FakeRegistry(
      registryRowsMap({
        [cycle.source]: [row('a', { sessionPath: a, parentId: 'b' }), row('b', { sessionPath: b, parentId: 'a' })],
        [cycle.target]: [],
      }),
    );
    const cycleOwner = new SessionProjectTransferOwner({
      agentDir: cycle.agentDir,
      ports: { ...cycle.ports, registry: cycleRegistry },
    });
    await expect(previewOk(cycleOwner, cycle)).rejects.toThrow(/循环|CYCLE|BROKEN_LINK/);

    const unsettled = await setup({
      registryRows: ({ childPath }) => [row('sa-1', { sessionPath: childPath('sa-1'), parentId: 'session-main', status: 'running' })],
    });
    await expect(previewOk(unsettled.owner, unsettled)).rejects.toThrow(/UNSETTLED|尚未结算/);
    expect(existsSync(join(unsettled.agentDir, 'session-transfers'))).toBe(false);
  });

  it('reports busy facts and target registry conflicts as user-facing failures', async () => {
    const fixture = await setup();
    fixture.activity.factsOverride = { hasLiveJobs: true };
    const busy = await fixture.owner.preview({
      sourceWorkspace: fixture.source,
      sessionPath: fixture.mainPath,
      targetWorkspace: fixture.target,
    });
    expect(busy.status).toBe('busy');
    if (busy.status === 'busy') expect(busy.detail).toMatch(/后台任务/);
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);

    const conflict = await setup({
      targetRows: [row('sa-1', { sessionPath: 'D:/elsewhere/sa-1.jsonl', parentId: 'session-other', task: 'different' })],
    });
    await expect(previewOk(conflict.owner, conflict)).rejects.toThrow(/REGISTRY_CONFLICT/);
  });

  it('fails stale when the file or the registry changes at the same size after preview', async () => {
    const fixture = await setup();
    const preview = await previewOk(fixture.owner, fixture);

    // Same byte length, different content: only a whole-file hash can notice.
    const originalText = await readFile(fixture.mainPath, 'utf8');
    const mutated = originalText.replace('text-m1', 'text-M1');
    expect(mutated.length).toBe(originalText.length);
    await writeFile(fixture.mainPath, mutated);

    const stale = await fixture.owner.commit(commitFor(preview));
    expect(stale.status).toBe('stale');
    if (stale.status === 'stale') expect(stale.staleReason).toBe('source-changed');
    expect(await readFile(fixture.mainPath, 'utf8')).toBe(mutated);
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
  });

  it('fails stale when only the registry changes after preview, even at the same row count', async () => {
    const fixture = await setup();
    const preview = await previewOk(fixture.owner, fixture);
    const before = await fixture.registry.read(fixture.source);
    const mutated = before.map((item) => (item.id === 'sa-1' ? { ...item, updatedAt: item.updatedAt + 1 } : item));
    expect(mutated).toHaveLength(before.length);
    const textBefore = await readFile(fixture.mainPath, 'utf8');
    fixture.registry.mutate(fixture.source, mutated);

    const stale = await fixture.owner.commit(commitFor(preview));
    expect(stale.status).toBe('stale');
    if (stale.status === 'stale') expect(stale.staleReason).toBe('registry-changed');
    expect(await readFile(fixture.mainPath, 'utf8')).toBe(textBefore);
    expect(fixture.registry.applyCount).toBe(0);
  });

  it('binds commit to the preview session and expires tickets', async () => {
    const fixture = await setup();
    const preview = await previewOk(fixture.owner, fixture);
    const other = join(fixture.sessionsRoot, '--source--', '2026-11-17T00-00-00-000Z_session-else.jsonl');
    await writeFixture({ path: other, lines: [header('session-else', fixture.source), entry('e1', null)] });
    await expect(
      fixture.owner.commit({ ...commitFor(preview), sourceWorkspace: fixture.source, sessionPath: other }),
    ).rejects.toThrow(/SOURCE_MISMATCH/);

    const expiring = new SessionProjectTransferOwner({
      agentDir: fixture.agentDir,
      ports: fixture.ports,
      ticketTtlMs: 1_000,
      clock: () => Date.now() + 10_000_000,
    });
    const created = await expiring.preview({
      sourceWorkspace: fixture.source,
      sessionPath: fixture.mainPath,
      targetWorkspace: fixture.target,
    });
    if (created.status !== 'preview') throw new Error('expected preview');
    const late = new SessionProjectTransferOwner({
      agentDir: fixture.agentDir,
      ports: fixture.ports,
      ticketTtlMs: 1_000,
      clock: () => created.expiresAt + 1,
    });
    // Different owner instance has no ticket at all: the caller must preview again.
    const missing = await late.commit(commitFor(created));
    expect(missing.status).toBe('stale');
    if (missing.status === 'stale') expect(missing.staleReason).toBe('ticket-unknown');
  });

  it('accepts the legacy title line without an id as opaque metadata', async () => {
    const fixture = await setup();
    const original = await readFile(fixture.mainPath, 'utf8');
    const title = JSON.stringify({ type: 'session_info', name: '改过的标题' });
    await writeFile(fixture.mainPath, `${original}${title}${String.fromCharCode(10)}`);

    const preview = await previewOk(fixture.owner, fixture);
    expect(preview.status).toBe('preview');
    // The title line never becomes a tree member or the leaf.
    expect(familyMembers(preview).map((member) => member.sessionId)).toEqual(['sa-1', 'session-main']);
    expect(preview.leafId).toBe('m1');

    // A move keeps it byte-exact.
    const result = await fixture.owner.commit(commitFor(preview));
    expect(result.status).toBe('opened');
    const after = await readFile(fixture.mainPath, 'utf8');
    expect(after.split(String.fromCharCode(10))).toContain(title);
  });

  it('still rejects an id-less line that is not exactly the legacy title shape', async () => {
    const malformed = [
      { type: 'session_info' },
      { type: 'session_info', name: '' },
      { type: 'session_info', name: 'x', parentId: null },
      { type: 'message', role: 'user', content: 'no id' },
    ];
    for (const line of malformed) {
      const fixture = await setup();
      const original = await readFile(fixture.mainPath, 'utf8');
      await writeFile(fixture.mainPath, `${original}${JSON.stringify(line)}${String.fromCharCode(10)}`);
      await expect(previewOk(fixture.owner, fixture)).rejects.toThrow(/CORRUPT_SESSION|缺少 ID/);
    }
  });

  it('fails closed on an unknown session version instead of guessing its shape', async () => {
    const fixture = await setup();
    const header99 = { ...header('session-main', fixture.source), version: 99 };
    const text = [header99, entry('m1', null)].map((line) => JSON.stringify(line)).join(String.fromCharCode(10));
    await writeFile(fixture.mainPath, `${text}${String.fromCharCode(10)}`);
    await expect(previewOk(fixture.owner, fixture)).rejects.toThrow(/UNKNOWN_VERSION|未知的会话版本/);
    expect(existsSync(join(fixture.agentDir, 'session-transfers'))).toBe(false);
  });

  it('keeps v1 ids stable and derived from the shared canonicalizer, not the SDK random ids', async () => {
    const fixture = await setup();
    const v1 = [
      { type: 'session', version: 1, id: 'session-main', timestamp: '2026-11-17T00:00:00.000Z', cwd: fixture.source },
      { type: 'message', timestamp: '2026-11-17T00:00:00.000Z', id: 'legacy-entry-1', message: { role: 'user', content: 'v1 line', timestamp: 1 } },
    ];
    const text = v1.map((line) => JSON.stringify(line)).join(String.fromCharCode(10));
    await writeFile(fixture.mainPath, `${text}${String.fromCharCode(10)}`);
    const first = await previewOk(fixture.owner, fixture);
    expect(first.sessionId).toBe('session-main');
    // Deterministic: a second preview of the same raw bytes reports the same leaf/paths.
    const second = await previewOk(fixture.owner, fixture);
    expect(second.leafId).toBe(first.leafId);
    // v1 keeps any existing id and derives deterministic ids for the rest; the
    // before-image is still the raw bytes, and the move upgrades the header.
    // The setup's fixture child (catalog + registry) is still in the family.
    expect(familyMembers(first).length).toBe(2);
    const result = await fixture.owner.commit(commitFor(first));
    expect(result.status).toBe('opened');
    const after = await readFile(fixture.mainPath, 'utf8');
    const afterHeader = JSON.parse(after.split(String.fromCharCode(10))[0]) as { id: string; version: number; cwd: string };
    expect(afterHeader.id).toBe('session-main');
    expect(afterHeader.cwd).toBe(await import('node:fs/promises').then((mod) => mod.realpath(fixture.target)));
    // The pre-existing entry id survives the upgrade.
    expect(after).toContain('"id":"legacy-entry-1"');
    expect(familyMembers(second).map((member) => member.sessionPath)).toEqual(familyMembers(first).map((member) => member.sessionPath));
  });


  it('counts an empty main session (null root) without inventing a leaf', async () => {
    const fixture = await setup({ children: [], registryRows: () => [] });
    await writeFixture({ path: fixture.mainPath, lines: [header('session-main', fixture.source)] });
    const ports: TransferPorts = { ...fixture.ports, position: { read: async () => null } };
    const owner = new SessionProjectTransferOwner({ agentDir: fixture.agentDir, ports });
    const preview = await owner.preview({
      sourceWorkspace: fixture.source,
      sessionPath: fixture.mainPath,
      targetWorkspace: fixture.target,
    });
    if (preview.status !== 'preview') throw new Error(`expected preview, got ${preview.status}`);
    expect(preview.leafId).toBeNull();
    expect(preview.family.sessionCount ?? familyMembers(preview).length).toBe(1);
  });

  it('closes over a family larger than any UI list limit', async () => {
    const children = Array.from({ length: 60 }, (_, index) => ({ id: `sa-${index}`, mode: 'one-shot' as const }));
    const fixture = await setup({ children });
    const preview = await previewOk(fixture.owner, fixture);
    expect(preview.family.sessionCount).toBe(61);
    expect(preview.family.childSessionCount).toBe(60);
    expect(preview.family.registryRecordCount).toBe(60);
    expect(new Set(familyMembers(preview).map((member) => member.sessionId)).size).toBe(61);
    // Every child path is in the closure, not just the first 50.
    const paths = familyMembers(preview).map((member) => member.sessionId);
    expect(paths).toContain('sa-0');
    expect(paths).toContain('sa-59');
  });

  it('rejects a family whose registry names a child file that no longer exists', async () => {
    const inline = await setup({
      children: [],
      registryRows: ({ childPath }) => [row('sa-gone', { sessionPath: childPath('sa-gone'), parentId: 'session-main' })],
    });
    await expect(previewOk(inline.owner, inline)).rejects.toThrow(/BROKEN_LINK|缺失|SESSION_MISSING/);
    expect(existsSync(join(inline.agentDir, 'session-transfers'))).toBe(false);
  });

  it('does not report the source directory as a transfer target and keeps other files untouched', async () => {
    const fixture = await setup();
    const preview = await previewOk(fixture.owner, fixture);
    expect(preview.status).toBe('preview');
    const stats = await stat(fixture.mainPath);
    expect(stats.isFile()).toBe(true);
    expect(await readdir(fixture.source)).toEqual([]);
  });
});
