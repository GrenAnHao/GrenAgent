import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { AgentDataStorage } from './storage';
import { MemoryStore } from './memoryStore';
import { WikiStore } from './wikiStore';
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
  private memory?: MemoryStore;
  private wiki?: WikiStore;

  constructor(private readonly options: AgentDataRuntimeOptions) {}

  async start(): Promise<AgentDataEndpoint> {
    if (this.endpoint) return this.endpoint;
    this.storage = new AgentDataStorage(this.options.dataPath);
    this.storage.migrate();
    this.memory = new MemoryStore(this.storage.db);
    this.wiki = new WikiStore(this.storage.db);
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
        const method = this.options.methods?.[value.method] ?? this.memoryMethod(value.method) ?? this.wikiMethod(value.method);
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

  private wikiMethod(name: string): AgentDataMethod | undefined {
    if (!this.wiki) return undefined;
    if (name === 'wiki.replace') return (params) => this.wiki!.replacePage({ workspace: readString(params.workspace) }, readString(params.page), readString(params.title), readString(params.content), typeof params.sourcePath === 'string' ? params.sourcePath : undefined);
    if (name === 'wiki.search') return (params) => this.wiki!.search({ workspace: readString(params.workspace) }, readString(params.query), typeof params.limit === 'number' ? params.limit : 20);
    if (name === 'wiki.deleteWorkspace') return (params) => { this.wiki!.deleteWorkspace({ workspace: readString(params.workspace) }); return null; };
    return undefined;
  }

  private memoryMethod(name: string): AgentDataMethod | undefined {
    if (!this.memory) return undefined;
    if (name === 'memory.upsert') return (params) => this.memory!.upsert(readScope(params), {
      level: readLevel(params.level), content: readString(params.content), source: typeof params.source === 'string' ? params.source : undefined,
    });
    if (name === 'memory.search') return (params) => this.memory!.search(readScope(params), readString(params.query), typeof params.limit === 'number' ? params.limit : 20);
    if (name === 'memory.delete') return (params) => { this.memory!.remove(readScope(params), readString(params.id)); return null; };
    return undefined;
  }

  private requestId(line: string): string {
    try { const value = JSON.parse(line) as { id?: unknown }; return typeof value.id === 'string' ? value.id : randomUUID(); } catch { return randomUUID(); }
  }
}

function readString(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new RpcError('INVALID_PARAMS', 'string parameter is required'); return value; }
function readLevel(value: unknown): 0 | 1 | 2 | 3 { if (value === 0 || value === 1 || value === 2 || value === 3) return value; throw new RpcError('INVALID_PARAMS', 'level must be 0..3'); }
function readScope(value: Record<string, unknown>): { userId: string; workspace: string; sessionId?: string } { return { userId: readString(value.userId), workspace: readString(value.workspace), sessionId: value.sessionId === undefined ? undefined : readString(value.sessionId) }; }
