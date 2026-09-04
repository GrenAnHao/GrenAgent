import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeGraphConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodeGraphInstancePoolOptions {
  connect?: (workspace: string) => Promise<CodeGraphConnection>;
  /** 空闲多久后关闭子进程释放资源。默认 15 分钟。 */
  idleTimeoutMs?: number;
}

interface PoolEntry { connection: CodeGraphConnection; timer?: ReturnType<typeof setTimeout> }

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * 按 workspace 键控的 CodeGraph MCP 连接池。
 *
 * 与扩展侧「每次查询现开现关」不同：这里惰性拉起后常驻复用，空闲超时才关闭。
 * 同步完成后必须调用 invalidate()，否则池里的连接仍持有旧索引句柄。
 */
export class CodeGraphInstancePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<CodeGraphConnection>>();
  private readonly idleTimeoutMs: number;
  private readonly connectImpl: (workspace: string) => Promise<CodeGraphConnection>;

  constructor(options: CodeGraphInstancePoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.connectImpl = options.connect ?? connectCodeGraphMcp;
  }

  async call(workspace: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = await this.acquire(workspace);
    try {
      return await connection.callTool(tool, { projectPath: workspace, ...args });
    } finally {
      this.scheduleIdleClose(workspace);
    }
  }

  /** 关闭并丢弃该 workspace 的连接（同步完成后调用，保证下次读到新索引）。 */
  async invalidate(workspace: string): Promise<void> {
    const entry = this.entries.get(workspace);
    if (!entry) return;
    this.entries.delete(workspace);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.connection.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const workspaces = [...this.entries.keys()];
    await Promise.all(workspaces.map((workspace) => this.invalidate(workspace)));
  }

  private async acquire(workspace: string): Promise<CodeGraphConnection> {
    const existing = this.entries.get(workspace);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = undefined;
      return existing.connection;
    }
    // 并发首次调用共享同一次连接尝试；失败不落池，下次重试。
    const inFlight = this.pending.get(workspace) ?? this.connectImpl(workspace).finally(() => this.pending.delete(workspace));
    this.pending.set(workspace, inFlight);
    const connection = await inFlight;
    if (!this.entries.has(workspace)) this.entries.set(workspace, { connection });
    return connection;
  }

  private scheduleIdleClose(workspace: string): void {
    const entry = this.entries.get(workspace);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.invalidate(workspace); }, this.idleTimeoutMs);
  }
}

/** 真实连接：拉起 `codegraph serve --mcp` 并按 stdio MCP 协议握手。 */
async function connectCodeGraphMcp(workspace: string): Promise<CodeGraphConnection> {
  if (!workspace.trim()) throw new Error('workspace is required');
  if (!existsSync(join(workspace, '.codegraph'))) throw new Error('CodeGraph index is not initialized for this workspace');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const configured = process.env.GREN_CODEGRAPH_COMMAND?.trim();
  const parts = configured ? configured.split(/\s+/) : ['codegraph', 'serve', '--mcp', '--path', workspace];
  const transport = new StdioClientTransport({
    command: parts[0],
    args: configured ? [...parts.slice(1), 'serve', '--mcp', '--path', workspace] : parts.slice(1),
    cwd: workspace,
    env: { ...process.env, GREN_CODEGRAPH_WORKSPACE: workspace } as Record<string, string>,
  });
  const client = new Client({ name: 'electron-agent-code-retrieval', version: '0.1.0' });
  await client.connect(transport);
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}
