import { randomUUID } from 'node:crypto';

export interface PiResponse {
  id?: string;
  type?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiClientMetadata {
  key: string;
  logicalWorkspace: string;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
}

export interface PiClientHandlers {
  onEvent?: (workspace: string, event: Record<string, unknown>, metadata?: PiClientMetadata) => void;
  onUiRequest?: (workspace: string, request: Record<string, unknown>, metadata?: PiClientMetadata) => void;
  onExit?: (workspace: string, code: number | null, metadata?: PiClientMetadata) => void;
  onLog?: (message: string) => void;
}

export interface PiLineTransport {
  writeLine(line: string): Promise<void>;
  kill(): Promise<void>;
}

export class PiClient {
  private readonly pending = new Map<string, { resolve: (response: PiResponse) => void; reject: (error: Error) => void }>();
  private closed = false;
  metadata?: PiClientMetadata;

  constructor(
    readonly workspace: string,
    private readonly transport: PiLineTransport,
    private readonly handlers: PiClientHandlers = {},
    metadata?: PiClientMetadata,
  ) { this.metadata = metadata; }

  setSessionIdentity(sessionId: string, sessionPath?: string): void {
    this.metadata = {
      key: this.metadata?.key ?? this.workspace,
      logicalWorkspace: this.metadata?.logicalWorkspace ?? this.workspace,
      ...(this.metadata ?? {}),
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      source: this.metadata?.source ?? 'interactive',
    };
  }

  async send<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error(`pi client is closed: ${this.workspace}`);
    const id = typeof command.id === 'string' ? command.id : randomUUID();
    const request = { ...command, id };
    const response = await new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport.writeLine(JSON.stringify(request)).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    if (!response.success) throw new Error(response.error || `pi command failed: ${response.command}`);
    return response.data as T;
  }

  respondUi(response: Record<string, unknown>): Promise<void> {
    return this.transport.writeLine(JSON.stringify(response));
  }

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.handlers.onLog?.(`[pi:${this.workspace}] ignored invalid JSONL response`);
      return;
    }
    if (value.type === 'response') {
      const id = typeof value.id === 'string' ? value.id : undefined;
      const waiter = id ? this.pending.get(id) : undefined;
      if (waiter) {
        this.pending.delete(id!);
        waiter.resolve(value as unknown as PiResponse);
      }
      return;
    }
    if (value.type === 'extension_ui_request') {
      if (this.metadata) this.handlers.onUiRequest?.(this.workspace, value, this.metadata);
      else this.handlers.onUiRequest?.(this.workspace, value);
    } else if (this.metadata) {
      this.handlers.onEvent?.(this.workspace, value, this.metadata);
    } else {
      this.handlers.onEvent?.(this.workspace, value);
    }
  }

  async close(code: number | null = null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`pi client exited: ${this.workspace}`);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    await this.transport.kill();
    if (this.metadata) this.handlers.onExit?.(this.workspace, code, this.metadata);
    else this.handlers.onExit?.(this.workspace, code);
  }
}
