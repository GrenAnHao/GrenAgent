import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../_shared/runtime-config.js';

interface Endpoint { host: string; port: number; token: string }
function endpoint(): Endpoint | undefined {
  try { const value = JSON.parse(getConfig('AGENT_DATA_ENDPOINT') ?? '') as Endpoint; return value.host && value.port && value.token ? value : undefined; } catch { return undefined; }
}

export class MemoryClient {
  constructor(private readonly timeoutMs = 5000) {}
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const ep = endpoint(); if (!ep) throw new Error('agent data runtime is not configured');
    const socket = createConnection({ host: ep.host, port: ep.port }); socket.setEncoding('utf8');
    return new Promise<T>((resolve, reject) => {
      let buffer = ''; const id = randomUUID();
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('agent data request timed out')); }, this.timeoutMs);
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      socket.on('data', (chunk: string) => { buffer += chunk; const i = buffer.indexOf('\n'); if (i < 0) return; clearTimeout(timer); socket.destroy(); try { const r = JSON.parse(buffer.slice(0, i)) as { ok: boolean; result?: T; error?: { message: string } }; if (r.ok) resolve(r.result as T); else reject(new Error(r.error?.message ?? 'agent data request failed')); } catch (error) { reject(error); } });
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, version: 1, method, params, token: ep.token })}\n`));
    });
  }
}
