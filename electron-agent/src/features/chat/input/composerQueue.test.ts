import { describe, expect, it } from 'vitest';
import { createComposerItem, removeComposerItem, updateComposerItem } from './composerQueue';

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
});
