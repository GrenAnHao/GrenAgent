import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { connectCodeGraph } from './mcpClient.js';
import { __resetForTest } from '../_shared/runtime-config.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();

beforeEach(() => {
  vi.stubEnv('PI_RUNTIME_CONFIG', '');
  vi.stubEnv('AGENT_DATA_ENDPOINT', '');
  __resetForTest();
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetForTest();
});

async function fakeAgentData(reply?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]) as Record<string, unknown>;
      requests.push(request);
      if (reply) socket.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  vi.stubEnv('AGENT_DATA_ENDPOINT', JSON.stringify({ host: '127.0.0.1', port: address.port, token: 'test-only' }));
  return requests;
}

describe('CodeGraph AgentData client', () => {
  it('forwards the raw tool call to AgentData without probing or starting a local index', async () => {
    const raw = { content: [{ type: 'text', text: 'result' }], structuredContent: { nodes: [1] }, isError: false };
    const requests = await fakeAgentData({ ok: true, result: raw });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const client = await connectCodeGraph('/workspace-without-an-index');
    try {
      await expect(client.callTool('codegraph_node', { file: 'src/a.ts', includeCode: true })).resolves.toEqual(raw);
      expect(requests).toEqual([expect.objectContaining({
        version: 1, token: 'test-only', method: 'codeRetrieval.call',
        params: { workspace: '/workspace-without-an-index', tool: 'codegraph_node', args: { file: 'src/a.ts', includeCode: true } },
      })]);
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 65_000);
    } finally { await client.close(); }
  });

  it('surfaces runtime unavailability without starting a fallback process', async () => {
    await fakeAgentData({ ok: false, error: { code: 'UNAVAILABLE', message: 'CodeGraph provider unavailable' } });
    vi.stubEnv('GREN_CODEGRAPH_COMMAND', 'must-not-execute');
    const client = await connectCodeGraph('/repo');
    await expect(client.callTool('codegraph_search', { query: 'parse' })).rejects.toThrow('CodeGraph provider unavailable');
    await client.close();
  });

  it('rejects requests when AgentData is not configured', async () => {
    const client = await connectCodeGraph('/repo');
    await expect(client.callTool('codegraph_search', { query: 'parse' })).rejects.toThrow('agent data runtime is not configured');
    await client.close();
  });

  it('bounds each AgentData call by the configured timeout', async () => {
    await fakeAgentData();
    const client = await connectCodeGraph('/repo', 20);
    await expect(client.callTool('codegraph_search', { query: 'parse' })).rejects.toThrow('agent data request timed out');
    await client.close();
  });
});
