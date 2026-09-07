import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../_shared/runtime-config.js';
import { encodeRequestFrames } from '../_shared/request-frames.js';

interface Endpoint { host: string; port: number; token: string }
function endpoint(): Endpoint | undefined {
  try { const value = JSON.parse(getConfig('AGENT_DATA_ENDPOINT') ?? '') as Endpoint; return value.host && value.port && value.token ? value : undefined; } catch { return undefined; }
}

export class MemoryClient {
  constructor(private readonly timeoutMs = 5000) {}
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const ep = endpoint(); if (!ep) throw new Error('agent data runtime is not configured');
    const id = randomUUID();
    const frames = encodeRequestFrames({ id, version: 1, method, params, token: ep.token });
    const socket = createConnection({ host: ep.host, port: ep.port }); socket.setEncoding('utf8');
    return new Promise<T>((resolve, reject) => {
      let buffer = ''; let settled = false;
      const timer = setTimeout(() => finish(new Error('agent data request timed out')), this.timeoutMs);
      function finish(error?: unknown, result?: T): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error !== undefined) reject(error); else resolve(result as T);
      }
      socket.on('error', (error) => finish(error));
      socket.on('close', () => finish(new Error('agent data connection closed before completing the request')));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const i = buffer.indexOf('\n'); if (i < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, i)) as { id: string; ok: boolean; result?: T; error?: { code?: string; message: string } };
          if (response.id !== id) throw new Error('agent data response id does not match the request');
          if (response.ok) finish(undefined, response.result);
          else finish(Object.assign(new Error(response.error?.message ?? 'agent data request failed'), { code: response.error?.code }));
        } catch (error) { finish(error); }
      });
      socket.once('connect', () => { if (!settled) for (const frame of frames) socket.write(`${frame}\n`); });
    });
  }
}
