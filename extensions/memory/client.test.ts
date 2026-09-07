import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestFrameDecoder } from '../../electron-agent/electron/agentData/requestFrames';
import { getConfig } from '../_shared/runtime-config.js';
import { MemoryClient } from './client.js';

vi.mock('../_shared/runtime-config.js', () => ({ getConfig: vi.fn() }));
afterEach(() => { vi.mocked(getConfig).mockReset(); });

async function serve(mode: 'reply' | 'disconnect' | 'timeout' = 'reply') {
  const frames: string[] = [];
  const sockets = new Set<Socket>();
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
        if (mode === 'disconnect' || Buffer.byteLength(line) + 1 > 1_048_576) { socket.destroy(); return; }
        const request = decoder.accept(line);
        if (request !== undefined && mode === 'reply') {
          const parsed = JSON.parse(request);
          socket.write(`${JSON.stringify({ id: parsed.id, ok: true, result: createHash('sha256').update(JSON.stringify(parsed.params)).digest('hex') })}\n`);
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  vi.mocked(getConfig).mockReturnValue(JSON.stringify({ host: '127.0.0.1', port: address.port, token: 'secret' }));
  return { frames, sockets, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe('MemoryClient request framing', () => {
  it('round-trips a large transcript without truncation and closes its completed connection', async () => {
    const server = await serve();
    const params = { transcript: '漢🚀\n\\"'.repeat(120_000) };
    try {
      await expect(new MemoryClient(1000).request('memory.capture', params)).resolves.toBe(createHash('sha256').update(JSON.stringify(params)).digest('hex'));
      expect(server.frames.length).toBeGreaterThan(1);
      expect(server.frames.every((line) => Buffer.byteLength(line) + 1 <= 1_048_576)).toBe(true);
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally { await server.close(); }
  });

  it('preserves the ordinary JSONL wire format for a small request', async () => {
    const server = await serve();
    try {
      await new MemoryClient().request('memory.search', { query: 'fact' });
      expect(server.frames.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ method: 'memory.search', params: { query: 'fact' }, token: 'secret', version: 1 })]);
    } finally { await server.close(); }
  });

  it('rejects a mid-request disconnect without waiting for the request timeout', async () => {
    const server = await serve('disconnect');
    try {
      await expect(new MemoryClient(200).request('memory.capture', { transcript: 'x'.repeat(1_100_000) })).rejects.toThrow(/closed|ECONNRESET|EPIPE/);
    } finally { await server.close(); }
  });

  it('closes the socket after timeout', async () => {
    const server = await serve('timeout');
    try {
      await expect(new MemoryClient(80).request('memory.search', {})).rejects.toThrow('timed out');
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally { await server.close(); }
  });

  it('rejects oversized logical requests without connecting', async () => {
    const server = await serve();
    try {
      await expect(new MemoryClient(100).request('memory.capture', { transcript: 'x'.repeat(32 * 1_048_576) })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
      expect(server.frames).toEqual([]);
      expect(server.sockets.size).toBe(0);
    } finally { await server.close(); }
  });
});
