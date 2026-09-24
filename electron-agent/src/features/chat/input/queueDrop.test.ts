import { describe, expect, it } from 'vitest';
import { queueDropBeforeId } from './queueDrop';

const rows = [
  { id: 'a', top: 0, bottom: 20 },
  { id: 'b', top: 20, bottom: 40 },
];

describe('queueDropBeforeId', () => {
  it('指针在某行上半段时插到该行前面', () => {
    expect(queueDropBeforeId(rows, 'a', 25)).toBe('b');
  });

  it('指针低于所有其他行时返回 null', () => {
    expect(queueDropBeforeId(rows, 'b', 30)).toBeNull();
  });

  it('忽略正在拖的那一行', () => {
    expect(queueDropBeforeId(rows, 'b', 5)).toBe('a');
  });
});
