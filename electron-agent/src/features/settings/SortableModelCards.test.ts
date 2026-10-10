import { describe, expect, it } from 'vitest';
import { moveById } from './SortableModelCards';

const rows = [{ _uid: 'a' }, { _uid: 'b' }, { _uid: 'c' }];

describe('moveById', () => {
  it('moves the dragged row to the drop target position in both directions', () => {
    expect(moveById(rows, 'a', 'c').map((r) => r._uid)).toEqual(['b', 'c', 'a']);
    expect(moveById(rows, 'c', 'a').map((r) => r._uid)).toEqual(['c', 'a', 'b']);
  });

  it('returns the same array when dropped on itself, outside the list or with an unknown id', () => {
    expect(moveById(rows, 'b', 'b')).toBe(rows);
    expect(moveById(rows, 'b', undefined)).toBe(rows);
    expect(moveById(rows, 'x', 'a')).toBe(rows);
  });

  it('does not mutate the input array', () => {
    moveById(rows, 'a', 'c');
    expect(rows.map((r) => r._uid)).toEqual(['a', 'b', 'c']);
  });
});
