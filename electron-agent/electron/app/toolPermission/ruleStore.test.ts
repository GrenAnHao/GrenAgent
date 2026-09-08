import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolRuleStore } from './ruleStore';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<ToolRuleStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-rule-store-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  return new ToolRuleStore(storage.db, () => 42);
}

describe('ToolRuleStore', () => {
  it('inserts a rule and reads it back', async () => {
    const store = await fixture();
    const created = store.add({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'allow',
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBe(42);
    expect(store.list()).toEqual([created]);
  });

  it('lists rules applicable to a workspace and session plus all global rules', async () => {
    const store = await fixture();
    const mine = store.add({ scope: 'session', scopeKey: 's1', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const ws = store.add({ scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const global = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    store.add({ scope: 'session', scopeKey: 'other', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    store.add({ scope: 'workspace', scopeKey: 'D:/elsewhere', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });

    const ids = store.applicable('D:/repo', 's1').map((r) => r.id).sort();
    expect(ids).toEqual([global.id, mine.id, ws.id].sort());
  });

  it('matches workspace scope regardless of separator and case', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('d:\\repo', undefined).map((r) => r.id)).toEqual([rule.id]);
  });

  // 下面两条锁的是「预筛与 rules.ts 的 scopeApplies 用同一份规范化」：任一处退回到
  // 只转斜杠加小写，这些规则就会在到达 matchUserRules 之前被无声滤掉。
  it('matches a workspace scope key that carries a trailing separator', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'workspace', scopeKey: 'D:/repo/', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('D:/repo', undefined).map((r) => r.id)).toEqual([rule.id]);
  });

  it('matches a workspace scope key that carries a .. segment', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'workspace', scopeKey: 'D:/repo/src/..', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('D:/repo', undefined).map((r) => r.id)).toEqual([rule.id]);
  });

  it('omits session rules when the call has no session id', async () => {
    const store = await fixture();
    store.add({ scope: 'session', scopeKey: 's1', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('D:/repo', undefined)).toEqual([]);
  });

  it('removes a rule by id', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.remove(rule.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(rule.id)).toBe(false);
  });

  it('round-trips an optional expiry', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'ask', expiresAt: 99 });
    expect(store.list()[0]).toEqual({ ...rule, expiresAt: 99 });
  });
});
