import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: string[] = [];
const state = { instances: 0, cleanUps: 0, options: null as Record<string, unknown> | null };

vi.mock('@pierre/diffs', () => ({
  // 只替掉 pierre 的渲染器：测的是「喂进去的是增量而不是全文」和实例生命周期，
  // 真跑 shiki 在 jsdom 里既慢又依赖 constructable stylesheet（真实渲染见 .real.test.tsx）。
  resolveTheme: async () => ({}),
  registerCustomTheme: () => {},
  FileStream: class {
    constructor(options: Record<string, unknown>) {
      state.instances += 1;
      state.options = options;
    }
    async setup(source: ReadableStream<string>, wrapper: HTMLElement) {
      wrapper.appendChild(document.createElement('diffs-container'));
      const reader = source.getReader();
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value != null) pushed.push(value);
        }
      })();
    }
    cleanUp() {
      state.cleanUps += 1;
    }
    setThemeType() {}
  },
}));

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { StreamingCodeView } from './StreamingCodeView';

afterEach(cleanup);
beforeEach(() => {
  pushed.length = 0;
  state.instances = 0;
  state.cleanUps = 0;
  state.options = null;
});

const view = (content: string) => (
  <ThemeProvider themeMode="dark">
    <StreamingCodeView content={content} path="src/app/main.py" />
  </ThemeProvider>
);

describe('StreamingCodeView', () => {
  it('高亮还没画出来时，正文和行数已经跟着变', () => {
    const { rerender } = render(view('hello'));
    expect(screen.getByTestId('streaming-code-fallback').textContent).toContain('hello');
    expect(screen.getByTestId('code-card-stats').textContent).toContain('+1');
    rerender(view('hello\nworld'));
    expect(screen.getByTestId('streaming-code-fallback').textContent).toContain('world');
    expect(screen.getByTestId('code-card-stats').textContent).toContain('+2');
  });

  it('只建一个流，正文增长时只推送新增部分', async () => {
    const { rerender } = render(view('import os\n'));
    await waitFor(() => expect(pushed).toEqual(['import os\n']));
    rerender(view('import os\nimport sys\n'));
    await waitFor(() => expect(pushed).toEqual(['import os\n', 'import sys\n']));
    rerender(view('import os\nimport sys\nx = 1\n'));
    await waitFor(() => expect(pushed).toEqual(['import os\n', 'import sys\n', 'x = 1\n']));
    expect(state.instances).toBe(1);
  });

  it('按路径推导语言并带上文件名标题', async () => {
    render(view('x = 1\n'));
    await waitFor(() => expect(state.options).not.toBeNull());
    expect(state.options?.lang).toBe('python');
    expect(screen.getByTestId('code-card-name').textContent).toBe('main.py');
  });

  it('卸载时收掉流并清空容器', async () => {
    const { unmount } = render(view('x = 1\n'));
    await waitFor(() => expect(pushed.length).toBe(1));
    const host = screen.getByTestId('streaming-code-view');
    expect(host.querySelector('diffs-container')).not.toBeNull();
    unmount();
    expect(state.cleanUps).toBe(1);
    expect(host.querySelector('diffs-container')).toBeNull();
  });
});
