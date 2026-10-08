// @vitest-environment jsdom
import { createEditor, $getRoot, $createParagraphNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $createCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';

const params = [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }];

function withEditor<T>(fn: () => T): T {
  const editor = createEditor({ nodes: [CommandPillNode], onError: (error) => { throw error; } });
  let result!: T;
  editor.update(() => { result = fn(); }, { discrete: true });
  return result;
}

describe('CommandPillNode', () => {
  it('values 补齐到参数个数，getTextContent 是调用文本', () => {
    const text = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, ['a "b"']);
      $getRoot().append($createParagraphNode().append(node));
      return node.getTextContent();
    });
    expect(text).toBe('/refactor "a \\"b\\"" ""');
  });

  it('setValue 生成新值数组，不改原数组', () => {
    const [before, after] = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, []);
      $getRoot().append($createParagraphNode().append(node));
      const original = node.values;
      return [original, node.setValue(1, 'oop').values];
    });
    expect(before).toEqual(['', '']);
    expect(after).toEqual(['', 'oop']);
  });

  it('exportJSON / importJSON 往返', () => {
    const json = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, ['x', '']);
      $getRoot().append($createParagraphNode().append(node));
      return node.exportJSON();
    });
    expect(json).toMatchObject({ type: 'command-pill', name: 'refactor', params, values: ['x', ''] });
    const back = withEditor(() => CommandPillNode.importJSON(json).values);
    expect(back).toEqual(['x', '']);
  });

  it('标记字符是私用区字符，remark 不会转义', () => {
    expect(PILL_MARKER).toBe(String.fromCharCode(0xe000));
  });
});
