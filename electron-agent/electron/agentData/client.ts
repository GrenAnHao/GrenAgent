import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RpcError, PROTOCOL_VERSION, type AgentDataEndpoint, type RpcResponse } from './protocol';
import { encodeRequestFrames } from './requestFrames';

export class AgentDataClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly endpoint: AgentDataEndpoint, private readonly options: { timeoutMs?: number; closeOnTimeout?: boolean } = {}) {}

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    const frames = encodeRequestFrames({ id, version: PROTOCOL_VERSION, method, params, token: this.endpoint.token });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(id, new RpcError('TIMEOUT', `request timed out: ${method}`));
        // Standalone callers may close to discard partial fragments. The shared
        // AgentData service keeps the socket so one slow request cannot fail
        // unrelated in-flight requests; late responses are ignored by id.
        if (this.options.closeOnTimeout !== false) void this.close();
      }, this.options.timeoutMs ?? 5000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.ensureSocket().then((socket) => {
        if (!this.pending.has(id)) return;
        if (this.socket !== socket || socket.destroyed) throw new RpcError('CLOSED', 'agent data client is closed');
        for (const frame of frames) socket.write(`${frame}\n`);
      }).catch((error) => this.fail(id, error));
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy(); this.socket = undefined;
    this.connecting = undefined;
    this.failAll(new RpcError('CLOSED', 'agent data client is closed'));
  }

  private ensureSocket(): Promise<Socket> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    const connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      this.socket = socket;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let i = buffer.indexOf('\n');
        while (i >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (Buffer.byteLength(line) + 1 > 1_048_576) { socket.destroy(new RpcError('FRAME_TOO_LARGE', 'RPC response exceeds 1 MiB')); return; }
          try { this.resolve(JSON.parse(line) as RpcResponse); } catch (error) { this.failAll(error); socket.destroy(); return; }
          i = buffer.indexOf('\n');
        }
        if (Buffer.byteLength(buffer) > 1_048_576) socket.destroy(new RpcError('FRAME_TOO_LARGE', 'RPC response exceeds 1 MiB'));
      });
      socket.on('error', (error) => { if (this.socket === socket) this.failAll(error); reject(error); });
      socket.on('close', () => {
        const error = new RpcError('CLOSED', 'agent data connection closed before completing the request');
        if (this.socket === socket) { this.socket = undefined; this.failAll(error); }
        reject(error);
      });
      socket.once('connect', () => resolve(socket));
    }).finally(() => { if (this.connecting === connecting) this.connecting = undefined; });
    this.connecting = connecting;
    return connecting;
  }

  private resolve(response: RpcResponse): void {
    const item = this.pending.get(response.id); if (!item) return; this.pending.delete(response.id); clearTimeout(item.timer);
    if (response.ok) item.resolve(response.result); else item.reject(new RpcError(response.error.code, response.error.message));
  }
  private fail(id: string, error: unknown): void { const item = this.pending.get(id); if (!item) return; this.pending.delete(id); clearTimeout(item.timer); item.reject(error); }
  private failAll(error: unknown): void { for (const [id] of this.pending) this.fail(id, error); }
}
