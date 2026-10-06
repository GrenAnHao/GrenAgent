import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../agentData/memoryStore';
import { applyDedupDecisions, recallCandidates } from './memoryDedup';

describe('applyDedupDecisions', () => {
  it('skip 不写入', () => {
    const calls: string[] = [];
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.level}`); return {} as never }, remove: () => { calls.push('remove'); } }, 'u',
      [{ record_id: 'r1', action: 'skip', target_ids: [] }], new Map(), 'src');
    expect(calls).toEqual([]);
  });

  it('update/merge 先删 target_ids 再写合并结果', () => {
    const calls: string[] = [];
    const records = new Map([['r1', { content: '新', type: 'work_fact', priority: 80 }]]);
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.content}`); return {} as never }, remove: (_s, id) => { calls.push(`remove:${id}`); } }, 'u',
      [{ record_id: 'r1', action: 'merge', target_ids: ['old1', 'old2'], merged_content: '合并后', merged_type: 'work_fact', merged_priority: 88 }], records, 'src');
    expect(calls).toEqual(['remove:old1', 'remove:old2', 'upsert:{"content":"合并后","type":"work_fact","priority":88,"scene_name":"未分类","source_message_ids":[],"metadata":{}}']);
  });

  it('决策缺失的记录按 store 处理，不静默丢弃', () => {
    const calls: string[] = [];
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.content}`); return {} as never }, remove: () => {} }, 'u',
      [], new Map([['r9', { content: '孤儿', type: 'work_task', priority: 60 }]]), 'src');
    expect(calls).toEqual(['upsert:{"content":"孤儿","type":"work_task","priority":60,"scene_name":"未分类","source_message_ids":[],"metadata":{}}']);
  });

  it('有 record 且 decision 为 skip 时不写入', () => {
    const calls: string[] = [];
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.content}`); return {} as never }, remove: () => { calls.push('remove'); } }, 'u',
      [{ record_id: 'r1', action: 'skip', target_ids: [] }], new Map([['r1', { content: '跳过', type: 'work_fact', priority: 70 }]]), 'src');
    expect(calls).toEqual([]);
  });
});

describe('recallCandidates', () => {
  const scope = { userId: 'u', projectId: 'p', workspace: '/w' };
  const l1 = (content: string) => JSON.stringify({ content, type: 'work_method', priority: 80 });

  it('换个说法也能召回，按重叠率排序，低于 0.3 的不要', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    // 查询 8 个二元组：close 命中 5 个（0.625），只共享「提交」的那条是 0.125，迁移那条是 0。
    const close = store.upsert(scope, { level: 1, content: l1('提交信息统一使用中文书写') });
    store.upsert(scope, { level: 1, content: l1('提交前先运行测试') });
    store.upsert(scope, { level: 1, content: l1('数据库迁移放在启动阶段') });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: '提交信息统一使用中文' });
    const hits = recallCandidates(store, scope, '以后提交信息都使用中文', 5);
    expect(hits.map((hit) => hit.id)).toEqual([close.id]);
    expect(hits.every((hit) => hit.level === 1)).toBe(true);
  });

  it('只比对 L1 JSON 里的 content 字段，不被 type、priority 这些键干扰', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    store.upsert(scope, { level: 1, content: l1('完全无关的事') });
    expect(recallCandidates(store, scope, 'work_method priority content', 5)).toEqual([]);
  });

  it('库里有很多近期记录共享常见词时，最旧的真改写仍被召回', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const target = store.upsert(scope, { level: 1, content: l1('提交信息统一使用中文书写') });
    // 60 条近期记录都共享「项目」。按时间取前 50 条的粗筛会把最旧的这条挤掉。
    for (let i = 0; i < 60; i++) store.upsert(scope, { level: 1, content: l1(`项目事项${i}已排期`) });
    db.prepare('UPDATE memories SET updated_at = 1 WHERE id = ?').run(target.id);
    // 查询 10 个二元组：target 命中 8 个，其余只命中「项目」。
    expect(recallCandidates(store, scope, '项目提交信息统一使用中文', 5).map((hit) => hit.id)).toEqual([target.id]);
    db.close();
  });

  it('比例达标但共享词太少不召回：命中数下限是 min(3, 词数)', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    const target = store.upsert(scope, { level: 1, content: l1('提交信息统一使用中文') });
    // 查询 3 个二元组（提交、交说、说明），只共享「提交」：比例 1/3 过了 0.3，但命中数 1 < 3。
    expect(recallCandidates(store, scope, '提交说明', 5)).toEqual([]);
    // 查询词很少时下限按词数算：3 个词全命中、单个词命中都算。
    expect(recallCandidates(store, scope, '提交信息', 5).map((hit) => hit.id)).toEqual([target.id]);
    expect(recallCandidates(store, scope, '提交', 5).map((hit) => hit.id)).toEqual([target.id]);
  });

  it('只共享一个三字短语的不同事不召回', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    store.upsert(scope, { level: 1, content: l1('提交信息统一使用中文') });
    // 查询 5 个二元组（提交、交信、信号、号灯、灯亮），共享「提交信」切出的 2 个：比例 0.4 过了 0.3，命中数 2 < 3。
    expect(recallCandidates(store, scope, '提交信号灯亮', 5)).toEqual([]);
  });
});

describe('MemoryStore.searchL1ByTerms', () => {
  const scope = { userId: 'u', projectId: 'p', workspace: '/w' };
  const l1 = (content: string) => JSON.stringify({ content, type: 'work_method', priority: 80 });

  it('按命中数从多到少排序，minShared 滤掉命中不足的，非 JSON 内容按原文比对', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    const one = store.upsert(scope, { level: 1, content: l1('alpha only') });
    const two = store.upsert(scope, { level: 1, content: l1('alpha beta together') });
    const raw = store.upsert(scope, { level: 1, content: 'ALPHA beta gamma raw text' });
    const terms = ['alpha', 'beta', 'gamma'];
    expect(store.searchL1ByTerms(scope, terms).map((hit) => hit.id)).toEqual([raw.id, two.id, one.id]);
    expect(store.searchL1ByTerms(scope, terms, 50, 2).map((hit) => hit.id)).toEqual([raw.id, two.id]);
    expect(store.searchL1ByTerms(scope, terms, 50, 3).map((hit) => hit.id)).toEqual([raw.id]);
    expect(store.searchL1ByTerms(scope, terms, 1).map((hit) => hit.id)).toEqual([raw.id]);
  });

  it('命中数相同时最近更新的在前', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const older = store.upsert(scope, { level: 1, content: l1('alpha one') });
    const newer = store.upsert(scope, { level: 1, content: l1('alpha two') });
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(1, older.id);
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(2, newer.id);
    expect(store.searchL1ByTerms(scope, ['alpha']).map((hit) => hit.id)).toEqual([newer.id, older.id]);
    db.close();
  });

  it('重复词只算一次，词最多取 64 个，不比对 JSON 键名', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    const hit = store.upsert(scope, { level: 1, content: l1('alpha beta together') });
    expect(store.searchL1ByTerms(scope, ['alpha', 'alpha'], 50, 2)).toEqual([]);
    const fillers = Array.from({ length: 63 }, (_, i) => `zz${i}x`);
    expect(store.searchL1ByTerms(scope, [...fillers, 'alpha', 'beta'], 50, 2)).toEqual([]);
    expect(store.searchL1ByTerms(scope, [...fillers.slice(0, 62), 'alpha', 'beta'], 50, 2).map((row) => row.id)).toEqual([hit.id]);
    expect(store.searchL1ByTerms(scope, ['priority', 'work_method'])).toEqual([]);
  });
});
