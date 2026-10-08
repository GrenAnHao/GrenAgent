// @vitest-environment jsdom
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { $createCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';
import { $caretAtDocumentStart, focusMissingPillArg, readPillInvocation, substitutePillMarker } from './composerText';

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

describe('substitutePillMarker', () => {
  it('把第一个标记换成调用文本，多余标记删掉', () => {
    expect(substitutePillMarker(`${PILL_MARKER} 顺便`, '/a "x"')).toBe('/a "x" 顺便');
    expect(substitutePillMarker(`${PILL_MARKER}${PILL_MARKER}`, '/a')).toBe('/a');
    expect(substitutePillMarker('无标记', '/a')).toBe('无标记');
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
