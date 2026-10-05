import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { StreamingCodeView } from './StreamingCodeView';

afterEach(cleanup);

const view = (content: string) => (
  <ThemeProvider themeMode="dark">
    <StreamingCodeView content={content} path="src/app/main.py" />
  </ThemeProvider>
);

function lines(): HTMLElement[] {
  const shadow = screen.getByTestId('streaming-code-view').querySelector('diffs-container')?.shadowRoot;
  return [...(shadow?.querySelectorAll('[data-line]') ?? [])] as HTMLElement[];
}

// 不 mock pierre：这条用例要证明真的走通了 FileStream + shiki + lobe-theme，
// 而不只是我们把增量算对了。
describe('StreamingCodeView 真实渲染', { timeout: 30_000 }, () => {
  it('逐行追加，已渲染的行节点保持不变', async () => {
    const { rerender } = render(view('import os\n'));
    await waitFor(() => expect(lines().length).toBeGreaterThanOrEqual(1));
    const first = lines()[0];
    expect(first.textContent).toContain('import os');
    // 关键词被切成带颜色的 token，而不是一整段纯文本。
    expect(first.querySelectorAll('span').length).toBeGreaterThan(1);

    rerender(view('import os\nimport sys\n'));
    await waitFor(() => expect(lines().length).toBeGreaterThanOrEqual(2));
    rerender(view('import os\nimport sys\nx = 1\n'));
    await waitFor(() => expect(lines().length).toBeGreaterThanOrEqual(3));

    // 追加不重建：第一行还是同一个 DOM 节点。
    expect(lines()[0]).toBe(first);
    expect(lines()[1]?.textContent).toContain('import sys');
    expect(lines()[2]?.textContent).toContain('x = 1');
  });
});
