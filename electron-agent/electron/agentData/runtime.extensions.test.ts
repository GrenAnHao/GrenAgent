import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

describe('AgentData extension RPC contracts', () => {

  it('assembles a request larger than one RPC frame before dispatching it', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', methods: { 'test.length': (params) => String(params.text).length } });
    const client = new AgentDataClient(await runtime.start());
    try {
      const text = '中文-content '.repeat(100_000);
      await expect(client.request('test.length', { text })).resolves.toBe(text.length);
    } finally { await client.close(); runtime.close(); }
  });

  it('forwards supported CodeGraph calls without losing the raw MCP payload', async () => {
    const raw = { content: [{ type: 'text', text: 'call graph result' }], structuredContent: { nodes: [{ name: 'parse' }] } };
    const call = vi.fn(async () => raw);
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', codeRetrieval: {
      projects: () => [], status: () => ({}), search: async () => ({}), call,
    } });
    const client = new AgentDataClient(await runtime.start());
    try {
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_callers', args: { symbol: 'parse', limit: 5 } })).resolves.toEqual(raw);
      expect(call).toHaveBeenCalledWith('/repo', 'codegraph_callers', { symbol: 'parse', limit: 5 });
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_sync', args: {} })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: { query: 'parse', projectPath: '/other' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      runtime.close();
    }
  });

  it('reports an unavailable CodeGraph provider instead of falling back to a local process', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: { query: 'parse' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await client.close();
      runtime.close();
    }
  });
});
