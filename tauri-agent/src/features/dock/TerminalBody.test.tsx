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
const onShellOutput = vi.fn(async (..._args: unknown[]) => () => {});
vi.mock('../../lib/terminal', () => ({
  terminal: {
    shellStart: (...a: unknown[]) => shellStart(...a),
    shellStop: (...a: unknown[]) => shellStop(...a),
    shellWrite: vi.fn(async () => {}),
    onShellOutput: (...a: unknown[]) => onShellOutput(...a),
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
});
