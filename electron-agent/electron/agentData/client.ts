import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RpcError, PROTOCOL_VERSION, type AgentDataEndpoint, type RpcResponse } from './protocol';

export class AgentDataClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly endpoint: AgentDataEndpoint, private readonly options: { timeoutMs?: number } = {}) {}

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError('TIMEOUT', `request timed out: ${method}`)); }, this.options.timeoutMs ?? 5000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.ensureSocket().then(() => {
        if (!this.socket || this.socket.destroyed) throw new RpcError('CLOSED', 'agent data client is closed');
        this.socket.write(`${JSON.stringify({ id, version: PROTOCOL_VERSION, method, params, token: this.endpoint.token })}\n`);
      }).catch((error) => this.fail(id, error));
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy(); this.socket = undefined;
    this.connecting = undefined;
    this.failAll(new RpcError('CLOSED', 'agent data client is closed'));
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1_048_576) { socket.destroy(new RpcError('FRAME_TOO_LARGE', 'RPC response exceeds 1 MiB')); return; }
        let i = buffer.indexOf('\n');
        while (i >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try { this.resolve(JSON.parse(line) as RpcResponse); } catch (error) { this.failAll(error); socket.destroy(); return; }
          i = buffer.indexOf('\n');
        }
      });
      socket.on('error', (error) => { this.failAll(error); reject(error); });
      socket.on('close', () => { if (this.socket === socket) this.socket = undefined; });
      socket.once('connect', () => { this.socket = socket; resolve(); });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private resolve(response: RpcResponse): void {
    const item = this.pending.get(response.id); if (!item) return; this.pending.delete(response.id); clearTimeout(item.timer);
    if (response.ok) item.resolve(response.result); else item.reject(new RpcError(response.error.code, response.error.message));
  }
  private fail(id: string, error: unknown): void { const item = this.pending.get(id); if (!item) return; this.pending.delete(id); clearTimeout(item.timer); item.reject(error); }
  private failAll(error: unknown): void { for (const [id] of this.pending) this.fail(id, error); }
}
