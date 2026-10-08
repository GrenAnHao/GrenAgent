// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createEditor } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { CommandPillEditor } from './CommandPillEditor';
import { CommandPillNode } from './CommandPillNode';
import { CommandPillHostContext } from './hostContext';

function renderPill() {
  const editor = createEditor({ nodes: [CommandPillNode], onError: (error) => { throw error; } });
  const submit = vi.fn();
  render(
    <CommandPillHostContext.Provider value={{ submit }}>
      <CommandPillEditor editor={editor} nodeKey="pill" name="refactor" params={[{ name: 'file' }]} values={['a.ts']} />
    </CommandPillHostContext.Provider>,
  );
  const input = screen.getByTestId('command-pill').querySelector('input');
  if (!input) throw new Error('参数框没渲染');
  return { input, submit };
}

function pressEnter(input: HTMLInputElement, init: KeyboardEventInit = {}) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
}

describe('CommandPillEditor 提交', () => {
  it('参数里按 Enter 走普通发送', () => {
    const { input, submit } = renderPill();
    pressEnter(input);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(undefined);
  });

  it('Ctrl+Enter / Cmd+Enter 透传打断', () => {
    const { input, submit } = renderPill();
    pressEnter(input, { ctrlKey: true });
    pressEnter(input, { metaKey: true });
    expect(submit).toHaveBeenNthCalledWith(1, { interrupt: true });
    expect(submit).toHaveBeenNthCalledWith(2, { interrupt: true });
  });
});
