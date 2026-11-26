import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { strictSessionJsonl } from './sessionWorkflowData.js';
import { buildTransferredSession, readTransferSession, readTransfersFromRaw, transferredSubagentMeta } from './sessionProjectTransferHistory.js';
import {
  buildEntryRootProvenance,
  effectiveProjectRoot,
  effectiveRecordedCwd,
  historyTransferSources,
  isTransferredSession,
  readLatestTransferNotice,
} from '../../../extensions/_shared/session-project-transfer.js';

const SOURCE = 'D:/proj/source';
const TARGET = 'D:/proj/target';
const THIRD = 'D:/proj/third';
const SCRATCH = 'D:/scratch/conversation-one';

/** 平台路径归一：Windows 的 realpath 可能把分隔符写成反斜杠。 */
const normalizeRoot = (value: string): string => value.split('\\').join('/');

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantMeta = { api: 'openai-completions', provider: 'fixture', model: 'model', usage, stopReason: 'stop' };

const OPS = {
  base: 'op-11111111-1111-4111-8111-111111111111',
  nullRoot: 'op-22222222-2222-4222-8222-222222222222',
  deterministic: 'op-44444444-4444-4444-8444-444444444444',
  idempotent: 'op-55555555-5555-4555-8555-555555555555',
  child: 'op-66666666-6666-4666-8666-666666666666',
  retention: 'op-77777777-7777-4777-8777-777777777777',
  retentionAgain: 'op-88888888-8888-4888-8888-888888888888',
  legacy: 'op-99999999-9999-4999-8999-999999999999',
  unknownVersion: 'op-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  provenance: 'op-bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  provenanceAgain: 'op-ccccccc1-cccc-4ccc-8ccc-ccccccccccc1',
  reopen: 'op-ddddddd1-dddd-4ddd-8ddd-ddddddddddd1',
};

function text(manager: SessionManager, role: 'user' | 'assistant', content: string, timestamp: number): string {
  if (role === 'user') return manager.appendMessage({ role, content, timestamp } as never);
  return manager.appendMessage({ ...assistantMeta, role, content, timestamp } as never);
}

function toolTurn(
  manager: SessionManager,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
  details: Record<string, unknown> | undefined,
  timestamp: number,
): { call: string; result: string } {
  const call = manager.appendMessage({
    ...assistantMeta,
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: toolName, arguments: args }],
    timestamp,
  } as never);
  const result = manager.appendMessage({
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text: `${toolName} done` }],
    ...(details ? { details } : {}),
    isError: false,
    timestamp: timestamp + 1,
  } as never);
  return { call, result };
}

function rawOf(manager: SessionManager): string {
  return [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function writeTemp(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-transfer-title-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, raw, 'utf8');
  return path;
}

function entriesOf(raw: string): Array<Record<string, unknown>> {
  return strictSessionJsonl(raw).entries as unknown as Array<Record<string, unknown>>;
}

function fixture() {
  const manager = SessionManager.inMemory(SOURCE);
  const rootUser = text(manager, 'user', 'root question', 1);
  const rootAnswer = manager.appendMessage({
    ...assistantMeta,
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'sig-1' },
      { type: 'text', text: 'answer A' },
    ],
    timestamp: 2,
  } as never);
  // 分支 A：项目内写入 → cd 到临时目录 → present 那边的相对路径。
  const aWrite = toolTurn(manager, 'call-a-write', 'write', { path: 'src/a.ts', content: 'a' }, undefined, 3);
  const aCd = toolTurn(manager, 'call-a-cd', 'working_directory', { cd: SCRATCH }, { cwd: SCRATCH, previous: SOURCE, changed: true, original: SOURCE }, 5);
  const aPresent = toolTurn(manager, 'call-a-present', 'present', { files: [{ path: 'docs/report.md' }] }, { files: [{ path: 'docs/report.md' }] }, 7);
  const label = manager.appendLabelChange(aWrite.call, 'reviewed');
  // 分支 B：从同一个 root 分出，未 cd 就读相对文件，之后才 cd。
  manager.branch(rootAnswer);
  const bRead = toolTurn(manager, 'call-b-read', 'read', { path: 'src/config.ts' }, undefined, 10);
  const bCd = toolTurn(manager, 'call-b-cd', 'working_directory', { cd: '/elsewhere/b' }, { cwd: '/elsewhere/b', previous: SOURCE, changed: true }, 12);
  const bAnswer = manager.appendMessage({
    ...assistantMeta, role: 'assistant', content: [{ type: 'text', text: 'B done' }], timestamp: 14, futureField: { keep: true },
  } as never);
  manager.appendCompaction('B summary', rootAnswer, 500);
  return { manager, ids: { rootUser, rootAnswer, aWrite: aWrite.call, aPresent: aPresent.call, aCd: aCd.call, label, bRead: bRead.call, bCd: bCd.call, bAnswer } };
}

type Fixture = ReturnType<typeof fixture>;

function transfer(f: Fixture, overrides: Partial<Parameters<typeof buildTransferredSession>[1]> = {}) {
  return buildTransferredSession(rawOf(f.manager), {
    operationId: OPS.base,
    fromWorkspace: SOURCE,
    toWorkspace: TARGET,
    leafId: f.ids.aPresent,
    now: Date.UTC(2026, 10, 17, 1, 2, 3),
    ...overrides,
  });
}

describe('buildTransferredSession', () => {
  it('keeps every original line and id, only rewrites header cwd, and appends versioned facts', () => {
    const f = fixture();
    const before = rawOf(f.manager);
    const beforeEntries = entriesOf(before);
    const result = transfer(f);

    expect(result.alreadyApplied).toBe(false);
    expect(result.leafId).toBe(f.ids.aPresent);
    expect(result.header.cwd).toBe(TARGET);
    // ID、header 时间戳、父会话字段保持稳定。
    expect(result.header.id).toBe(f.manager.getHeader()!.id);
    expect(result.header.timestamp).toBe(f.manager.getHeader()!.timestamp);
    expect(result.header.parentSession).toBe(f.manager.getHeader()!.parentSession);

    // 原历史行逐字节保留（含标签、压缩、思考签名、未知字段与两条旁支）。
    const afterLines = result.raw.split('\n').filter(Boolean).slice(1);
    const beforeLines = before.split('\n').filter(Boolean).slice(1);
    expect(afterLines.slice(0, beforeLines.length)).toEqual(beforeLines);
    expect(afterLines.length).toBe(beforeLines.length + 2);
    expect(result.raw).toContain('sig-1');
    expect(result.raw).toContain('"futureField":{"keep":true}');

    // 严格校验通过，原始条目 id / 父链不变。
    const after = entriesOf(result.raw);
    expect(after.slice(0, beforeEntries.length).map((entry) => entry.id))
      .toEqual(beforeEntries.map((entry) => entry.id));
    expect(after.filter((entry) => entry.type === 'label')).toHaveLength(1);
    expect(after.filter((entry) => entry.type === 'compaction')).toHaveLength(1);

    // 新增条目只有迁移事实、目标 cwd 和（有偏好时）偏好；metadata 不冒充确认 leaf。
    const appended = after.slice(beforeEntries.length);
    expect(appended.map((entry) => (entry.type === 'custom' ? entry.customType : entry.type)))
      .toEqual(['session_project_transfer', 'working_directory']);
    expect(result.appendedEntryIds).toHaveLength(2);
    expect(appended[0]!.id).toBe(result.appendedEntryIds[0]);
    expect(result.metadata.leafId).toBe(f.ids.aPresent);
    expect(result.metadata.boundary.afterEntryId).toBe(beforeEntries.at(-1)!.id);
    expect(result.metadata.boundary.entryCount).toBe(beforeEntries.length);
    // 批次边界包含追加后的条目数：metadata 的 leaf/边界不随追加行漂移。
    expect(result.metadata.boundary.entryCountAfter).toBe(after.length);
    expect(normalizeRoot(result.metadata.previousCwd)).toBe(SOURCE);
    expect((result.metadata.retentionRoots ?? []).map(normalizeRoot)).toContain(SOURCE);
  });

  it('restores the confirmed leaf through a real SDK open instead of the appended entry', () => {
    const f = fixture();
    const result = transfer(f);
    const dir = mkdtempSync(join(tmpdir(), 'session-transfer-history-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, result.raw, 'utf8');

    const cold = SessionManager.open(path);
    // 物理最后一条是追加的迁移记录；确认 leaf 必须来自位置存储。
    expect(cold.getLeafId()).toBe(result.appendedEntryIds.at(-1));
    cold.branch(f.ids.aPresent);
    expect(cold.getLeafId()).toBe(f.ids.aPresent);
    expect(cold.buildSessionProjection().messages.length).toBeGreaterThan(0);
  });

  it('supports a null-root confirmation without inventing a leaf', () => {
    const f = fixture();
    const result = transfer(f, { operationId: OPS.nullRoot, leafId: null });
    expect(result.leafId).toBeNull();
    expect(result.metadata.leafId).toBeNull();
    expect(entriesOf(result.raw).every((entry) => entry.type !== 'context_edit')).toBe(true);
  });

  it('rejects unknown leaves and same-workspace input before producing an image', () => {
    const f = fixture();
    expect(() => transfer(f, { operationId: 'op-3', leafId: 'missing-entry' })).toThrow(/LEAF/);
    expect(() => transfer(f, { operationId: 'op-3', toWorkspace: SOURCE })).toThrow(/SAME_WORKSPACE/);
    expect(() => transfer(f, { operationId: '' })).toThrow(/OPERATION_ID/);
  });

  it('is deterministic for a retried operation with the same before image', () => {
    const f = fixture();
    const base = rawOf(f.manager);
    const input = { operationId: OPS.deterministic, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null, now: 1000 };
    const one = buildTransferredSession(base, input);
    const two = buildTransferredSession(base, input);
    expect(two.raw).toBe(one.raw);
    expect(one.appendedEntryIds.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it('is idempotent when the operation marker is already present', () => {
    const f = fixture();
    const input = { operationId: OPS.idempotent, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null };
    const first = buildTransferredSession(rawOf(f.manager), input);
    const again = buildTransferredSession(first.raw, input);
    expect(again.alreadyApplied).toBe(true);
    expect(again.raw).toBe(first.raw);
    expect(again.appendedEntryIds).toEqual([]);
    expect(readTransfersFromRaw(again.raw)).toHaveLength(1);
  });

  it('appends a target subagent_meta for child sessions without dropping previous fields', () => {
    const manager = SessionManager.inMemory('/proj/source/sub');
    manager.appendCustomEntry('subagent_meta', {
      origin: 'subagent', agentId: 'agent-1', parentSession: '/sessions/main.jsonl', parentSessionId: 'p1',
      mode: 'continuable', depth: 1, backend: 'in-process', routingMode: 'ordinary', label: 'child',
      workspace: '/proj/source/sub', cwd: '/proj/source/sub/nested',
    });
    text(manager, 'user', 'child work', 1);
    const result = buildTransferredSession(rawOf(manager), {
      operationId: OPS.child, fromWorkspace: '/proj/source/sub', toWorkspace: TARGET, leafId: null,
    });
    const appended = entriesOf(result.raw).at(-1)!;
    expect(appended.customType).toBe('subagent_meta');
    expect(appended.data).toMatchObject({
      agentId: 'agent-1',
      parentSession: '/sessions/main.jsonl',
      parentSessionId: 'p1',
      mode: 'continuable',
      depth: 1,
      backend: 'in-process',
      routingMode: 'ordinary',
      workspace: TARGET,
      cwd: TARGET,
    });
    // 旧 meta 行仍在，历史可读。
    expect(result.raw).toContain('"agentId":"agent-1"');
    expect(transferredSubagentMeta({ agentId: 'x', tornDown: true }, TARGET)).toEqual({ agentId: 'x', tornDown: true, workspace: TARGET });
  });

  it('accumulates retention roots across repeated transfers instead of overwriting them', () => {
    const f = fixture();
    const first = transfer(f, { operationId: OPS.retention, leafId: null, retentionRoots: [SCRATCH] });
    const roots = (first.metadata.retentionRoots ?? []).map(normalizeRoot);
    // 显式保留根、源项目、以及历史里 working_directory 去过的每个目录（这里包含分支 B 的 /elsewhere/b）。
    expect(roots.slice(0, 3)).toEqual([SCRATCH, SOURCE, '/elsewhere/b']);
    expect(roots).toContain(SOURCE);
    const second = buildTransferredSession(first.raw, {
      operationId: OPS.retentionAgain, fromWorkspace: TARGET, toWorkspace: THIRD, leafId: null,
    });
    const again = (second.metadata.retentionRoots ?? []).map(normalizeRoot);
    for (const root of roots) expect(again).toContain(root);
    expect(again).toContain(TARGET);
  });

  it('preserves a CRLF log byte-for-byte and appends CRLF rows', () => {
    const f = fixture();
    // 用 charCode 拼 CRLF，避免编辑器/工具链把测试源码里的转义改写成真实换行。
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const crlf = rawOf(f.manager).split(lf).join(cr + lf);
    const result = buildTransferredSession(crlf, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    });
    const rows = result.raw.split(cr + lf).filter(Boolean);
    const original = crlf.split(cr + lf).filter(Boolean).slice(1);
    expect(rows.length).toBe(original.length + 3); // header + 原历史 + 2 追加
    expect(rows.slice(1, 1 + original.length)).toEqual(original);
    expect(result.raw.includes(cr + lf)).toBe(true);
    expect(result.raw.includes(lf + cr)).toBe(false);
    expect(strictSessionJsonl(result.raw).entries.length).toBe(original.length + 2);
  });

  it('migrates legacy v2 input into an explicit v3 after-image and keeps unknown custom fields', () => {
    const manager = SessionManager.inMemory(SOURCE);
    manager.appendCustomEntry('office_custom', { keep: [1, 2, 3] });
    const raw = rawOf(manager).replace('"version":3', '"version":2');
    const result = buildTransferredSession(raw, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    });
    const doc = strictSessionJsonl(result.raw);
    expect(doc.header.version).toBe(3);
    expect(doc.header.cwd).toBe(TARGET);
    expect(doc.entries.some((entry) => entry.type === 'custom' && entry.customType === 'office_custom')).toBe(true);
  });

  it('accepts the legacy id-less title line, keeps it byte-exact, and keeps the latest title on the target', () => {
    const f = fixture();
    const title = JSON.stringify({ type: 'session_info', name: 'manual title' });
    const withTitle = rawOf(f.manager) + title + '\n';
    // 迁移专用 parser 接受它，但不把它当成树条目。
    const doc = readTransferSession(withTitle);
    expect(doc.opaque).toEqual([title]);
    expect(doc.entries.every((entry) => typeof entry.id === 'string')).toBe(true);

    const result2 = buildTransferredSession(withTitle, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    });
    // 原行原字节保留在目标 after-image 中，标题仍是最新一条。
    expect(result2.raw).toContain(title + '\n');
    const cold = SessionManager.open(writeTemp(result2.raw));
    expect(cold.getSessionName()).toBe('manual title');
    expect(cold.getEntry(result2.appendedEntryIds[0])).toBeDefined();
  });

  it('rejects an id-less line that is not exactly the legacy title shape', () => {
    const f = fixture();
    const bad = rawOf(f.manager) + JSON.stringify({ type: 'session_info', name: 'x', extra: 1 }) + '\n';
    expect(() => readTransferSession(bad)).toThrow(/missing an id/);
    expect(() => buildTransferredSession(bad, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    })).toThrow(/missing an id/);
  });

  it('synthesizes deterministic ids and parent links for v1 input without touching the source', () => {
    const manager = SessionManager.inMemory(SOURCE);
    manager.appendMessage({ role: 'user', content: 'legacy v1 prompt', timestamp: 1 } as never);
    manager.appendMessage({ ...assistantMeta, role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2 } as never);
    const v3 = rawOf(manager);
    const nl = String.fromCharCode(10);
    const header = JSON.parse(v3.split(nl)[0]!) as Record<string, unknown>;
    const rows = v3.split(nl).filter(Boolean).slice(1).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row.id;
      delete row.parentId;
      return row;
    });
    const v1 = [JSON.stringify({ ...header, version: 1 }), ...rows.map((row) => JSON.stringify(row))].join(nl) + nl;

    const first = readTransferSession(v1);
    const second = readTransferSession(v1);
    expect(first.synthesizedIds).toBe(true);
    expect(first.version).toBe(1);
    expect(first.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
    expect(first.entries[0]!.parentId).toBeNull();
    expect(first.entries[1]!.parentId).toBe(first.entries[0]!.id);

    const result = buildTransferredSession(v1, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    });
    const after = strictSessionJsonl(result.raw);
    expect(after.header.version).toBe(3);
    expect(after.header.cwd).toBe(TARGET);
    expect(after.header.id).toBe(header.id);
    expect(after.entries[0]!.id).toBe(first.entries[0]!.id);
    expect(JSON.stringify(after.entries[0])).toContain('legacy v1 prompt');
    // 源 raw 未被修改。
    expect(v1).toContain('"version":1');
  });

  it('keeps v2 hookMessage content while normalizing it to the v3 custom role', () => {
    const nl = String.fromCharCode(10);
    const header = { type: 'session', version: 2, id: 'legacy-v2', timestamp: '2026-01-01T00:00:00.000Z', cwd: SOURCE };
    const rows = [
      { type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'hookMessage', customType: 'notice', content: 'hook text', display: true, timestamp: 1 } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'after hook', timestamp: 2 } },
    ];
    const raw = [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join(nl) + nl;
    const doc = readTransferSession(raw);
    expect(doc.version).toBe(2);
    expect(doc.synthesizedIds).toBe(false);
    expect(doc.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    const hookEntry = doc.entries[0] as unknown as { message: Record<string, unknown> };
    expect(hookEntry.message.role).toBe('custom');

    const result = buildTransferredSession(raw, {
      operationId: OPS.legacy, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: 'b',
    });
    expect(result.raw).toContain('"role":"custom"');
    expect(result.raw).toContain('hook text');
    expect(result.raw).not.toContain('hookMessage');
  });

  it('maps v1 compaction firstKeptEntryIndex through the deterministic ids', () => {
    const rows = [
      { type: 'message', message: { role: 'user', content: 'kept', timestamp: 1 }, timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'message', message: { ...assistantMeta, role: 'assistant', content: [{ type: 'text', text: 'old' }], timestamp: 2 }, timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'compaction', summary: 'sum', firstKeptEntryIndex: 1, tokensBefore: 10, timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    const nl = String.fromCharCode(10);
    const v1 = [JSON.stringify({ type: 'session', version: 1, id: 'legacy-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: SOURCE }),
      ...rows.map((row) => JSON.stringify(row))].join(nl) + nl;
    const doc = readTransferSession(v1);
    expect(doc.entries[2]).toMatchObject({ type: 'compaction', firstKeptEntryId: doc.entries[0]!.id });
    expect(doc.entries[2]).not.toHaveProperty('firstKeptEntryIndex');
  });

  it('ignores unknown migration versions rather than treating them as a transfer', () => {
    const manager = SessionManager.inMemory(SOURCE);
    manager.appendCustomEntry('session_project_transfer', {
      version: 99, operationId: 'x', fromWorkspace: SOURCE, toWorkspace: TARGET,
    });
    const raw = rawOf(manager);
    expect(isTransferredSession(entriesOf(raw))).toBe(false);
    expect(() => buildTransferredSession(raw, {
      operationId: OPS.unknownVersion, fromWorkspace: SOURCE, toWorkspace: TARGET, leafId: null,
    })).not.toThrow();
  });
});

describe('transfer provenance and effective cwd', () => {
  function transferred() {
    const f = fixture();
    const result = transfer(f, { operationId: OPS.provenance, now: 1000 });
    return { f, result, entries: structuredClone(entriesOf(result.raw)) };
  }

  it('keeps each branch on its own directory instead of sharing the last cd', () => {
    const { entries } = transferred();
    const sources = buildEntryRootProvenance(entries, SOURCE);
    const resultEntryOf = (toolCallId: string) => entries.find((entry) => {
      const message = entry.message as Record<string, unknown> | undefined;
      return entry.type === 'message' && message?.role === 'toolResult' && message.toolCallId === toolCallId;
    });
    const refOf = (toolCallId: string, field = 'path') => {
      const entry = resultEntryOf(toolCallId);
      expect(entry, toolCallId).toBeDefined();
      return sources[entry!.id as string]!.refs?.[field];
    };
    // 分支 A：cd 前的 write 属于源项目；cd 后的 present 属于临时目录。
    expect(refOf('call-a-write')).toBe(SOURCE);
    expect(refOf('call-a-present', 'files.0.path')).toBe(SCRATCH);
    // 分支 B：自己没 cd 前的 read 仍是源项目，不继承 A 的最后目录。
    expect(refOf('call-b-read')).toBe(SOURCE);
  });

  it('never lets the old tool cwd pull a reopened session back to the source project', () => {
    const { entries } = transferred();
    expect(effectiveProjectRoot(entries, SOURCE)).toBe(TARGET);
    expect(effectiveRecordedCwd(entries, SOURCE)).toBe(TARGET);
    // 即使位置存储把 leaf 指到历史旁支，恢复 cwd 也不能回到源目录。
    const branchLeaf = entries.find((entry) => entry.id === entries.at(-4)?.id)?.id as string;
    expect(effectiveRecordedCwd(entries, SOURCE, branchLeaf)).toBe(TARGET);
    expect(readLatestTransferNotice(entries)).toMatchObject({ fromWorkspace: SOURCE, toWorkspace: TARGET });
  });

  it('does not borrow a working directory from a sibling branch after the transfer', () => {
    const { entries } = transferred();
    const tail = entries.at(-1)!.id as string;
    // 迁移后先在 A 旁支 cd，再从旧位置另起 B 旁支：B 的 leaf 父链里没有这条 cd。
    const aCd = { type: 'custom', id: 'post-a-cd', parentId: tail, timestamp: '2026-11-17T00:00:00.000Z', customType: 'working_directory', data: { cwd: '/proj/target/a-only' } };
    const aSibling = { type: 'custom', id: 'post-a-sibling', parentId: 'post-a-cd', timestamp: '2026-11-17T00:00:01.000Z', customType: 'context_exclusion', data: { op: 'add', ts: 1 } };
    entries.push(aCd, aSibling);
    // 旧 leaf（迁移前确认位置）恢复时必须是目标根，而不是 A 旁支的 cwd。
    expect(effectiveRecordedCwd(entries, SOURCE, tail)).toBe(TARGET);
    // A 旁支自己的末端仍可读到自己那条 cd。
    expect(effectiveRecordedCwd(entries, SOURCE, 'post-a-sibling')).toBe('/proj/target/a-only');
  });

  it('returns to the target root when a new cd is appended after the transfer', () => {
    const { entries } = transferred();
    const last = entries.at(-1)!.id as string;
    entries.push({
      type: 'custom', id: 'after-cd', parentId: last, timestamp: '2026-11-17T00:00:00.000Z',
      customType: 'working_directory', data: { cwd: '/proj/target/sub' },
    });
    expect(effectiveRecordedCwd(entries, SOURCE, 'after-cd')).toBe('/proj/target/sub');
    expect(effectiveProjectRoot(entries, SOURCE)).toBe(TARGET);
  });

  it('does not rewrite an already mapped reference on a later transfer', () => {
    const { f, result } = transferred();
    const original = buildEntryRootProvenance(entriesOf(result.raw), SOURCE);
    const scratchEntry = Object.entries(original).find(([, source]) => source.root === SCRATCH);
    expect(scratchEntry).toBeDefined();

    const second = buildTransferredSession(result.raw, {
      operationId: OPS.provenanceAgain, fromWorkspace: TARGET, toWorkspace: THIRD,
      leafId: f.ids.aPresent, now: 2000, embedProvenance: true,
    });
    const sources = historyTransferSources(entriesOf(second.raw), TARGET)!;
    expect(sources[scratchEntry![0]]).toEqual(scratchEntry![1]);
    expect(sources[scratchEntry![0]]!.root).toBe(SCRATCH);
  });

  it('rejects contradictory provenance instead of silently keeping the first mapping', () => {
    const f = fixture();
    const first = transfer(f, { operationId: OPS.provenance, embedProvenance: true });
    const tampered = first.raw.replace(
      '"root":"D:/proj/source"',
      '"root":"D:/somewhere/else"',
    );
    expect(tampered).not.toBe(first.raw);
    expect(() => buildTransferredSession(tampered, {
      operationId: OPS.provenanceAgain, fromWorkspace: TARGET, toWorkspace: THIRD, leafId: null,
    })).toThrow(/TRANSFER_PROVENANCE_CONFLICT/);
  });

  it('degrades to no provenance for sessions without transfers', () => {
    const manager = SessionManager.inMemory(SOURCE);
    text(manager, 'user', 'plain', 1);
    const entries = entriesOf(rawOf(manager));
    expect(historyTransferSources(entries, SOURCE)).toBeUndefined();
    expect(isTransferredSession(entries)).toBe(false);
    expect(effectiveProjectRoot(entries, SOURCE)).toBe(SOURCE);
  });
});
