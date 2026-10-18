// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scrollToIndex = vi.hoisted(() => vi.fn());
const WINDOW = 30;
// jsdom 没有布局，真的 Virtualizer 量不出视口、一行都不挂；这里换成只挂前 WINDOW 个子元素的替身，
// 记录收到了多少行，并让 ref 可断言。真实的窗口化行为由 ui-harness 的 code-retrieval-panel 场景验证。
vi.mock('virtua', async () => {
  const React = await import('react');
  return {
    Virtualizer: React.forwardRef(function FakeVirtualizer({ data, children }: { data: string[]; children: (item: string, index: number) => React.ReactElement }, ref) {
      React.useImperativeHandle(ref, () => ({ scrollToIndex }) as never);
      const visible = data.slice(0, WINDOW).map((item, index) => children(item, index));
      return React.createElement('div', { 'data-testid': 'virtualizer', 'data-child-count': data.length }, visible);
    }),
  };
});
import { CodeSourceLines, VIRTUALIZE_LINE_THRESHOLD, type CodeSourceLinesHandle } from './CodeSourceLines';

const lines = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`);
const rendered = () => document.querySelectorAll('[data-source-line]').length;
const scrollIntoView = vi.fn();

describe('CodeSourceLines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  });
  afterEach(cleanup);

  it('renders a short file in full without a virtualizer, so selecting and copying the whole preview keeps working', () => {
    render(<CodeSourceLines lines={lines(VIRTUALIZE_LINE_THRESHOLD)} />);
    expect(screen.queryByTestId('virtualizer')).toBeNull();
    expect(rendered()).toBe(VIRTUALIZE_LINE_THRESHOLD);
    expect(screen.getByTestId(`code-source-line-${VIRTUALIZE_LINE_THRESHOLD}`)).toBeTruthy();
  });

  it('hands a long file to the virtualizer instead of mounting every line itself', () => {
    render(<CodeSourceLines lines={lines(VIRTUALIZE_LINE_THRESHOLD + 1)} />);
    expect(screen.getByTestId('virtualizer').getAttribute('data-child-count')).toBe(String(VIRTUALIZE_LINE_THRESHOLD + 1));
    expect(rendered()).toBe(WINDOW);
    expect(screen.getByTestId('code-source-line-1').textContent).toContain('const line1 = 1;');
    expect(screen.queryByTestId(`code-source-line-${VIRTUALIZE_LINE_THRESHOLD + 1}`)).toBeNull();
  });

  it('keeps line numbers, the test ids and the aria-current marker on the target line', () => {
    render(<CodeSourceLines lines={lines(5)} target={3} />);
    const line = screen.getByTestId('code-source-line-3');
    expect(line.getAttribute('aria-current')).toBe('location');
    expect(line.querySelector('[data-line-number]')!.textContent).toBe('3');
    expect(screen.getByTestId('code-source-line-2').getAttribute('aria-current')).toBeNull();
  });

  it('keeps the empty-line placeholder so blank lines still take a row', () => {
    render(<CodeSourceLines lines={['a', '', 'c']} />);
    expect(screen.getByTestId('code-source-line-2').querySelector('code')!.textContent).toBe(' ');
  });

  it('scrolls a short file to the line with scrollIntoView', () => {
    const handle = createRef<CodeSourceLinesHandle>();
    render(<CodeSourceLines ref={handle} lines={lines(50)} />);
    handle.current!.scrollToLine(7);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId('code-source-line-7'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('scrolls a long file by index, because the target line may not be mounted at all', () => {
    const handle = createRef<CodeSourceLinesHandle>();
    render(<CodeSourceLines ref={handle} lines={lines(20_000)} />);
    handle.current!.scrollToLine(15_000);
    expect(scrollToIndex).toHaveBeenCalledWith(14_999, { align: 'center' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([0, -1, 6])('does nothing for line %s, which is not in a 5-line file', (line) => {
    const handle = createRef<CodeSourceLinesHandle>();
    render(<CodeSourceLines ref={handle} lines={lines(5)} />);
    expect(() => handle.current!.scrollToLine(line)).not.toThrow();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does nothing for a line past the end of a long file', () => {
    const handle = createRef<CodeSourceLinesHandle>();
    render(<CodeSourceLines ref={handle} lines={lines(20_000)} />);
    handle.current!.scrollToLine(20_001);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
