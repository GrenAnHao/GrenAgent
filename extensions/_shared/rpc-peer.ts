/**
 * 进程之间的对称 RPC：主进程 ↔ agent-host 子进程，agent-host ↔ 子代理 worker 进程。两端各持一个 RpcPeer：
 * 都能发请求、都能处理对方的请求，另有单向事件。
 * 传输层只要求能投递一条结构化克隆消息（Node IPC 的 serialization: 'advanced'）。
 */

export type WireMessage =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: WireError }
  | { t: 'evt'; channel: string; payload: unknown };

export interface WireError {
  message: string;
  name?: string;
  code?: string;
  stack?: string;
}

export interface PeerTransport {
  send(message: WireMessage): void;
}

export type MethodHandler = (params: Record<string, unknown>) => unknown;
export type EventListener = (channel: string, payload: unknown) => void;

export function toWireError(error: unknown): WireError {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      message: error.message,
      name: error.name,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

/** 渲染层按 message 判断 SESSION_BUSY 之类的错误码，只能原样还原 message。 */
export function fromWireError(wire: WireError): Error {
  const error = new Error(wire.message);
  if (wire.name && wire.name !== 'Error') error.name = wire.name;
  if (wire.code) (error as NodeJS.ErrnoException).code = wire.code;
  if (wire.stack) error.stack = wire.stack;
  return error;
}

export function isWireMessage(value: unknown): value is WireMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as { t?: unknown; id?: unknown; method?: unknown; channel?: unknown; ok?: unknown };
  if (message.t === 'req') return typeof message.id === 'number' && typeof message.method === 'string';
  if (message.t === 'res') return typeof message.id === 'number' && typeof message.ok === 'boolean';
  if (message.t === 'evt') return typeof message.channel === 'string';
  return false;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly listeners = new Set<EventListener>();
  private closedWith: Error | undefined;

  constructor(private readonly transport: PeerTransport) {}

  handle(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  handleAll(table: Record<string, MethodHandler>): void {
    for (const [method, handler] of Object.entries(table)) this.handle(method, handler);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.transport.send({ t: 'req', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  emit(channel: string, payload: unknown): void {
    if (this.closedWith) return;
    try {
      this.transport.send({ t: 'evt', channel, payload });
    } catch {
      // 对端已断开：事件是尽力投递，关闭由传输层的 close 回调统一处理
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 传输层收到的每条消息都交给这里。不认识的消息丢弃。 */
  receive(message: unknown): void {
    if (!isWireMessage(message)) return;
    if (message.t === 'res') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(fromWireError(message.error));
      return;
    }
    if (message.t === 'evt') {
      for (const listener of this.listeners) {
        try {
          listener(message.channel, message.payload);
        } catch {
          // 单个监听器出错不影响其他监听器
        }
      }
      return;
    }
    void this.serve(message.id, message.method, message.params);
  }

  /** 对端没了：在途请求全部失败，之后的请求立即失败。 */
  close(error: Error): void {
    if (this.closedWith) return;
    this.closedWith = error;
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private async serve(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    let reply: WireMessage;
    if (!handler) {
      reply = { t: 'res', id, ok: false, error: { message: `agent process method not found: ${method}` } };
    } else {
      try {
        const args = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
        reply = { t: 'res', id, ok: true, result: await handler(args) };
      } catch (error) {
        reply = { t: 'res', id, ok: false, error: toWireError(error) };
      }
    }
    if (this.closedWith) return;
    try {
      this.transport.send(reply);
    } catch (error) {
      // 结果里有不能结构化克隆的值时，至少把失败原因送回去，别让对端一直等
      if (reply.ok) {
        try {
          this.transport.send({ t: 'res', id, ok: false, error: toWireError(error) });
        } catch {
          // 通道已断
        }
      }
    }
  }
}
