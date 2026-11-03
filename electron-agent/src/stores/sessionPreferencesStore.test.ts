import { beforeEach, describe, expect, it } from 'vitest';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from './sessionPreferencesStore';

beforeEach(() => {
  resetSessionPreferencesForTests();
});

const prefs = (patch: Partial<{
  thinkingLevel: string;
  mode: 'agent' | 'ask' | 'plan';
  approval: 'auto' | 'workspace' | 'full';
  provider: string;
  id: string;
}>) => ({
  ...(patch.provider && patch.id ? { model: { provider: patch.provider, id: patch.id } } : {}),
  ...(patch.thinkingLevel ? { thinkingLevel: patch.thinkingLevel } : {}),
  ...(patch.mode ? { mode: patch.mode } : {}),
  ...(patch.approval ? { approval: patch.approval } : {}),
  revision: 1,
});

describe('sessionPreferencesStore drafts', () => {
  it('keeps a draft write local: readable via peek, no defaults change', () => {
    const store = useSessionPreferencesStore.getState();
    const seq = store.patchOptimistic('draft:one', 'thinkingLevel', 'high');
    expect(seq).toBeGreaterThan(0);
    expect(useSessionPreferencesStore.getState().peek('draft:one')).toMatchObject({ thinkingLevel: 'high' });
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
    // 草稿本地写既是展示值也是确认值，回滚没有意义。
    expect(useSessionPreferencesStore.getState().get('draft:one')?.confirmed.thinkingLevel).toBe('high');
  });

  it('keeps two drafts of the same workspace apart', () => {
    const store = useSessionPreferencesStore.getState();
    store.patchOptimistic('draft:one', 'thinkingLevel', 'high');
    store.patchOptimistic('draft:two', 'thinkingLevel', 'low');
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.thinkingLevel).toBe('high');
    expect(useSessionPreferencesStore.getState().peek('draft:two')?.thinkingLevel).toBe('low');
  });
});

describe('sessionPreferencesStore receipts', () => {
  it('drops a stale receipt after a newer pick of the same field', () => {
    const store = useSessionPreferencesStore.getState();
    const first = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'high');
    const second = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'low');
    const applied = useSessionPreferencesStore.getState().applyReceipt(
      '/ws/a.jsonl',
      'thinkingLevel',
      first,
      { thinkingLevel: 'high', mode: 'agent', revision: 2 },
    );
    expect(applied).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({ thinkingLevel: 'low' });

    const ok = useSessionPreferencesStore.getState().applyReceipt(
      '/ws/a.jsonl',
      'thinkingLevel',
      second,
      { thinkingLevel: 'low', mode: 'agent', revision: 3 },
    );
    expect(ok).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      thinkingLevel: 'low',
      mode: 'agent',
      revision: 3,
    });
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBeNull();
  });

  it('keeps another field that has a newer pending write when a stale snapshot arrives', () => {
    const store = useSessionPreferencesStore.getState();
    const thinkingSeq = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'high');
    store.patchOptimistic('/ws/a.jsonl', 'mode', 'plan');
    useSessionPreferencesStore.getState().applyReceipt(
      '/ws/a.jsonl',
      'thinkingLevel',
      thinkingSeq,
      // 回执是模型改动前的整份快照，mode 仍是 agent —— 不能盖掉本地的 plan。
      { thinkingLevel: 'high', mode: 'agent', approval: 'auto', revision: 5 },
    );
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      thinkingLevel: 'high',
      mode: 'plan',
    });
  });

  it('rolls a failed write back to the confirmed value and flags the error', () => {
    const store = useSessionPreferencesStore.getState();
    store.applyServer('/ws/a.jsonl', prefs({ thinkingLevel: 'medium', provider: 'anthropic', id: 'opus' }));
    const seq = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'max');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('max');

    const failed = useSessionPreferencesStore.getState().failWrite('/ws/a.jsonl', 'thinkingLevel', seq);
    expect(failed).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('medium');
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBe('save');
  });

  it('ignores a failure for a write that a newer pick already replaced', () => {
    const store = useSessionPreferencesStore.getState();
    const first = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'high');
    store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'low');
    expect(useSessionPreferencesStore.getState().failWrite('/ws/a.jsonl', 'thinkingLevel', first)).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('low');
  });

  it('never writes one owner result onto another', () => {
    const store = useSessionPreferencesStore.getState();
    const seqB = store.patchOptimistic('/ws/b.jsonl', 'thinkingLevel', 'low');
    store.applyServer('/ws/a.jsonl', prefs({ thinkingLevel: 'high', provider: 'anthropic', id: 'opus' }));
    useSessionPreferencesStore.getState().applyReceipt(
      '/ws/b.jsonl',
      'thinkingLevel',
      seqB,
      { thinkingLevel: 'low', revision: 2 },
    );
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({ thinkingLevel: 'high' });
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')).toMatchObject({ thinkingLevel: 'low' });
  });
});

describe('sessionPreferencesStore recovery', () => {
  it('restores a removed mode in a newer snapshot without reviving the previous mode or changing its owner', () => {
    const owner = 'C:\\Work\\A.jsonl';
    const store = useSessionPreferencesStore.getState();
    store.applyServer(owner, { mode: 'ask', revision: 2 });
    store.applyServer('/ws/b.jsonl', { mode: 'plan', revision: 8 });
    store.applyServer(owner, {
      mode: 'brainstorm' as never,
      model: { provider: 'relay', id: 'saved' },
      thinkingLevel: 'high',
      approval: 'workspace',
      fastMode: false,
      revision: 7,
    });
    expect(useSessionPreferencesStore.getState().get(owner)).toMatchObject({
      ownerKey: owner,
      preferences: {
        mode: 'agent', model: { provider: 'relay', id: 'saved' }, thinkingLevel: 'high',
        approval: 'workspace', fastMode: false, revision: 7,
      },
      confirmed: { mode: 'agent', revision: 7 },
    });
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')).toEqual({ mode: 'plan', revision: 8 });
  });

  it('restores a removed mode in a receipt while preserving newer picks and a missing revision', () => {
    const store = useSessionPreferencesStore.getState();
    store.applyServer('/ws/a.jsonl', { mode: 'plan', thinkingLevel: 'medium', revision: 5 });
    const seq = store.patchOptimistic('/ws/a.jsonl', 'approval', 'workspace');
    store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'high');
    store.applyReceipt('/ws/a.jsonl', 'approval', seq, {
      mode: 'brainstorm' as never, approval: 'workspace', thinkingLevel: 'low',
    } as never);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toEqual({
      mode: 'agent', approval: 'workspace', thinkingLevel: 'high', revision: 5,
    });
  });

  it('restores removed mode statuses and defaults without replacing other fields', () => {
    const store = useSessionPreferencesStore.getState();
    store.applyServer('/ws/a.jsonl', { mode: 'plan', thinkingLevel: 'high', revision: 6 });
    store.setDefaults('/ws', { mode: 'brainstorm' as never, fastMode: true, revision: 3 });
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toEqual({
      mode: 'agent', fastMode: true, revision: 3,
    });
    store.applyStatus('/ws/a.jsonl', 'mode', 'brainstorm');
    store.applyDefaultStatus('/ws', 'mode', 'brainstorm');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toEqual({
      mode: 'agent', thinkingLevel: 'high', revision: 6,
    });
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toEqual({
      mode: 'agent', fastMode: true, revision: 3,
    });
    store.applyStatus('/ws/a.jsonl', 'mode', 'unknown');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.mode).toBe('agent');
  });

  it('rejects a removed mode in new optimistic writes without superseding a valid pending pick', () => {
    const store = useSessionPreferencesStore.getState();
    store.patchOptimistic('draft:one', 'mode', 'plan');
    store.patchOptimistic('draft:one', 'mode', 'brainstorm');
    const seq = store.patchOptimistic('/ws/a.jsonl', 'mode', 'ask');
    store.patchOptimistic('/ws/a.jsonl', 'mode', 'brainstorm');
    expect(store.applyReceipt('/ws/a.jsonl', 'mode', seq, { mode: 'ask', revision: 2 })).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.mode).toBe('plan');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.mode).toBe('ask');
  });

  it('recovers missing fields one by one without resetting the rest', () => {
    useSessionPreferencesStore.getState().applyServer('/ws/a.jsonl', prefs({ provider: 'anthropic', id: 'opus' }));
    // 历史会话只补回 thinkingLevel，model/mode/approval 保持原值。
    useSessionPreferencesStore.getState().applyServer(
      '/ws/a.jsonl',
      { thinkingLevel: 'low', revision: 2 },
      { fields: ['thinkingLevel'] },
    );
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      model: { provider: 'anthropic', id: 'opus' },
      thinkingLevel: 'low',
    });
  });

  it('keeps a saved value when the model becomes unavailable instead of clearing it', () => {
    useSessionPreferencesStore.getState().applyServer(
      '/ws/a.jsonl',
      prefs({ provider: 'gone', id: 'flash', thinkingLevel: 'max' }),
    );
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      model: { provider: 'gone', id: 'flash' },
      thinkingLevel: 'max',
    });
  });
});

describe('sessionPreferencesStore adopt/remove/defaults', () => {
  it('adopts a draft onto the created session and drops the draft key', () => {
    const store = useSessionPreferencesStore.getState();
    store.patchOptimistic('draft:one', 'thinkingLevel', 'high');
    store.patchOptimistic('draft:one', 'mode', 'plan');
    store.applyServer('/ws/other.jsonl', prefs({ thinkingLevel: 'low' }));

    useSessionPreferencesStore.getState().adopt('draft:one', '/ws/created.jsonl');
    expect(useSessionPreferencesStore.getState().peek('draft:one')).toBeUndefined();
    expect(useSessionPreferencesStore.getState().peek('/ws/created.jsonl')).toMatchObject({
      thinkingLevel: 'high',
      mode: 'plan',
    });
    // 其它会话不受过户影响。
    expect(useSessionPreferencesStore.getState().peek('/ws/other.jsonl')).toMatchObject({ thinkingLevel: 'low' });
  });

  it('prefers the receipt snapshot when adopting', () => {
    const store = useSessionPreferencesStore.getState();
    store.patchOptimistic('draft:one', 'thinkingLevel', 'high');
    useSessionPreferencesStore.getState().adopt('draft:one', '/ws/created.jsonl', {
      thinkingLevel: 'high',
      mode: 'agent',
      approval: 'auto',
      revision: 9,
    });
    expect(useSessionPreferencesStore.getState().peek('/ws/created.jsonl')).toMatchObject({
      thinkingLevel: 'high',
      mode: 'agent',
      approval: 'auto',
      revision: 9,
    });
  });

  it('removes a deleted session so late receipts cannot resurrect it', () => {
    const store = useSessionPreferencesStore.getState();
    const seq = store.patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'high');
    useSessionPreferencesStore.getState().remove('/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toBeUndefined();
    // 迟到的回执：不放回条目，也不抛错。
    const applied = useSessionPreferencesStore.getState().applyReceipt(
      '/ws/a.jsonl',
      'thinkingLevel',
      seq,
      { thinkingLevel: 'high', revision: 2 },
    );
    expect(applied).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toBeUndefined();
  });

  it('stores explicit project defaults separately from session values', () => {
    useSessionPreferencesStore.getState().setDefaults('/ws', {
      model: { provider: 'openai', id: 'g' },
      thinkingLevel: 'medium',
      mode: 'agent',
      approval: 'auto',
      revision: 1,
    });
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toMatchObject({
      thinkingLevel: 'medium',
    });
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toBeUndefined();
  });

  it('exposes loading and load errors per owner', () => {
    useSessionPreferencesStore.getState().setLoading('/ws/a.jsonl', true);
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.loading).toBe(true);
    useSessionPreferencesStore.getState().setLoading('/ws/a.jsonl', false);
    useSessionPreferencesStore.getState().setError('/ws/a.jsonl', 'load');
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBe('load');
  });
});
