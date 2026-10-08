// @vitest-environment jsdom
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { $createCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';
import type { IEditor } from '@lobehub/editor';
import {
  $caretAtDocumentStart,
  focusMissingPillArg,
  readComposerText,
  readPillInvocation,
  substitutePillMarker,
} from './composerText';

const params = [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }];

function editorWith(values: string[]) {
  const editor = createEditor({ nodes: [CommandPillNode], onError: (error) => { throw error; } });
  let key = '';
  editor.update(() => {
    const node = $createCommandPillNode('refactor', params, values);
    key = node.getKey();
    $getRoot().append($createParagraphNode().append(node, $createTextNode(' 顺便')));
  }, { discrete: true });
  return { editor, key };
}

const M = PILL_MARKER;

describe('substitutePillMarker', () => {
  it('调用文本总在开头，与剩余正文之间一个空格', () => {
    expect(substitutePillMarker(`${M} 顺便`, '/a "x"')).toBe('/a "x" 顺便');
    expect(substitutePillMarker(`${M}顺便`, '/a "x"')).toBe('/a "x" 顺便');
    expect(substitutePillMarker(`前面${M} 后面`, '/a "x"')).toBe('/a "x" 前面 后面');
    expect(substitutePillMarker(M, '/a "x"')).toBe('/a "x"');
  });

  it('标记后是多行正文时保留换行', () => {
    expect(substitutePillMarker(`${M}\n第一行\n第二行`, '/a "x"')).toBe('/a "x" 第一行\n第二行');
  });

  it('多余标记删掉', () => {
    expect(substitutePillMarker(`${M}${M}`, '/a')).toBe('/a');
  });

  it('没有调用文本时只删标记，其余原样', () => {
    expect(substitutePillMarker(`a${M}b`, null)).toBe('ab');
  });

  it('无标记原样返回', () => {
    expect(substitutePillMarker('无标记', '/a')).toBe('无标记');
  });
});

describe('readComposerText', () => {
  it('markdown 去转义，调用文本放在开头', () => {
    const lexical = editorWith(['a\\b', '']).editor;
    const editor = {
      getDocument: () => `x\\_y ${M}`,
      getLexicalEditor: () => lexical,
    } as unknown as IEditor;
    expect(readComposerText(editor)).toBe('/refactor "a\\\\b" "" x_y');
  });

  it('拿不到 lexical 实例时只删标记', () => {
    const editor = { getDocument: () => `x\\_y ${M}` } as unknown as IEditor;
    expect(readComposerText(editor)).toBe('x_y ');
  });
});

describe('readPillInvocation', () => {
  it('读出胶囊的调用文本，没有编辑器时为 null', () => {
    expect(readPillInvocation(editorWith(['a\\b', '']).editor)).toBe('/refactor "a\\\\b" ""');
    expect(readPillInvocation(null)).toBeNull();
  });
});

describe('focusMissingPillArg', () => {
  it('必填参数空着时派发聚焦并返回 true', () => {
    const { editor, key } = editorWith(['', '']);
    const spy = vi.fn(() => true);
    editor.registerCommand(FOCUS_PILL_ARG_COMMAND, spy, 0);
    expect(focusMissingPillArg(editor)).toBe(true);
    expect(spy).toHaveBeenCalledWith({ key, index: 0, invalid: true }, editor);
  });

  it('有默认值的参数空着不算缺', () => {
    expect(focusMissingPillArg(editorWith(['a.ts', '']).editor)).toBe(false);
    expect(focusMissingPillArg(undefined)).toBe(false);
  });
});

describe('$caretAtDocumentStart', () => {
  it('空文档、首段开头为 true，其他位置为 false', () => {
    const editor = createEditor({ nodes: [], onError: (error) => { throw error; } });
    const results: boolean[] = [];
    editor.update(() => {
      const paragraph = $createParagraphNode();
      const text = $createTextNode('abc');
      $getRoot().append(paragraph.append(text));
      paragraph.select(0, 0);
      results.push($caretAtDocumentStart());
      text.select(1, 1);
      results.push($caretAtDocumentStart());
      text.select(0, 0);
      results.push($caretAtDocumentStart());
    }, { discrete: true });
    expect(results).toEqual([true, false, true]);
  });
});
