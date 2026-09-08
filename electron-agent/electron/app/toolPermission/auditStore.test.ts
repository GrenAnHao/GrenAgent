import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolAuditStore } from './auditStore';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<ToolAuditStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-audit-store-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  return new ToolAuditStore(storage.db, () => 42);
}

const BASE = {
  workspace: 'D:/repo', origin: 'main' as const, tool: 'bash',
  args: '{"command":"npm run build"}', decision: 'allow' as const, resolution: 'auto' as const,
};

describe('ToolAuditStore', () => {
  it('records a decision and returns its id', async () => {
    const store = await fixture();
    const id = store.record(BASE);
    const row = store.get(id);
    expect(row).toMatchObject({ ...BASE, id, createdAt: 42 });
    // 未决行不带 resolvedAt 键，与 mapRow 对其余可选字段的处理一致。
    expect(row?.resolvedAt).toBeUndefined();
  });

  it('persists optional correlation ids', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, sessionId: 's1', threadId: 't1', turnId: 'u1', toolCallId: 'c1', ruleId: 'r1' });
    expect(store.get(id)).toMatchObject({ sessionId: 's1', threadId: 't1', turnId: 'u1', toolCallId: 'c1', ruleId: 'r1' });
  });

  it('resolves a pending row and stamps resolvedAt', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, decision: 'ask', resolution: 'queued', queuePayload: '{"tool":"bash"}' });
    expect(store.resolve(id, 'user_allow')).toBe(true);
    expect(store.get(id)).toMatchObject({ resolution: 'user_allow', resolvedAt: 42 });
  });

  it('reports false when resolving an unknown id', async () => {
    const store = await fixture();
    expect(store.resolve('missing', 'user_deny')).toBe(false);
  });

  it('lists only queued rows, oldest first', async () => {
    const store = await fixture();
    store.record(BASE);
    const first = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    const second = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    expect(store.pending().map((r) => r.id)).toEqual([first, second]);
  });

  it('excludes rows that were resolved after being queued', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    store.resolve(id, 'user_deny');
    expect(store.pending()).toEqual([]);
  });
});
