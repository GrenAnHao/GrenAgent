import { describe, expect, it } from 'vitest';
import { L1_TYPES_WORK, L1_TYPES_CHAT, flattenSceneExtraction, parseMemoryExtraction } from './memoryExtraction';

const record = {
  content: '团队决定 L1 只保留少量高层类型',
  type: 'work_method',
  priority: 85,
  source_message_ids: ['m1'],
  metadata: {},
};

describe('parseMemoryExtraction', () => {
  it('接受 work 类型的记录数组', () => {
    const parsed = parseMemoryExtraction({ l1: [record] }, 'work');
    expect(parsed.l1).toHaveLength(1);
    expect(parsed.l1![0].scene_name).toBe('未分类');
  });

  it('丢弃越界类型而不抛错（对齐上游已知坑的收敛版）', () => {
    const parsed = parseMemoryExtraction({ l1: [{ ...record, type: 'persona' }, { ...record, type: 'work_method' }] }, 'chat');
    expect(parsed.l1).toHaveLength(1);
    expect(parsed.l1![0].type).toBe('persona');
  });

  it('priority 缺失时补 50，越界时钳到 0..100', () => {
    const parsed = parseMemoryExtraction({ l1: [{ ...record, priority: 999 }, { ...record, priority: undefined }] }, 'work');
    expect(parsed.l1!.map((r) => r.priority)).toEqual([100, 50]);
  });

  it('拒绝未知顶层键', () => {
    expect(() => parseMemoryExtraction({ l1: [], nope: 1 }, 'work')).toThrow();
  });

  it('l2/l3 必须是字符串', () => {
    expect(parseMemoryExtraction({ l2: 'x', l3: 'y' }, 'work').l2).toBe('x');
    expect(() => parseMemoryExtraction({ l2: 1 }, 'work')).toThrow();
  });

  it('类型白名单按模式收敛', () => {
    expect(L1_TYPES_WORK).toEqual(['work_fact', 'work_task', 'work_method', 'work_artifact']);
    expect(L1_TYPES_CHAT).toEqual(['persona', 'episodic', 'instruction']);
  });

  it('接受上游 scene JSON 数组并按 scene_name 摊平为 L1 记录', () => {
    const parsed = parseMemoryExtraction([
      {
        scene_name: '团队在围绕 Agent Memory 群聊抽取设计共享记忆规则',
        message_ids: ['m0', 'm1'],
        memories: [
          { content: '团队决定 L1 只保留少量高层类型', type: 'work_method', priority: 85, source_message_ids: ['m0'] },
          { content: '后端需在周五前完成表结构设计', type: 'work_task', priority: 80 },
        ],
      },
    ], 'work');
    expect(parsed.l1).toEqual([
      {
        content: '团队决定 L1 只保留少量高层类型',
        type: 'work_method',
        priority: 85,
        scene_name: '团队在围绕 Agent Memory 群聊抽取设计共享记忆规则',
        source_message_ids: ['m0'],
        metadata: {},
      },
      {
        content: '后端需在周五前完成表结构设计',
        type: 'work_task',
        priority: 80,
        scene_name: '团队在围绕 Agent Memory 群聊抽取设计共享记忆规则',
        source_message_ids: [],
        metadata: {},
      },
    ]);
  });

  it('空 memories 的情境数组视为无 L1，不抛错', () => {
    expect(parseMemoryExtraction([{ scene_name: '闲聊', message_ids: ['m0'], memories: [] }], 'work').l1).toBeUndefined();
  });
});

describe('flattenSceneExtraction 补默认值', () => {
  it('priority 是数字字符串时转成数字，非法时给 50；source_message_ids 转成字符串；metadata 不是对象时给空对象', () => {
    expect(flattenSceneExtraction([{ scene_name: 's', memories: [
      { content: 'a', type: 'work_fact', priority: '70', source_message_ids: [0, 'm1'], metadata: 'x' },
      { content: 'b', type: 'work_fact', priority: 'high' },
    ] }])).toEqual({ l1: [
      { content: 'a', type: 'work_fact', priority: 70, source_message_ids: ['0', 'm1'], metadata: {}, scene_name: 's' },
      { content: 'b', type: 'work_fact', priority: 50, scene_name: 's' },
    ] });
  });

  it('source_message_ids 是单个字符串时包成数组', () => {
    expect(flattenSceneExtraction([{ scene_name: 's', memories: [
      { content: 'a', type: 'work_fact', source_message_ids: 'm1' },
    ] }])).toEqual({ l1: [
      { content: 'a', type: 'work_fact', source_message_ids: ['m1'], scene_name: 's' },
    ] });
  });

  it('source_message_ids 数组里只保留 string 和 number，number 转字符串', () => {
    expect(flattenSceneExtraction([{ scene_name: 's', memories: [
      { content: 'a', type: 'work_fact', source_message_ids: ['m1', 2, { id: 'm3' }, null, true, ['m4'], 'm5'] },
    ] }])).toEqual({ l1: [
      { content: 'a', type: 'work_fact', source_message_ids: ['m1', '2', 'm5'], scene_name: 's' },
    ] });
  });

  it('source_message_ids 既不是字符串也不是数组时去掉', () => {
    expect(flattenSceneExtraction([{ scene_name: 's', memories: [
      { content: 'a', type: 'work_fact', source_message_ids: { id: 'm1' } },
      { content: 'b', type: 'work_fact', source_message_ids: 7 },
    ] }])).toEqual({ l1: [
      { content: 'a', type: 'work_fact', scene_name: 's' },
      { content: 'b', type: 'work_fact', scene_name: 's' },
    ] });
  });
});
