import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_CHARS, streamingEditPairs, streamingWritePreview } from './streamingFileModel';

describe('streamingWritePreview', () => {
  it('小内容原样返回', () => {
    expect(streamingWritePreview({ content: 'a\nb' })).toEqual({
      text: 'a\nb',
      totalLines: 2,
      omittedLines: 0,
      revision: 3,
    });
  });

  it('大内容在行边界截断尾部，并给出省略行数', () => {
    const head = 'a\n'.repeat(100);
    const tail = 'b'.repeat(PREVIEW_MAX_CHARS);
    const preview = streamingWritePreview({ content: head + tail });
    expect(preview.text).toBe(tail);
    expect(preview.omittedLines).toBe(100);
    expect(preview.totalLines).toBe(101);
    expect(preview.revision).toBe(head.length + tail.length);
  });
});

describe('streamingEditPairs', () => {
  it('缺 newText 时仍保留 oldText', () => {
    expect(streamingEditPairs({ edits: [{ oldText: 'old' }] })).toEqual([{ oldText: 'old', newText: undefined }]);
  });

  it('edits 为 JSON 字符串时解析', () => {
    expect(streamingEditPairs({ edits: '[{"oldText":"a","newText":"b"}]' })).toEqual([{ oldText: 'a', newText: 'b' }]);
  });

  it('单个对象与旧字段名都能读', () => {
    expect(streamingEditPairs({ edits: { old_string: 'a', new_string: 'b' } })).toEqual([{ oldText: 'a', newText: 'b' }]);
    expect(streamingEditPairs({ oldText: 'x', newText: 'y' })).toEqual([{ oldText: 'x', newText: 'y' }]);
  });
});
