import { describe, expect, it } from 'vitest';
import { isGoalReceiptNotify } from './goalReceiptNotify';

describe('isGoalReceiptNotify', () => {
  it('matches status receipts and clear ack', () => {
    expect(isGoalReceiptNotify('执行中的目标 · 写完 · 3/256 · armed')).toBe(true);
    expect(isGoalReceiptNotify('已暂停的目标 · 测试子代理理 · 0/256 · disarmed')).toBe(true);
    expect(isGoalReceiptNotify('已清除目标。')).toBe(true);
  });

  it('leaves other notifies alone', () => {
    expect(isGoalReceiptNotify('已设定目标：写完测试')).toBe(false);
    expect(isGoalReceiptNotify('已达轮次上限')).toBe(false);
    expect(isGoalReceiptNotify('当前没有生效的目标。')).toBe(false);
  });
});
