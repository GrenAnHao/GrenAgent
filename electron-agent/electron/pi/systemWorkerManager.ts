import type { PiClient } from './client';
import { spawnPiClient, type PiProcessCommand, type PiProcessOptions } from './manager';
import type { SandboxManager } from '../app/sandbox/sandboxManager';

export interface SystemWorkerTask { id: string; kind: string; input: unknown; maxAttempts?: number }
export interface SystemWorkerState { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; attempts: number; output?: unknown; error?: string }

/** 输出为纯文本（而非 JSON）的任务 kind：结果原样回传，不做 JSON 解析。 */
const TEXT_OUTPUT_KINDS = new Set(['wiki_page_generate']);

/** 各 kind 的指令。未列出的 kind 统一要求返回严格 JSON 对象。 */
const KIND_INSTRUCTIONS: Record<string, string> = {
  memory_extract: 'Extract durable memory as strict JSON with optional keys l1 (object), l2 (string), and l3 (string). Return JSON only.',
  // 与 extensions/wiki-rag/sync.ts 的 SYSTEM 文案保持一致：输出必须是可直接落盘的 Markdown。
  wiki_page_generate: 'Write a concise Markdown knowledge page from the supplied source. Preserve important names, behavior, and references. Return Markdown only.',
};
interface WorkerOptions {
  processCommand: PiProcessCommand;
  cwd?: string;
  idleTimeoutMs?: number;
  maxAttempts?: number;
  sandbox?: SandboxManager;
  createClient?: (workerKey: string, command: PiProcessCommand, options: PiProcessOptions) => PiClient;
  taskTimeoutMs?: number;
  env?: Record<string, string>;
}

export class SystemWorkerManager {
  private client?: PiClient;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private current?: string;
  private currentKind?: string;
  private readonly states = new Map<string, SystemWorkerState>();
  private completion?: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly options: WorkerOptions) {}

  async run(task: SystemWorkerTask): Promise<unknown> {
    const state = this.states.get(task.id) ?? { id: task.id, status: 'queued' as const, attempts: 0 };
    this.states.set(task.id, state);
    const maxAttempts = task.maxAttempts ?? this.options.maxAttempts ?? 1;
    while (state.attempts < maxAttempts) {
      state.attempts += 1; state.status = 'running'; this.current = task.id; this.currentKind = task.kind;
      try {
        const client = this.ensureClient();
        const completion = this.waitForCompletion();
        void completion.catch(() => {});
        const response = await client.send({ type: 'prompt', message: serviceTaskPrompt(task) });
        const output = response === undefined ? await completion : (this.resolveCompletion(response), response);
        state.status = 'completed'; state.output = output; this.current = undefined; this.scheduleIdleClose(); return output;
      } catch (error) {
        this.clearCompletion();
        state.error = error instanceof Error ? error.message : String(error); this.closeClient();
        if (state.attempts >= maxAttempts) { state.status = 'failed'; this.current = undefined; throw error; }
        state.status = 'queued';
      }
    }
    throw new Error('system task failed');
  }

  taskState(id: string): SystemWorkerState | undefined { const state = this.states.get(id); return state ? { ...state } : undefined; }

  close(): void { this.clearIdle(); this.closeClient(); }

  private ensureClient(): PiClient {
    if (this.client) { this.clearIdle(); return this.client; }
    const command = { command: this.options.processCommand.command, args: [...this.options.processCommand.args] };
    const create = this.options.createClient ?? ((key: string, value: PiProcessCommand, options: PiProcessOptions) => spawnPiClient(key, value, options));
    const cwd = this.options.cwd ?? process.cwd();
    this.client = create('__system__', command, {
      cwd,
      workspaceRoot: cwd,
      profile: 'automation',
      sandbox: this.options.sandbox,
      env: { ...this.options.env, PI_SYSTEM_WORKER: '1', PI_DISABLE_PROJECT_CONTEXT: '1', PI_PERMISSION_PROFILE: 'automation' },
      onEvent: (_workspace, event) => this.handleEvent(event),
      onExit: () => {
        this.rejectCompletion(new Error('system Pi exited before completing the task'));
        if (this.current) this.closeClient();
      },
    });
    return this.client;
  }

  private scheduleIdleClose(): void { this.clearIdle(); const timeout = this.options.idleTimeoutMs; if (timeout === undefined || timeout < 0) return; this.idleTimer = setTimeout(() => this.closeClient(), timeout); }
  private clearIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  private closeClient(): void { this.clearIdle(); const client = this.client; this.client = undefined; if (client) void client.close(); }

  private waitForCompletion(): Promise<unknown> {
    this.rejectCompletion(new Error('system task superseded'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completion = undefined;
        reject(new Error('system Pi task timed out'));
      }, this.options.taskTimeoutMs ?? 30_000);
      this.completion = { resolve, reject, timer };
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type !== 'agent_end' || !this.completion) return;
    try {
      const value = parseWorkerOutput(event.messages, this.currentKind);
      const completion = this.completion;
      this.completion = undefined;
      clearTimeout(completion.timer);
      completion.resolve(value);
    } catch (error) {
      this.rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectCompletion(error: Error): void {
    const completion = this.completion;
    if (!completion) return;
    this.completion = undefined;
    clearTimeout(completion.timer);
    completion.reject(error);
  }

  private resolveCompletion(value: unknown): void {
    const completion = this.completion;
    if (!completion) return;
    this.completion = undefined;
    clearTimeout(completion.timer);
    completion.resolve(value);
  }

  private clearCompletion(): void {
    const completion = this.completion;
    if (!completion) return;
    this.completion = undefined;
    clearTimeout(completion.timer);
  }
}

function serviceTaskPrompt(task: SystemWorkerTask): string {
  const instruction = KIND_INSTRUCTIONS[task.kind] ?? 'Complete the service task and return a strict JSON object only.';
  return `${instruction}\nTask kind: ${task.kind}\nInput: ${JSON.stringify(task.input)}`;
}

function parseWorkerOutput(value: unknown, kind?: string): unknown {
  if (!Array.isArray(value)) throw new Error('system Pi returned no messages');
  const assistant = [...value].reverse().find((message) => isRecord(message) && message.role === 'assistant');
  if (!assistant || !Array.isArray(assistant.content)) throw new Error('system Pi returned no assistant output');
  const text = assistant.content.filter(isRecord).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('').trim();
  if (kind && TEXT_OUTPUT_KINDS.has(kind)) {
    if (!text) throw new Error('system Pi returned empty text');
    return text;
  }
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(json); } catch { throw new Error('system Pi returned invalid JSON'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
