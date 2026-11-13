// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeSourceLines, type CodeSourceLinesHandle } from './CodeSourceLines';

// jsdom 没有布局：CM 的居中滚动落到 scrollTo 时给个无操作替身，真实几何由 ui-harness 验证。
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: () => {} });
});
afterEach(cleanup);

const lines = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`);

describe('CodeSourceLines (CodeMirror read-only)', () => {
  it('renders the document with line numbers', () => {
    render(<CodeSourceLines lines={lines(5)} />);
    expect(screen.getByText('const line3 = 3;')).toBeTruthy();
    expect(document.querySelectorAll('.cm-line').length).toBe(5);
    expect(document.querySelector('.cm-gutters')!.textContent).toContain('3');
  });

  it('marks the target line with the accent decoration and moves it when target changes', () => {
    const { rerender } = render(<CodeSourceLines lines={lines(5)} target={3} />);
    expect(document.querySelector('.cm-target-line')!.textContent).toBe('const line3 = 3;');
    rerender(<CodeSourceLines lines={lines(5)} target={2} />);
    expect(document.querySelector('.cm-target-line')!.textContent).toBe('const line2 = 2;');
    rerender(<CodeSourceLines lines={lines(5)} />);
    expect(document.querySelector('.cm-target-line')).toBeNull();
  });

  it('loads syntax highlighting for the file language', async () => {
    render(<CodeSourceLines lines={['export function parse(input: string) {', '  return input', '}']} path="src/a.ts" />);
    await waitFor(() => expect(document.querySelector('.cm-line span[class]')).toBeTruthy());
  });

  it('replaces the document when the file content changes', () => {
    const { rerender } = render(<CodeSourceLines lines={lines(3)} />);
    rerender(<CodeSourceLines lines={['beta content']} />);
    expect(screen.getByText('beta content')).toBeTruthy();
    expect(screen.queryByText('const line1 = 1;')).toBeNull();
  });

  it('scrollToLine tolerates out-of-range lines and accepts in-range ones', () => {
    const handle = createRef<CodeSourceLinesHandle>();
    render(<CodeSourceLines ref={handle} lines={lines(5)} />);
    expect(() => handle.current!.scrollToLine(0)).not.toThrow();
    expect(() => handle.current!.scrollToLine(-1)).not.toThrow();
    expect(() => handle.current!.scrollToLine(6)).not.toThrow();
    expect(() => handle.current!.scrollToLine(3)).not.toThrow();
  });
});
