import { beforeEach, describe, expect, it } from 'vitest';
import {
  absolutizeComposerRef,
  applyQueuedDraftHandoff,
  handoffComposerDraft,
  hasQueuedDraftHandoff,
  queueDraftHandoff,
  resetDraftHandoffs,
  rewriteComposerDraftText,
} from './sessionProjectTransferDraft';

const SOURCE = 'D:/repo';

const fileTag = (category: 'file' | 'directory', label: string, value: string) => ({
  type: 'chat-tag',
  category,
  label,
  value,
  version: 1,
});

const doc = (...children: unknown[]) => ({
  root: { type: 'root', version: 1, children: [{ type: 'paragraph', children }] },
});

const textNode = (text: string) => ({ type: 'text', text, version: 1 });

describe('composer file reference handoff', () => {
  beforeEach(resetDraftHandoffs);

  it('keeps relative file and directory tags but leaves command pills and prose untouched', () => {
    const draft = {
      text: '/refactor "src/a.ts" 继续处理 @src/a.ts 和 @docs',
      json: doc(
        { type: 'command-pill', name: 'refactor', params: [{ name: 'file' }], values: ['src/a.ts'] },
        textNode(' 继续处理 '),
        fileTag('file', 'a.ts', 'src/a.ts'),
        textNode(' 和 '),
        fileTag('directory', 'docs', 'docs'),
      ),
    };
    const { draft: next, changed } = handoffComposerDraft(draft, SOURCE);
    expect(changed).toBe(true);
    expect(next.text).toBe('/refactor "src/a.ts" 继续处理 @D:/repo/src/a.ts 和 @D:/repo/docs');
    const json = JSON.stringify(next.json);
    expect(json).toContain('"value":"D:/repo/src/a.ts"');
    expect(json).toContain('"value":"D:/repo/docs"');
    // 胶囊参数与标签 label 不动
    expect(json).toContain('"values":["src/a.ts"]');
    expect(json).toContain('"label":"a.ts"');
  });

  it('leaves absolute tags and drafts without file references alone', () => {
    const absolute = handoffComposerDraft(
      { text: '看 @D:/repo/src/a.ts', json: doc(fileTag('file', 'a.ts', 'D:/repo/src/a.ts')) },
      'D:/other',
    );
    expect(absolute.changed).toBe(false);

    const plain = handoffComposerDraft({ text: '纯文字，没有引用' }, SOURCE);
    expect(plain.changed).toBe(false);
    expect(plain.draft.text).toBe('纯文字，没有引用');
  });

  it('normalizes separators, keeps absolute paths and never doubles slashes', () => {
    expect(absolutizeComposerRef('D:\\repo\\', 'src\\a.ts')).toBe('D:/repo/src/a.ts');
    // 以 / 开头按绝对路径处理（POSIX 项目），不改写
    expect(absolutizeComposerRef('D:/repo', '/src/a.ts')).toBe('/src/a.ts');
    expect(absolutizeComposerRef('D:/repo', './src/a.ts')).toBe('D:/repo/src/a.ts');
  });

  it('rewrites the longest reference first so prefixes are not partially replaced', () => {
    const text = '@src/a @src/a.ts';
    expect(
      rewriteComposerDraftText(text, [
        { from: 'src/a', to: 'D:/repo/src/a' },
        { from: 'src/a.ts', to: 'D:/repo/src/a.ts' },
      ]),
    ).toBe('@D:/repo/src/a @D:/repo/src/a.ts');
  });

  it('applies the queued handoff once, per session path only', () => {
    queueDraftHandoff('D:/s/a.jsonl', SOURCE);
    expect(hasQueuedDraftHandoff('d:\\s\\a.jsonl')).toBe(true);

    const first = applyQueuedDraftHandoff('D:/s/a.jsonl', {
      text: '看 @src/a.ts',
      json: doc(fileTag('file', 'a.ts', 'src/a.ts')),
    });
    expect(first.text).toBe('看 @D:/repo/src/a.ts');

    // 其它会话的草稿原样，不串写
    expect(applyQueuedDraftHandoff('D:/s/b.jsonl', { text: '看 @src/a.ts' }).text).toBe('看 @src/a.ts');
    // 已经消费：二次应用不再重复改写
    expect(applyQueuedDraftHandoff('D:/s/a.jsonl', first)).toEqual(first);
  });

  it('does not invent nodes for unknown structures', () => {
    const weird = { root: { type: 'root', children: [{ type: 'mystery', value: 'src/a.ts' }] } };
    const { draft, changed } = handoffComposerDraft({ text: 'src/a.ts', json: weird }, SOURCE);
    expect(changed).toBe(false);
    expect(draft.json).toEqual(weird);
    expect(draft.text).toBe('src/a.ts');
  });
});
