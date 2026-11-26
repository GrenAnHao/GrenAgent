import { StrictMode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xterm/css/xterm.css', () => ({}));
const { openTerm, writeTerm } = vi.hoisted(() => ({ openTerm: vi.fn(), writeTerm: vi.fn() }));
vi.mock('xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    rows = 0;
    cols = 0;
    loadAddon() {}
    open = openTerm;
    onData() {
      return { dispose() {} };
    }
    write = writeTerm;
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
    shellResize: vi.fn(async () => {}),
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
  it('buffers early PTY output until xterm can measure its real font', async () => {
    let release!: () => void;
    const loading = new Promise<void>(resolve => { release = resolve; });
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => false, load: () => loading } });
    openTerm.mockClear();
    writeTerm.mockClear();
    try {
      useDockStore.setState({ tabs: [termTab], activeByRegion: { right: null, bottom: termTab.id } });
      render(<TerminalBody tab={termTab} active />);
      await waitFor(() => expect(useDockStore.getState().tabs.find(t => t.id === termTab.id)?.payload).toMatchObject({ shellId: 'sh-1' }));
      for (const listener of activeShellListeners) listener({ type: 'output', session_id: 'sh-1', data: 'ready>' });
      expect(openTerm).not.toHaveBeenCalled();
      expect(writeTerm).not.toHaveBeenCalled();
      release();
      await waitFor(() => expect(writeTerm).toHaveBeenCalledWith('ready>'));
      expect(openTerm).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
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
