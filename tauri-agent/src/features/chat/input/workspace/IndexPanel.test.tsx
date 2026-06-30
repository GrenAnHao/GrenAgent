import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { codeIntelStatus, codeIntelInit, codeIntelSync, codeIntelReindex } = vi.hoisted(() => ({
  codeIntelStatus: vi.fn(() =>
    Promise.resolve(JSON.stringify({ indexed: true, project: 'ws', nodes: 99, edges: 10 })),
  ),
  codeIntelInit: vi.fn(() => Promise.resolve('initialized')),
  codeIntelSync: vi.fn(() => Promise.resolve('synced')),
  codeIntelReindex: vi.fn(() => Promise.resolve('rebuilt')),
}));
vi.mock('../../../../lib/codeIntelIo', () => ({
  codeIntelStatus,
  codeIntelInit,
  codeIntelSync,
  codeIntelReindex,
  codeIntelIsInitialized: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

import { ThemeProvider } from '@lobehub/ui';
import { IndexButton, IndexView } from './IndexPanel';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView() {
  return render(
    <ThemeProvider>
      <IndexView workspace="/ws" />
    </ThemeProvider>,
  );
}

describe('IndexButton', () => {
  it('renders the index chip', () => {
    render(
      <ThemeProvider>
        <IndexButton />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('code-index-button')).toBeTruthy();
  });

  // 回归：content 为空会触发 antd Popover 的 noTitle 短路、吞掉 onOpenChange，导致点击打不开。
  it('opens the panel when the chip is clicked', async () => {
    render(
      <ThemeProvider>
        <IndexButton />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('code-index-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('code-index-button'));
    await waitFor(() => expect(screen.getByTestId('code-index-panel')).toBeTruthy());
  });
});

describe('IndexView', () => {
  it('loads status on mount and renders parsed stats', async () => {
    renderView();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalledWith('/ws'));
    // 已索引状态：状态 pill + 统计卡渲染（原始日志默认折叠）。
    await waitFor(() => expect(screen.getByTestId('code-intel-state').textContent).toContain('已索引'));
    expect(screen.getByText('99')).toBeTruthy();
  });

  it('runs init and refreshes status', async () => {
    renderView();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('code-intel-init'));
    await waitFor(() => expect(codeIntelInit).toHaveBeenCalledWith('/ws'));
    // init 后会再拉一次状态。
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalledTimes(2));
  });

  it('runs incremental sync', async () => {
    renderView();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('code-intel-sync'));
    await waitFor(() => expect(codeIntelSync).toHaveBeenCalledWith('/ws'));
  });

  it('runs reindex', async () => {
    renderView();
    await waitFor(() => expect(codeIntelStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('code-intel-reindex'));
    await waitFor(() => expect(codeIntelReindex).toHaveBeenCalledWith('/ws'));
  });
});
