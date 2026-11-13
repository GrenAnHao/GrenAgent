/**
 * 扩展端点的最小服务端。
 *
 * AgentData 运行时下线后，仍有两类扩展调用需要本地服务端：
 * - `code-retrieval` 的 `codeRetrieval.call`（Agent 的 code_explore）；
 * - `desktop-control` 的 `permission.tool.evaluate/remember/settle`（工具审批）。
 *
 * 它们走的是扩展侧既有的 JSONL 命名管道 + 工作区令牌（`AGENT_DATA_ENDPOINT`），
 * 不是 Electron IPC。为了不改扩展，这里保留同一套线协议与令牌模型，但**只**暴露
 * 白名单里的方法；其余一律返回 METHOD_NOT_FOUND，明确表示能力已下线。
 *
 * 有意保持精简：不持有业务数据库、不跑任务、不承载 Wiki，只做鉴权 + 转发。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { RequestFrameDecoder } from './requestFrames';
import { PROTOCOL_VERSION, RpcError, isRpcRequest } from './protocol';

export interface MinimalEndpointOptions {
  listenPath: string;
  /** 工作区令牌 → 规范化工作区。由主进程签发。 */
  workspaceTokens: Map<string, string>;
  /** 只读检索转发。 */
  codeRetrieval: {
    call(workspace: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  };
  /** 工具审批转发；owner 由令牌决定，不能由调用方自报。 */
  toolPermission: {
    evaluate(owner: string, call: unknown): Promise<unknown>;
    remember(owner: string, rule: unknown): Promise<unknown>;
    settle(owner: string, auditId: string, resolution: unknown): Promise<unknown>;
  };
  log?: (message: string, error?: unknown) => void;
}

/** 允许通过端点调用的方法。增删必须同步扩展侧契约。 */
export const ALLOWED_ENDPOINT_METHODS = [
  'codeRetrieval.call',
  'permission.tool.evaluate',
  'permission.tool.remember',
  'permission.tool.settle',
  'system.hello',
  'system.status',
] as const;

export class MinimalExtensionEndpoint {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private endpoint?: { path: string; token: string };

  constructor(private readonly options: MinimalEndpointOptions) {
    this.server = createServer((socket) => this.handle(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.listenPath, () => { this.server.off('error', reject); resolve(); });
    });
    this.endpoint = { path: this.options.listenPath, token: '' };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new RequestFrameDecoder((token) => this.options.workspaceTokens.has(token));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { decoder.clear(); this.sockets.delete(socket); });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let request: string | undefined;
        try {
          request = decoder.accept(line);
          if (request !== undefined) void this.dispatch(socket, request);
        } catch (error) {
          decoder.clear();
          const code = error instanceof RpcError ? error.code : 'INVALID_REQUEST';
          socket.write(`${JSON.stringify({ id: idOf(line), ok: false, error: { code, message: error instanceof Error ? error.message : 'invalid request' } })}\n`);
        }
        newline = buffer.indexOf('\n');
      }
      // 与旧端点一致：单帧上限 1 MiB，超限直接断开，避免无界缓冲。
      if (Buffer.byteLength(buffer) > 1_048_576) socket.destroy(new Error('RPC frame exceeds 1 MiB'));
    });
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    const id = idOf(line);
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC request');
      const owner = this.options.workspaceTokens.get(value.token);
      if (!owner) throw new RpcError('UNAUTHORIZED', 'invalid token');
      if (!(ALLOWED_ENDPOINT_METHODS as readonly string[]).includes(value.method)) {
        // 明确告知能力已下线，而不是静默返回空结果。
        throw new RpcError('METHOD_NOT_FOUND', `${value.method} is retired`);
      }
      const result = await this.invoke(value.method, value.params, owner);
      socket.write(`${JSON.stringify({ id: value.id, ok: true, result })}\n`);
    } catch (error) {
      const code = error instanceof RpcError ? error.code : 'INTERNAL_ERROR';
      socket.write(`${JSON.stringify({ id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`);
    }
  }

  private async invoke(method: string, params: Record<string, unknown>, owner: string): Promise<unknown> {
    switch (method) {
      case 'system.hello':
        return { version: PROTOCOL_VERSION };
      case 'system.status':
        return { state: this.closed ? 'closed' : 'ready', version: PROTOCOL_VERSION };
      case 'codeRetrieval.call': {
        // 检索的项目由调用方指定，但必须是绝对路径；工作区所有权在检索层再校验。
        const workspace = typeof params.workspace === 'string' ? params.workspace : '';
        const tool = typeof params.tool === 'string' ? params.tool : '';
        const rawArgs = params.args && typeof params.args === 'object' && !Array.isArray(params.args) ? params.args as Record<string, unknown> : {};
        if (!workspace || !tool) throw new RpcError('INVALID_PARAMS', 'workspace and tool are required');
        return this.options.codeRetrieval.call(workspace, tool, rawArgs);
      }
      case 'permission.tool.evaluate':
        return this.options.toolPermission.evaluate(owner, params.call);
      case 'permission.tool.remember':
        return this.options.toolPermission.remember(owner, params.rule);
      case 'permission.tool.settle':
        return this.options.toolPermission.settle(owner, String(params.auditId ?? ''), params.resolution);
      default:
        throw new RpcError('METHOD_NOT_FOUND', `${method} is retired`);
    }
  }
}

function idOf(line: string): string {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return typeof value.id === 'string' ? value.id : '';
  } catch { return ''; }
}

/** 常量时间比较，供需要额外校验令牌的地方使用。 */
export function tokensEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
