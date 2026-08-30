import { describe, expect, it } from 'vitest';
import { JsonlBuffer } from './jsonl';

describe('JsonlBuffer', () => {
  it('splits only on LF and preserves partial input', () => {
    const buffer = new JsonlBuffer();
    expect(buffer.push('{"a":1}\r\n{"b":')).toEqual(['{"a":1}']);
    expect(buffer.push('2}\n')).toEqual(['{"b":2}']);
  });

  it('does not split on unicode line separators', () => {
    const buffer = new JsonlBuffer();
    expect(buffer.push('{"text":"a\u2028b"}\n')).toEqual(['{"text":"a\u2028b"}']);
  });
});
