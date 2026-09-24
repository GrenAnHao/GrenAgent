import { describe, expect, it } from 'vitest';
import {
  createComposerItem,
  moveComposerItem,
  removeComposerItem,
  updateComposerItem,
} from './composerQueue';

describe('composerQueue', () => {
  it('createComposerItem 分配独立 id', () => {
    const a = createComposerItem('先别再测了');
    const b = createComposerItem('改用 chrome');
    expect(a.id).not.toBe(b.id);
    expect(a.text).toBe('先别再测了');
    expect(b.text).toBe('改用 chrome');
  });

  it('updateComposerItem 只改对应条目正文', () => {
    const first = createComposerItem('旧');
    const second = createComposerItem('保留');
    const next = updateComposerItem([first, second], first.id, '新');
    expect(next).toEqual([
      { ...first, text: '新' },
      second,
    ]);
  });

  it('removeComposerItem 删掉对应条目', () => {
    const first = createComposerItem('删我');
    const second = createComposerItem('留下');
    expect(removeComposerItem([first, second], first.id)).toEqual([second]);
  });

  it('moveComposerItem 把条目插到另一条前面', () => {
    const a = createComposerItem('a');
    const b = createComposerItem('b');
    const c = createComposerItem('c');
    expect(moveComposerItem([a, b, c], b.id, a.id).map((item) => item.id)).toEqual([b.id, a.id, c.id]);
  });

  it('moveComposerItem 的 beforeId 为 null 时放到队尾', () => {
    const a = createComposerItem('a');
    const b = createComposerItem('b');
    expect(moveComposerItem([a, b], a.id, null).map((item) => item.id)).toEqual([b.id, a.id]);
  });

  it('moveComposerItem 找不到被拖条目时原样返回', () => {
    const a = createComposerItem('a');
    const queue = [a];
    expect(moveComposerItem(queue, 'missing', null)).toBe(queue);
  });

  it('moveComposerItem 目标就是自己时原样返回', () => {
    const a = createComposerItem('a');
    const b = createComposerItem('b');
    const queue = [a, b];
    expect(moveComposerItem(queue, a.id, b.id)).toBe(queue);
  });
});
