import { describe, it, expect } from 'vitest';
import {
  countLines,
  isLongPaste,
  makePastedText,
  pastedLabel,
  PASTE_CHAR_THRESHOLD,
  PASTE_LINE_THRESHOLD,
} from './pastedText';

describe('pastedText 阈值', () => {
  it('countLines 统计行数', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('短文本不折叠', () => {
    expect(isLongPaste('hello')).toBe(false);
    expect(isLongPaste('a\nb\nc')).toBe(false);
    expect(isLongPaste('')).toBe(false);
  });

  it('超过行阈值折叠', () => {
    const text = Array.from({ length: PASTE_LINE_THRESHOLD + 1 }, () => 'x').join('\n');
    expect(isLongPaste(text)).toBe(true);
  });

  it('超过字数阈值折叠', () => {
    expect(isLongPaste('x'.repeat(PASTE_CHAR_THRESHOLD + 1))).toBe(true);
  });

  it('makePastedText 记录行数/字数且 id 唯一', () => {
    const a = makePastedText('a\nb');
    const b = makePastedText('a\nb');
    expect(a.lines).toBe(2);
    expect(a.chars).toBe(3);
    expect(a.id).not.toBe(b.id);
  });

  it('pastedLabel 含行数', () => {
    expect(pastedLabel({ lines: 19, chars: 100 })).toContain('19');
  });
});
