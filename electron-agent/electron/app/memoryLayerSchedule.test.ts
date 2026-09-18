import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { computeFireAt, LayerScheduleStore, mergeLayerMemories } from './memoryLayerSchedule';

describe('computeFireAt', () => {
  it('从未跑过 L2 时只加 delay', () => {
    expect(computeFireAt(1_000, 0, 10_000, 900_000)).toBe(11_000);
  });

  it('取 delay 与最小间隔的较大值', () => {
    expect(computeFireAt(1_000_000, 200_000, 10_000, 900_000)).toBe(1_100_000);
    expect(computeFireAt(1_000_000, 995_000, 10_000, 900_000)).toBe(1_895_000);
  });
});

describe('mergeLayerMemories', () => {
  const a = { content: '先对齐', type: 'work_method' as const, priority: 90, scene_name: 's', source_message_ids: [], metadata: {} };
  const b = { content: '后落库', type: 'work_task' as const, priority: 80, scene_name: 's', source_message_ids: [], metadata: {} };

  it('追加新记录并跳过 content+type+scene_name 相同的条目', () => {
    expect(mergeLayerMemories([a], [a, b])).toEqual([a, b]);
  });

  it('超过 200 条丢掉最旧的', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...a, content: `c${i}` }));
    const merged = mergeLayerMemories(many, [{ ...b, content: 'newest' }]);
    expect(merged).toHaveLength(200);
    expect(merged[0].content).toBe('c1');
    expect(merged.at(-1)?.content).toBe('newest');
  });
});

const scope = { userId: 'u', workspace: '/repo-a', projectId: 'project-A' };
const rec = { content: '先对齐', type: 'work_method' as const, priority: 90, scene_name: 's', source_message_ids: [] as string[], metadata: {} };

describe('LayerScheduleStore', () => {
  it('upsert 等待行，markFired 清 payload 并记下 last_fired_at', () => {
    const db = new DatabaseSync(':memory:');
    const schedules = new LayerScheduleStore(db);
    schedules.ensure();
    schedules.upsertPending({
      userId: 'u',
      kind: 'memory_scene',
      fireAt: 11_000,
      payload: { scope, source: 'session:s1', memories: [rec] },
      now: 1_000,
    });
    expect(schedules.get('u', 'memory_scene')).toMatchObject({
      lastFiredAt: 0,
      fireAt: 11_000,
      payload: { source: 'session:s1', memories: [rec] },
    });
    schedules.markFired('u', 'memory_scene', 11_500);
    expect(schedules.get('u', 'memory_scene')).toMatchObject({
      lastFiredAt: 11_500,
      fireAt: null,
      payload: null,
    });
    db.close();
  });

  it('listPending 只返回仍有 fire_at 的行', () => {
    const db = new DatabaseSync(':memory:');
    const schedules = new LayerScheduleStore(db);
    schedules.ensure();
    schedules.upsertPending({
      userId: 'u', kind: 'memory_scene', fireAt: 5, payload: { scope, source: 's', memories: [rec] }, now: 1,
    });
    schedules.markFired('u', 'memory_scene', 5);
    schedules.upsertPending({
      userId: 'v', kind: 'memory_scene', fireAt: 9, payload: { scope: { ...scope, userId: 'v' }, source: 's', memories: [rec] }, now: 1,
    });
    expect(schedules.listPending().map((row) => row.userId)).toEqual(['v']);
    db.close();
  });

  it('clearPending 清空 fireAt/payload，但保留 lastFiredAt', () => {
    const db = new DatabaseSync(':memory:');
    const schedules = new LayerScheduleStore(db);
    schedules.ensure();
    schedules.upsertPending({
      userId: 'u',
      kind: 'memory_scene',
      fireAt: 11_000,
      payload: { scope, source: 'session:s1', memories: [rec] },
      now: 1_000,
    });
    schedules.clearPending('u', 'memory_scene', 11_500);
    expect(schedules.get('u', 'memory_scene')).toMatchObject({
      lastFiredAt: 0,
      fireAt: null,
      payload: null,
    });
    db.close();
  });
});
