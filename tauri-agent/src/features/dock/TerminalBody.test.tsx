import { StrictMode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xterm/css/xterm.css', () => ({}));
vi.mock('xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    rows = 0;
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    focus() {}
    refresh() {}
    dispose() {}
  },
}));
vi.mock('xterm-addon-fit', () => ({ FitAddon: class { fit() {} } }));

const shellStart = vi.fn(async (..._args: unknown[]) => ({ session_id: 'sh-1' }));
const shellStop = vi.fn(async (..._args: unknown[]) => {});
/** 当前活跃的 shell-output 监听器集合：注册时加入、注销时移除。用于检测重复/泄漏。 */
const activeShellListeners = new Set<(event: unknown) => void>();
const onShellOutput = vi.fn(async (handler: (event: unknown) => void) => {
  activeShellListeners.add(handler);
  return () => {
    activeShellListeners.delete(handler);
  };
});
vi.mock('../../lib/terminal', () => ({
  terminal: {
    shellStart: (...a: unknown[]) => shellStart(...a),
    shellStop: (...a: unknown[]) => shellStop(...a),
    shellWrite: vi.fn(async () => {}),
    onShellOutput: (handler: (event: unknown) => void) => onShellOutput(handler),
  },
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));

import { TerminalBody } from './TerminalBody';
import { useDockStore, type DockTab } from '../../stores/dockStore';

const termTab: DockTab = { id: 'term-1', kind: 'terminal', region: 'bottom', title: 'PowerShell', closable: true, order: 0, payload: { status: 'idle' } };

afterEach(() => {
  cleanup();
  localStorage.clear();
  useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: 'term-1' } });
  shellStart.mockClear();
  activeShellListeners.clear();
});

describe('TerminalBody', () => {
  it('starts a shell on mount and reports running status into dockStore', async () => {
    useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: 'term-1' } });
    render(<TerminalBody tab={termTab} active />);
    await waitFor(() => expect(shellStart).toHaveBeenCalledWith('/ws'));
    await waitFor(() => {
      const t = useDockStore.getState().tabs.find((x) => x.id === 'term-1')!;
      expect((t.payload as { status: string }).status).toBe('running');
      expect((t.payload as { shellId?: string }).shellId).toBe('sh-1');
    });
  });

  // 回归：StrictMode 双挂载时，异步 listen() 的 cleanup 竞态会泄漏一个永不注销的
  // shell-output 监听器，导致每个输出字节被写两次（终端重复/打字翻倍/TUI 错位）。
  it('does not leak a duplicate shell-output listener under StrictMode double-mount', async () => {
    useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: 'term-1' } });
    render(
      <StrictMode>
        <TerminalBody tab={termTab} active />
      </StrictMode>,
    );
    await waitFor(() => expect(shellStart).toHaveBeenCalled());
    await waitFor(() => expect(activeShellListeners.size).toBe(1));
  });
});
