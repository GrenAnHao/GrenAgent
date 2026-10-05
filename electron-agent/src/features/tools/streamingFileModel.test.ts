import { describe, expect, it } from 'vitest';
import {
  HL_MAX_CHARS,
  HL_MAX_LINES,
  PREVIEW_MAX_CHARS,
  exceedsHighlightBudget,
  inferLanguage,
  lineCount,
  streamingEditPairs,
  streamingEditStats,
  streamingWritePreview,
  writeContent,
} from './streamingFileModel';

describe('lineCount', () => {
  it('空串为 0，无换行为 1，末尾换行再加一行', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('abc')).toBe(1);
    expect(lineCount('a\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
  });
});

describe('exceedsHighlightBudget', () => {
  it('在字符和行数边界上取值', () => {
    expect(exceedsHighlightBudget('a'.repeat(HL_MAX_CHARS))).toBe(false);
    expect(exceedsHighlightBudget('a'.repeat(HL_MAX_CHARS + 1))).toBe(true);
    expect(exceedsHighlightBudget(`${'a\n'.repeat(HL_MAX_LINES - 1)}a`)).toBe(false);
    expect(exceedsHighlightBudget('a\n'.repeat(HL_MAX_LINES))).toBe(true);
  });
});

describe('inferLanguage', () => {
  it('路径未到时从正文识别 Python', () => {
    expect(inferLanguage('def _format(value: float) -> str:\n    return 1\n')).toBe('python');
  });

  it('无法判断时返回空', () => {
    expect(inferLanguage('x')).toBeUndefined();
  });
});
describe('writeContent', () => {
  it('非字符串时返回空串', () => {
    expect(writeContent({})).toBe('');
    expect(writeContent({ content: 1 })).toBe('');
    expect(writeContent({ content: 'hi' })).toBe('hi');
  });
});

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

describe('streamingEditStats', () => {
  it('随半截 newText 变长，缺的一侧不计', () => {
    expect(streamingEditStats({ edits: [{ oldText: 'a\nb' }] })).toEqual({ added: 0, deleted: 2 });
    expect(streamingEditStats({ edits: [{ oldText: 'a\nb', newText: 'c' }] })).toEqual({ added: 1, deleted: 2 });
    expect(streamingEditStats({ edits: [{ oldText: 'a\nb', newText: 'c\nd' }] })).toEqual({ added: 2, deleted: 2 });
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
