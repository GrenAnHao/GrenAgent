import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace, getCommands } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
  getCommands: vi.fn((): Promise<unknown> => Promise.resolve([])),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace, getCommands },
}));
// parseCommands passthrough so the test feeds PiCommand[] directly via getCommands.
vi.mock('../chat/input/commandUtils', () => ({ parseCommands: (raw: unknown) => raw }));

import { ThemeProvider } from '@lobehub/ui';
import { ExtensionsPanel } from './ExtensionsPanel';

// jsdom 下 Modal/Switch 重渲染较慢，放宽超时避免误判。
vi.setConfig({ testTimeout: 20000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExtensionsPanel', () => {
  it('lists MCP servers from MCP_SERVERS (standard mcpServers format)', async () => {
    getSettings.mockResolvedValueOnce({
      MCP_SERVERS: '{"mcpServers":{"fs":{"command":"npx","args":[]},"api":{"url":"https://m"}}}',
    });
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mcp-server-fs')).toBeTruthy());
    expect(screen.getByTestId('mcp-server-fs').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-api').textContent).toContain('sse');
  });

  it('switches to the skills tab and lists skills (apiSource=skill only), toggling via the switch', async () => {
    getSettings.mockResolvedValueOnce({});
    getCommands.mockResolvedValueOnce([
      { name: 'openspec-propose', description: 'propose a change', source: 'api', apiSource: 'skill' },
      { name: 'bash', source: 'api', apiSource: 'builtin' },
    ]);
    render(<ExtensionsPanel />);
    // 默认展示「插件」(MCP) 页，切到「技能」页才渲染 skills。
    fireEvent.click(screen.getByTestId('ext-tab-skills'));
    await waitFor(() => expect(screen.getByTestId('skill-openspec-propose')).toBeTruthy());
    expect(screen.queryByTestId('skill-bash')).toBeNull();
    const toggle = screen.getByTestId('skill-toggle-openspec-propose');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.getByTestId('skill-toggle-openspec-propose').getAttribute('aria-checked')).toBe('false');
  });

  it('hides the restart button until a change, then persists and restarts the sidecar', async () => {
    getSettings.mockResolvedValueOnce({});
    getCommands.mockResolvedValueOnce([{ name: 'demo-skill', source: 'api', apiSource: 'skill' }]);
    render(<ExtensionsPanel />);
    // 无改动时不显示「重启生效」按钮。
    expect(screen.queryByTestId('ext-restart')).toBeNull();

    fireEvent.click(screen.getByTestId('ext-tab-skills'));
    await waitFor(() => expect(screen.getByTestId('skill-toggle-demo-skill')).toBeTruthy());

    // 拨动开关后出现「重启生效」按钮。
    fireEvent.click(screen.getByTestId('skill-toggle-demo-skill'));
    fireEvent.click(screen.getByTestId('ext-restart'));

    // 点击后：持久化 + 重启 sidecar（close + open）。
    await waitFor(() => {
      expect(setSettings).toHaveBeenCalled();
      expect(closeWorkspace).toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalled();
    });
    // 重启完成后按钮再次隐藏。
    await waitFor(() => expect(screen.queryByTestId('ext-restart')).toBeNull());
  });

  it('opens the add modal from the add button', async () => {
    getSettings.mockResolvedValueOnce({});
    render(
      <ThemeProvider>
        <ExtensionsPanel />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByTestId('mcp-add'));
    await waitFor(() => expect(screen.getByTestId('add-mcp-modal')).toBeTruthy());
  });
});
