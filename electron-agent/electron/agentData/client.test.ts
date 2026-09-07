import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { RequestFrameDecoder } from './requestFrames';
import type { RpcRequest } from './protocol';

async function serve(onRequest: (socket: Socket, request: RpcRequest) => void, closeOnFirstChunk = false) {
  const sockets = new Set<Socket>();
  const frames: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new RequestFrameDecoder('secret');
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); decoder.clear(); });
    socket.on('data', (data: string) => {
      buffer += data;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        frames.push(line);
        if (closeOnFirstChunk) { socket.destroy(); return; }
        if (Buffer.byteLength(line) + 1 > 1_048_576) { socket.destroy(); return; }
        const request = decoder.accept(line);
        if (request !== undefined) onRequest(socket, JSON.parse(request));
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  return {
    endpoint: { host: '127.0.0.1', port: address.port, token: 'secret' }, frames, sockets,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

describe('AgentDataClient', () => {
  it('times out requests', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', methods: { 'slow.test': async () => new Promise(() => {}) } });
    const endpoint = await runtime.start();
    const client = new AgentDataClient(endpoint, { timeoutMs: 20 });
    await expect(client.request('slow.test')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await client.close(); runtime.close();
  });

  it('round-trips concurrent large requests completely over bounded frames', async () => {
    const server = await serve((socket, request) => {
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: createHash('sha256').update(JSON.stringify(request.params)).digest('hex') })}\n`);
    });
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 1000 });
    const params = [{ text: '漢🚀\n\\"'.repeat(120_000) }, { text: 'other'.repeat(230_000) }];
    try {
      expect(await Promise.all(params.map((value) => client.request('capture.test', value)))).toEqual(params.map((value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')));
      expect(server.sockets.size).toBe(1);
      expect(server.frames.every((line) => Buffer.byteLength(line) + 1 <= 1_048_576)).toBe(true);
      expect(server.frames.every((line) => JSON.parse(line).method === 'system.request_chunk')).toBe(true);
      expect(await client.request('small.test', {})).toBe(createHash('sha256').update('{}').digest('hex'));
      expect(JSON.parse(server.frames.at(-1)!)).toMatchObject({ method: 'small.test', params: {} });
    } finally { await client.close(); await server.close(); }
  });

  it('rejects immediately when the peer disconnects during a chunked request', async () => {
    const server = await serve(() => {}, true);
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 200 });
    try {
      await expect(client.request('capture.test', { text: 'x'.repeat(1_100_000) })).rejects.toThrow(/closed|ECONNRESET|EPIPE/);
    } finally { await client.close(); await server.close(); }
  });

  it('rejects a clean EOF before receiving a response', async () => {
    const server = await serve((socket) => socket.end());
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 200 });
    try {
      await expect(client.request('small.test')).rejects.toMatchObject({ code: 'CLOSED' });
    } finally { await client.close(); await server.close(); }
  });

  it('closes the connection on timeout so the server can discard partial state', async () => {
    const server = await serve(() => {});
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 80 });
    try {
      await expect(client.request('slow.test')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally { await client.close(); await server.close(); }
  });

  it('keeps the shared connection available when an application request times out', async () => {
    const server = await serve((socket, request) => {
      if (request.method === 'fast.test') socket.write(`${JSON.stringify({ id: request.id, ok: true, result: 'ok' })}\n`);
    });
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 40, closeOnTimeout: false });
    try {
      const slow = client.request('slow.test').then(() => undefined, (error) => error);
      await vi.waitFor(() => expect(server.frames).toHaveLength(1));
      await expect(slow).resolves.toMatchObject({ code: 'TIMEOUT' });
      expect(server.sockets.size).toBe(1);
      await expect(client.request('fast.test')).resolves.toBe('ok');
    } finally { await client.close(); await server.close(); }
  });

  it('rejects over-limit requests before opening a connection', async () => {
    const server = await serve(() => {});
    const client = new AgentDataClient(server.endpoint, { timeoutMs: 100 });
    try {
      await expect(client.request('capture.test', { text: 'x'.repeat(32 * 1_048_576) })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
      expect(server.sockets.size).toBe(0);
      expect(server.frames).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('does not send a request after close cancels its connection attempt', async () => {
    const server = await serve((socket, request) => socket.write(`${JSON.stringify({ id: request.id, ok: true, result: 'ok' })}\n`));
    const client = new AgentDataClient(server.endpoint);
    try {
      const pending = client.request('cancelled.test');
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
      await client.close();
      await rejected;
      await expect(client.request('next.test')).resolves.toBe('ok');
      expect(server.frames.map((line) => JSON.parse(line).method)).toEqual(['next.test']);
    } finally { await client.close(); await server.close(); }
  });
});
