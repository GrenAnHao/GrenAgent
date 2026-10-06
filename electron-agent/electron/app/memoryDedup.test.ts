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
});
