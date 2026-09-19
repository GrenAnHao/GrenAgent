import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace, packageList, reloadMcpServer, probeMcpServer, readMcpToolsCache } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
  packageList: vi.fn(() => Promise.resolve([])),
  reloadMcpServer: vi.fn(() => Promise.resolve()),
  probeMcpServer: vi.fn(() => Promise.resolve(JSON.stringify({ ok: true, toolNames: [] }))),
  readMcpToolsCache: vi.fn(() => Promise.resolve(JSON.stringify({
    fs: { ok: true, toolNames: ['mcp__fs__t'], probedAt: 't' },
  }))),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace, packageList, reloadMcpServer },
}));
vi.mock('../../lib/mcpPolicyIo', () => ({
  probeMcpServer,
  readMcpPolicy: () => Promise.resolve(''),
  readMcpToolsCache,
  writeMcpPolicy: () => Promise.resolve(),
}));

import { ThemeProvider } from '@lobehub/ui';
import { ExtensionsPanel } from './ExtensionsPanel';

// jsdom 下 Modal/Switch/Popconfirm 重渲染较慢（本机 transform/import 开销大），放宽超时避免误判。
vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExtensionsPanel', () => {
  it('exposes MCP, packages, and skills tabs, without retired code intelligence', async () => {
    getSettings.mockResolvedValueOnce({});
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('ext-tab-mcp')).toBeTruthy());
    expect(screen.getByTestId('ext-tab-mcp').textContent).toContain('MCP');
    expect(screen.getByTestId('ext-tab-mcp').textContent).not.toContain('插件');
    expect(screen.getByTestId('ext-tab-packages')).toBeTruthy();
    expect(screen.getByTestId('ext-tab-packages').textContent).toContain('扩展');
    expect(screen.getByTestId('ext-tab-skills')).toBeTruthy();
    expect(screen.queryByTestId('ext-tab-code-intel')).toBeNull();
  });

  it('lists MCP servers from MCP_SERVERS (standard mcpServers format)', async () => {
    getSettings.mockResolvedValueOnce({
      MCP_SERVERS: '{"mcpServers":{"fs":{"command":"npx","args":[]},"api":{"url":"https://m"}}}',
    });
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mcp-server-fs')).toBeTruthy());
    expect(screen.getByTestId('mcp-server-fs').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-api').textContent).toContain('sse');
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

  it('reload button reconnects the live server instead of probing', async () => {
    getSettings.mockResolvedValueOnce({
      MCP_SERVERS: '{"mcpServers":{"fs":{"command":"npx","args":[]}}}',
    });
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mcp-reload-fs')).toBeTruthy());
    expect(screen.getByTestId('extensions-panel').textContent).toContain('点「重载」');
    probeMcpServer.mockClear();
    fireEvent.click(screen.getByTestId('mcp-reload-fs'));
    await waitFor(() => expect(reloadMcpServer).toHaveBeenCalledWith('/ws', 'fs'));
    expect(probeMcpServer).not.toHaveBeenCalled();
  });
});
