import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { StreamingFileBody } from './StreamingFileBody';
import { HL_MAX_CHARS } from './streamingFileModel';

vi.mock('./LazyHighlighter', () => ({
  // 不带 .shiki / .line / hl-shell：真实高亮在正文持续增长时初始化完不了，
  // 可见文本不能等这个信号。
  LazySyntaxHighlighter: (p: { animated?: boolean; language: string; children: string }) => (
    <pre data-animated={String(Boolean(p.animated))} data-language={p.language} data-testid="hl-shell">{p.children}</pre>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('StreamingFileBody', () => {
  it('write 把完整内容交给流式高亮器', () => {
    wrap(<StreamingFileBody toolName="write" args={{ path: 'a.ts', content: 'const a' }} />);
    const node = screen.getByTestId('hl-shell');
    expect(node.getAttribute('data-animated')).toBe('true');
    expect(node.getAttribute('data-language')).toBe('typescript');
    expect(node.textContent).toBe('const a');
  });

  it('追加时仍是完整文本，不是尾部切片', async () => {
    const { rerender } = wrap(<StreamingFileBody toolName="write" args={{ path: 'a.ts', content: 'const a' }} />);
    rerender(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="write" args={{ path: 'a.ts', content: 'const a = 1\n' }} />
      </ThemeProvider>,
    );
    const node = await screen.findByTestId('hl-shell');
    expect(node.textContent).toBe('const a = 1\n');
    expect(node.textContent?.startsWith('const a')).toBe(true);
  });

  it('路径未知但能看出语言时走高亮', () => {
    wrap(<StreamingFileBody toolName="write" args={{ content: 'def main():\n    return 1\n' }} />);
    expect(screen.getByTestId('hl-shell').getAttribute('data-language')).toBe('python');
  });

  it('路径未知且无法判断时用纯文本', () => {
    wrap(<StreamingFileBody toolName="write" args={{ content: 'x' }} />);
    expect(screen.queryByTestId('hl-shell')).toBeNull();
    expect(screen.getByTestId('streaming-file-body').textContent).toContain('x');
  });

  it('超过阈值后单向降级，内容变短也不再高亮', () => {
    const big = `${'line\n'.repeat(2000)}${'x'.repeat(HL_MAX_CHARS)}`;
    const { rerender } = wrap(<StreamingFileBody toolName="write" args={{ path: 'a.ts', content: big }} />);
    expect(screen.queryByTestId('hl-shell')).toBeNull();
    expect(screen.getByTestId('streaming-file-body').textContent).toContain('已省略');
    rerender(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="write" args={{ path: 'a.ts', content: 'short' }} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('hl-shell')).toBeNull();
  });

  it('edit 先显示删除块，补上 newText 后新增块在后', () => {
    const { rerender } = wrap(
      <StreamingFileBody toolName="edit" args={{ path: 'a.ts', edits: [{ oldText: 'a' }] }} />,
    );
    expect(screen.getAllByTestId('hl-shell')).toHaveLength(1);
    expect(document.querySelector('[data-kind="old"]')?.textContent).toContain('a');
    rerender(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="edit" args={{ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }} />
      </ThemeProvider>,
    );
    const kinds = [...document.querySelectorAll('[data-kind]')].map((node) => node.getAttribute('data-kind'));
    expect(kinds).toEqual(['old', 'new']);
  });

  it('edit 超过 3 对时只高亮最后 3 对', () => {
    const edits = [1, 2, 3, 4].map((n) => ({ oldText: `old-${n}`, newText: `new-${n}` }));
    wrap(<StreamingFileBody toolName="edit" args={{ path: 'a.ts', edits }} />);
    const text = screen.getByTestId('streaming-file-body').textContent ?? '';
    expect(text).toContain('第 1 处');
    expect(screen.queryByText('old-1')).toBeNull();
    expect(screen.getAllByTestId('hl-shell').map((node) => node.textContent)).toEqual([
      'old-2', 'new-2', 'old-3', 'new-3', 'old-4', 'new-4',
    ]);
  });

  it('空参数显示等待参数', () => {
    wrap(<StreamingFileBody toolName="write" args={{}} />);
    expect(screen.getByTestId('streaming-file-body').textContent).toContain('等待参数');
  });

  it('内容增长时滚到底部', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const { rerender } = wrap(<StreamingFileBody toolName="write" args={{ content: 'a' }} />);
    const flush = () => {
      const pending = frames.splice(0, frames.length);
      for (const cb of pending) cb(0);
    };
    flush();
    flush();
    const scroller = screen.getByTestId('streaming-file-body');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 480 });
    rerender(
      <ThemeProvider themeMode="dark">
        <StreamingFileBody toolName="write" args={{ content: 'a\nb\nc' }} />
      </ThemeProvider>,
    );
    flush();
    flush();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});
