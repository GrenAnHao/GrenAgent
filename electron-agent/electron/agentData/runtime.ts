import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { AgentDataStorage } from './storage';
import { isRpcRequest, PROTOCOL_VERSION, RpcError, type AgentDataEndpoint, type RpcResponse } from './protocol';

export type AgentDataMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface AgentDataRuntimeOptions {
  dataPath: string;
  methods?: Record<string, AgentDataMethod>;
  stdin?: NodeJS.ReadableStream;
}

export class AgentDataRuntime {
  private server?: Server;
  private storage?: AgentDataStorage;
  private endpoint?: AgentDataEndpoint;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private inFlight = 0;
  private readonly token = randomBytes(32).toString('hex');

  constructor(private readonly options: AgentDataRuntimeOptions) {}

  async start(): Promise<AgentDataEndpoint> {
    if (this.endpoint) return this.endpoint;
    this.storage = new AgentDataStorage(this.options.dataPath);
    this.storage.migrate();
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('agent data server address unavailable');
    this.options.stdin?.once('end', () => this.handleStdinEnd());
    this.endpoint = { host: '127.0.0.1', port: address.port, token: this.token };
    return this.endpoint;
  }

  handleStdinEnd(): void { this.close(); }
  isClosed(): boolean { return this.closed; }
  getEndpoint(): AgentDataEndpoint | undefined { return this.endpoint; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.inFlight === 0) this.storage?.close();
    this.endpoint = undefined;
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) { socket.destroy(); return; }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        void this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    this.inFlight += 1;
    let response: RpcResponse;
    let shutdown = false;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC request');
      if (value.token !== this.token) throw new RpcError('UNAUTHORIZED', 'invalid token');
      if (value.method === 'system.hello') response = { id: value.id, ok: true, result: { version: PROTOCOL_VERSION } };
      else if (value.method === 'system.status') response = { id: value.id, ok: true, result: { state: this.closed ? 'closed' : 'ready', version: PROTOCOL_VERSION } };
      else if (value.method === 'system.shutdown') { response = { id: value.id, ok: true, result: null }; shutdown = true; }
      else {
        const method = this.options.methods?.[value.method];
        if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${value.method}`);
        response = { id: value.id, ok: true, result: await method(value.params) };
      }
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      response = { id: this.requestId(line), ok: false, error: { code: e.code, message: e.message } };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { if (shutdown) this.close(); });
    this.inFlight -= 1;
    if (this.closed && this.inFlight === 0) this.storage?.close();
  }

  private requestId(line: string): string {
    try { const value = JSON.parse(line) as { id?: unknown }; return typeof value.id === 'string' ? value.id : randomUUID(); } catch { return randomUUID(); }
  }
}
