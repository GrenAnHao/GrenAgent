import { describe, expect, it } from 'vitest';
import { firstLineOf, forEachLineContaining, linesContaining } from './sessionLineScan';

describe('sessionLineScan', () => {
  it('returns whole lines that contain the marker, in file order, without \\r', () => {
    const buffer = Buffer.from(['{"a":1}', '{"type":"session_info","name":"甲"}', '{"b":2}', '{"type":"session_info","name":"乙"}'].join('\r\n'));
    expect(linesContaining(buffer, '"session_info"')).toEqual([
      '{"type":"session_info","name":"甲"}',
      '{"type":"session_info","name":"乙"}',
    ]);
  });

  it('finds a marker on the first line and on a last line without a trailing newline', () => {
    const buffer = Buffer.from('"user" first\nmiddle\nlast "user"');
    expect(linesContaining(buffer, '"user"')).toEqual(['"user" first', 'last "user"']);
  });

  it('visits a line once even when the marker repeats inside it', () => {
    const buffer = Buffer.from('x "user" "user" y\nz');
    expect(linesContaining(buffer, '"user"')).toEqual(['x "user" "user" y']);
  });

  it('stops when the visitor returns true', () => {
    const seen: string[] = [];
    forEachLineContaining(Buffer.from('a1\na2\na3'), 'a', (line) => {
      seen.push(line);
      return line === 'a2';
    });
    expect(seen).toEqual(['a1', 'a2']);
  });

  it('decodes multi-byte UTF-8 around the hit', () => {
    const buffer = Buffer.from('前缀\n标题「"session_info"」后缀\n尾巴');
    expect(linesContaining(buffer, '"session_info"')).toEqual(['标题「"session_info"」后缀']);
  });

  it('reads the first line', () => {
    expect(firstLineOf(Buffer.from('{"type":"session"}\r\nrest'))).toBe('{"type":"session"}');
    expect(firstLineOf(Buffer.from('only'))).toBe('only');
    expect(firstLineOf(Buffer.alloc(0))).toBe('');
  });

  it('rejects markers that are not printable ASCII', () => {
    expect(() => linesContaining(Buffer.from('标题'), '标题')).toThrow('printable ASCII');
    expect(() => linesContaining(Buffer.from('x'), '')).toThrow('printable ASCII');
  });
});
