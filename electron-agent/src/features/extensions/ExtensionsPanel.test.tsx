import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
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
  it('exposes MCP and the native local Skills tab, without retired code intelligence', async () => {
    getSettings.mockResolvedValueOnce({});
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('ext-tab-mcp')).toBeTruthy());
    expect(screen.queryByTestId('ext-tab-code-intel')).toBeNull();
    expect(screen.getByTestId('ext-tab-skills')).toBeTruthy();
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
});
