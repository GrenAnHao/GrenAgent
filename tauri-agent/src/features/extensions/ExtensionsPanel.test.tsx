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

import { ExtensionsPanel } from './ExtensionsPanel';

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

  it('lists skills (apiSource=skill only) and toggles disabled state', async () => {
    getSettings.mockResolvedValueOnce({});
    getCommands.mockResolvedValueOnce([
      { name: 'openspec-propose', description: 'propose a change', source: 'api', apiSource: 'skill' },
      { name: 'bash', source: 'api', apiSource: 'builtin' },
    ]);
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('skill-openspec-propose')).toBeTruthy());
    expect(screen.queryByTestId('skill-bash')).toBeNull();
    expect(screen.getByTestId('skill-toggle-openspec-propose').textContent).toContain('已启用');
    fireEvent.click(screen.getByTestId('skill-toggle-openspec-propose'));
    expect(screen.getByTestId('skill-toggle-openspec-propose').textContent).toContain('已禁用');
  });
});
