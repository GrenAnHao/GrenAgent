// @vitest-environment jsdom
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type SerializedEditorState } from 'lexical';
import { $dfs } from '@lexical/utils';
import { describe, expect, it, vi } from 'vitest';
import type { IEditor } from '@lobehub/editor';
import { $createChatTagNode, $isChatTagNode, ChatTagNode } from './ChatTag/ChatTagNode';
import { $createCommandPillNode, $isCommandPillNode, CommandPillNode } from './CommandPill/CommandPillNode';
import { readComposerText } from './CommandPill/composerText';
import {
  composerDraftEquals,
  EMPTY_COMPOSER_DRAFT,
  normalizeComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from './composerDraft';

const params = [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }];

/**
 * 照 lobehub 的 kernel 做一个最小的 IEditor：`getDocument('json')` 是 `{ root }`，
 * `setDocument('json')` 走 parseEditorState + setEditorState，`setDocument('text')` 每行一个段落。
 */
function fakeEditor(nodes: Array<typeof CommandPillNode | typeof ChatTagNode> = [CommandPillNode, ChatTagNode]) {
  const lexical = createEditor({ nodes, onError: (error) => { throw error; } });
  const setDocument = vi.fn((type: string, content: unknown) => {
    if (type === 'json') {
      lexical.setEditorState(lexical.parseEditorState(content as SerializedEditorState));
      return;
    }
    if (type === 'text') {
      lexical.update(() => {
        const root = $getRoot();
        root.clear();
        for (const line of String(content).split('\n')) {
          const paragraph = $createParagraphNode();
          if (line) paragraph.append($createTextNode(line));
          root.append(paragraph);
        }
      }, { discrete: true });
      return;
    }
    throw new Error(`unexpected document type ${type}`);
  });
  const cleanDocument = vi.fn(() => {
    lexical.update(() => $getRoot().clear(), { discrete: true });
  });
  const getDocument = vi.fn((type: string) => {
    if (type === 'json') return lexical.getEditorState().toJSON();
    throw new Error(`unexpected document type ${type}`);
  });
  const editor = { getDocument, setDocument, cleanDocument, getLexicalEditor: () => lexical } as unknown as IEditor;
  return { editor, lexical, setDocument, cleanDocument };
}

function fillWithPillAndTag(lexical: ReturnType<typeof createEditor>) {
  lexical.update(() => {
    $getRoot().append(
      $createParagraphNode().append(
        $createCommandPillNode('refactor', params, ['a.ts', '']),
        $createTextNode(' 看看 '),
        $createChatTagNode('file', 'a_b.ts', 'src/a_b.ts'),
        $createTextNode(' 里的 *args'),
      ),
      $createParagraphNode().append($createTextNode('第二行')),
    );
  }, { discrete: true });
}

function inlineNodes(lexical: ReturnType<typeof createEditor>) {
  return lexical.getEditorState().read(() =>
    $dfs($getRoot())
      .map(({ node }) => node)
      .filter((node) => $isCommandPillNode(node) || $isChatTagNode(node))
      .map((node) => ($isCommandPillNode(node) ? { pill: node.name, values: node.values } : { tag: node.getTextContent() })),
  );
}

describe('readComposerDraft', () => {
  it('文本照 readComposerText，JSON 里带着胶囊和标签节点', () => {
    const { editor, lexical } = fakeEditor();
    fillWithPillAndTag(lexical);
    const draft = readComposerDraft(editor);
    expect(draft.text).toBe('/refactor "a.ts" "" 看看 @src/a_b.ts 里的 *args\n第二行');
    expect(JSON.stringify(draft.json)).toContain('"command-pill"');
    expect(JSON.stringify(draft.json)).toContain('"chat-tag"');
  });

  it('空输入框不带 json', () => {
    const { editor } = fakeEditor();
    expect(readComposerDraft(editor)).toBe(EMPTY_COMPOSER_DRAFT);
  });

  it('拿不到 lexical 实例时只有文本', () => {
    const editor = { getDocument: vi.fn(() => 'hello') } as unknown as IEditor;
    expect(readComposerDraft(editor)).toEqual({ text: 'hello' });
  });
});

describe('writeComposerDraft', () => {
  it('读出再写回：胶囊参数、标签、文本都原样恢复', () => {
    const source = fakeEditor();
    fillWithPillAndTag(source.lexical);
    const draft = readComposerDraft(source.editor);

    const target = fakeEditor();
    writeComposerDraft(target.editor, draft);
    expect(target.setDocument).toHaveBeenCalledWith('json', draft.json);
    expect(inlineNodes(target.lexical)).toEqual([
      { pill: 'refactor', values: ['a.ts', ''] },
      { tag: '@src/a_b.ts' },
    ]);
    expect(readComposerText(target.editor)).toBe(draft.text);
  });

  it('JSON 解析失败（节点类型没注册）退回文本', () => {
    const source = fakeEditor();
    fillWithPillAndTag(source.lexical);
    const draft = readComposerDraft(source.editor);

    const target = fakeEditor([]);
    writeComposerDraft(target.editor, draft);
    expect(target.setDocument).toHaveBeenLastCalledWith('text', draft.text);
    expect(readComposerText(target.editor)).toBe(draft.text);
  });

  it('老的字符串草稿按文本写回，空草稿清空', () => {
    const { editor, setDocument, cleanDocument } = fakeEditor();
    writeComposerDraft(editor, 'a * b\r\nc');
    expect(setDocument).toHaveBeenCalledWith('text', 'a * b\nc');
    writeComposerDraft(editor, '');
    writeComposerDraft(editor, undefined);
    expect(cleanDocument).toHaveBeenCalledTimes(2);
    expect(setDocument).not.toHaveBeenCalledWith('json', expect.anything());
  });

  it('json 形状不对时按文本写回', () => {
    const { editor, setDocument } = fakeEditor();
    writeComposerDraft(editor, { text: 'x', json: 'garbage' });
    writeComposerDraft(editor, { text: 'y', json: { nope: 1 } });
    expect(setDocument.mock.calls.map(([type]) => type)).toEqual(['text', 'text']);
  });
});

describe('normalizeComposerDraft / composerDraftEquals', () => {
  it('字符串、空值、没有 json 的对象都归一成同一形状', () => {
    expect(normalizeComposerDraft(null)).toBe(EMPTY_COMPOSER_DRAFT);
    expect(normalizeComposerDraft('')).toBe(EMPTY_COMPOSER_DRAFT);
    expect(normalizeComposerDraft({ text: '', json: { root: {} } })).toBe(EMPTY_COMPOSER_DRAFT);
    expect(normalizeComposerDraft('abc')).toEqual({ text: 'abc' });
    expect(normalizeComposerDraft({ text: 'abc', json: undefined })).toEqual({ text: 'abc' });
    const withJson = { text: 'abc', json: { root: { children: [] } } };
    expect(normalizeComposerDraft(withJson)).toBe(withJson);
  });

  it('文本和 json 序列化都相同才算相等', () => {
    const json = { root: { children: [{ type: 'text', text: 'a' }] } };
    expect(composerDraftEquals({ text: 'a', json }, { text: 'a', json: structuredClone(json) })).toBe(true);
    expect(composerDraftEquals({ text: 'a', json }, { text: 'a' })).toBe(false);
    expect(composerDraftEquals({ text: 'a' }, { text: 'a' })).toBe(true);
    expect(composerDraftEquals({ text: 'a', json }, { text: 'b', json })).toBe(false);
  });
});
