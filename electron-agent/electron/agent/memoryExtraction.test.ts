import { describe, expect, it } from 'vitest';
import { L1_TYPES_WORK, L1_TYPES_CHAT, parseMemoryExtraction } from './memoryExtraction';

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
    expect(L1_TYPES_WORK).toHaveLength(4);
    expect(L1_TYPES_CHAT).toHaveLength(3);
  });
});
