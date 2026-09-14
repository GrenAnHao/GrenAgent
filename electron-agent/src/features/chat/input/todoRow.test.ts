import { describe, expect, it } from 'vitest';
import { todoRowCopy } from './todoRow';

describe('todoRowCopy', () => {
  it('uses 已清空 when the successful list is empty', () => {
    expect(todoRowCopy({ done: 0, total: 0, activeContent: null, activeExtra: 0 }))
      .toEqual({ args: '已清空', meta: undefined });
  });

  it('joins counts and the first active name', () => {
    expect(todoRowCopy({ done: 1, total: 5, activeContent: '写组件', activeExtra: 2 }))
      .toEqual({ args: '1/5 已完成 · 写组件', meta: '+2' });
  });

  it('omits meta when extra is 0', () => {
    expect(todoRowCopy({ done: 1, total: 3, activeContent: '写组件', activeExtra: 0 }))
      .toEqual({ args: '1/3 已完成 · 写组件', meta: undefined });
  });

  it('omits the hint when nothing is in progress', () => {
    expect(todoRowCopy({ done: 1, total: 1, activeContent: null, activeExtra: 0 }))
      .toEqual({ args: '1/1 已完成', meta: undefined });
  });
});
