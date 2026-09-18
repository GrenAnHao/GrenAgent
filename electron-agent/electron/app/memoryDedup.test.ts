import { describe, expect, it } from 'vitest';
import { applyDedupDecisions } from './memoryDedup';

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
