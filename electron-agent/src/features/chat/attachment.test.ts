import { describe, it, expect } from 'vitest';
import { wrapAttachment, parseAttachments, type AttachmentBlock } from './attachment';

describe('wrapAttachment', () => {
  it('text 块输出 type/lines/chars 属性', () => {
    expect(
      wrapAttachment({ attType: 'text', lines: 2, chars: 11, content: 'line1\nline2' }),
    ).toBe('<pi:attachment type="text" lines="2" chars="11">\nline1\nline2\n</pi:attachment>');
  });

  it('file 块输出 type/path/lines（不含 chars）', () => {
    expect(
      wrapAttachment({ attType: 'file', path: 'src/a.ts', lines: 1, chars: 11, content: 'const x = 1' }),
    ).toBe('<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>');
  });
});

describe('parseAttachments', () => {
  it('无标记返回单个 text 段（向后兼容）', () => {
    expect(parseAttachments('plain text')).toEqual([{ type: 'text', text: 'plain text' }]);
  });

  it('切出正文段与附件段', () => {
    const text =
      '看这个\n\n<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>';
    expect(parseAttachments(text)).toEqual([
      { type: 'text', text: '看这个\n\n' },
      {
        type: 'attachment',
        block: { attType: 'file', path: 'src/a.ts', lines: 1, chars: undefined, content: 'const x = 1' },
      },
    ]);
  });

  it('解析多个附件段', () => {
    const text =
      '<pi:attachment type="text" lines="1" chars="1">\na\n</pi:attachment>\n\n' +
      '<pi:attachment type="text" lines="1" chars="1">\nb\n</pi:attachment>';
    const parts = parseAttachments(text);
    const blocks = parts.filter((p) => p.type === 'attachment');
    expect(blocks).toHaveLength(2);
  });

  it('未闭合标签整体回退为 text', () => {
    const text = '看 <pi:attachment type="text" lines="1">\nno close';
    expect(parseAttachments(text)).toEqual([{ type: 'text', text }]);
  });

  it('内容含字面 </pi:attachment> 经转义后能正确还原', () => {
    const block: AttachmentBlock = {
      attType: 'text',
      lines: 1,
      chars: 20,
      content: 'a </pi:attachment> b',
    };
    const parts = parseAttachments(wrapAttachment(block));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'attachment', block: { ...block, path: undefined } });
  });
});
