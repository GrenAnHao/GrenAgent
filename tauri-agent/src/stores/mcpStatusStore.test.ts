import { beforeEach, describe, expect, it } from 'vitest';
import { useMcpStatusStore } from './mcpStatusStore';

beforeEach(() => useMcpStatusStore.setState({ servers: [], serversByWorkspace: {} }));

describe('mcpStatusStore', () => {
  it('sets and clears server statuses', () => {
    useMcpStatusStore.getState().setServers([{ name: 'fs', transport: 'stdio', status: 'connected', tools: 14 }]);
    expect(useMcpStatusStore.getState().servers).toHaveLength(1);
    expect(useMcpStatusStore.getState().servers[0]).toMatchObject({ name: 'fs', status: 'connected', tools: 14 });
    useMcpStatusStore.getState().setServers([]);
    expect(useMcpStatusStore.getState().servers).toEqual([]);
  });

  it('carries toolNames when provided', () => {
    useMcpStatusStore.getState().setServers([
      { name: 'fs', transport: 'stdio', status: 'connected', tools: 2, toolNames: ['mcp__fs__read', 'mcp__fs__write'] },
    ]);
    expect(useMcpStatusStore.getState().servers[0].toolNames).toEqual(['mcp__fs__read', 'mcp__fs__write']);
  });

  it('keeps runtime statuses isolated by workspace', () => {
    useMcpStatusStore.getState().setWorkspaceServers('/a', [{ name: 'a', transport: 'stdio', status: 'connected', tools: 1 }]);
    useMcpStatusStore.getState().setWorkspaceServers('/b', [{ name: 'b', transport: 'sse', status: 'failed', tools: 0 }]);
    expect(useMcpStatusStore.getState().serversByWorkspace['/a'][0].name).toBe('a');
    expect(useMcpStatusStore.getState().serversByWorkspace['/b'][0].name).toBe('b');
  });
});
