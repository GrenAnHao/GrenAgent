import { describe, it, expect } from 'vitest';
import { composeMessage } from './composeMessage';
import type { PastedText } from './types';

const pasted = (text: string): PastedText => ({
  id: text,
  text,
  lines: text.split('\n').length,
  chars: text.length,
});

describe('composeMessage', () => {
  it('无粘贴块时仅返回 trim 后的正文', () => {
    expect(composeMessage('  hello @src/a.ts  ', [])).toBe('hello @src/a.ts');
  });

  it('粘贴块用 pi:attachment text 标记包裹', () => {
    expect(composeMessage('看这段', [pasted('line1\nline2')])).toBe(
      '看这段\n\n<pi:attachment type="text" lines="2" chars="11">\nline1\nline2\n</pi:attachment>',
    );
  });

  it('正文为空时只发送被标记的粘贴块', () => {
    expect(composeMessage('', [pasted('only pasted')])).toBe(
      '<pi:attachment type="text" lines="1" chars="11">\nonly pasted\n</pi:attachment>',
    );
  });

  it('多个粘贴块按顺序各自包裹', () => {
    expect(composeMessage('x', [pasted('a'), pasted('b')])).toBe(
      'x\n\n<pi:attachment type="text" lines="1" chars="1">\na\n</pi:attachment>' +
        '\n\n<pi:attachment type="text" lines="1" chars="1">\nb\n</pi:attachment>',
    );
  });

  it('拖入文件块用 pi:attachment file 标记标注相对路径', () => {
    const fileBlock: PastedText = { id: 'f', text: 'const x = 1', lines: 1, chars: 11, source: 'src/a.ts' };
    expect(composeMessage('看这个', [fileBlock])).toBe(
      '看这个\n\n<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>',
    );
  });

  it('大文件引用 chip 发送为 @path，不嵌入全文', () => {
    const ref: PastedText = {
      id: 'r',
      text: '',
      lines: 900,
      chars: 100_000,
      source: 'docs/big.md',
      referenceOnly: true,
    };
    expect(composeMessage('总结', [ref])).toBe('总结\n\n@docs/big.md');
  });
});
