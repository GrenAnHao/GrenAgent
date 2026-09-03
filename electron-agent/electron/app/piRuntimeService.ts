import { randomUUID } from 'node:crypto';
import type { PiManager, PiProcessCommand } from '../pi/manager';
import type { AppEvent, Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';

type PiCommand = keyof typeof commandTypes;

const commandTypes = {
  agent_prompt: 'prompt',
  agent_steer: 'steer',
  agent_follow_up: 'follow_up',
  agent_abort: 'abort',
  agent_set_model: 'set_model',
  agent_cycle_model: 'cycle_model',
  agent_get_available_models: 'get_available_models',
  agent_set_thinking_level: 'set_thinking_level',
  agent_cycle_thinking_level: 'cycle_thinking_level',
  agent_set_mode: 'set_mode',
  agent_set_approval: 'set_approval',
  agent_exclude_entry: 'exclude_entry',
  agent_restore_entry: 'restore_entry',
  agent_rewind_to: 'rewind_to',
  agent_compact: 'compact',
  agent_set_auto_compaction: 'set_auto_compaction',
  agent_abort_retry: 'abort_retry',
  agent_get_session_stats: 'get_session_stats',
  agent_get_state: 'get_state',
  agent_get_messages: 'get_messages',
  agent_get_commands: 'get_commands',
  agent_new_session: 'new_session',
  agent_switch_session: 'switch_session',
  agent_fork: 'fork',
  agent_clone: 'clone',
  agent_get_fork_messages: 'get_fork_messages',
  agent_set_session_name: 'set_session_name',
} as const;

interface PiClientPort {
  send<T>(command: Record<string, unknown>): Promise<T>;
  respondUi(response: Record<string, unknown>): Promise<void>;
}

interface PiManagerPort {
  get(workspace: string): PiClientPort | undefined;
  open(workspace: string, cwd: string, env?: Record<string, string>): PiClientPort;
  close(workspace: string): Promise<void>;
  all?: () => Array<[string, PiClientPort]>;
}

interface ThreadStorePort {
  createThread(input: { id: string; projectId: string; workspace: string; title?: string }): Promise<Thread> | Thread;
  createTurn(input: { id: string; threadId: string; input: string; permissionProfile: string; mode?: Turn['mode'] }): Promise<Turn> | Turn;
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn> | Turn;
  appendAppEvent?(event: AppEvent): Promise<AppEvent> | AppEvent;
}
interface EventBusPort { publish(event: Omit<AppEvent, 'sequence'>): AppEvent; }
interface McpConfigPort { effective(workspace: string): Promise<Array<{ name: string; config: Record<string, unknown> }>>; }

export interface PiRuntimeOptions {
  manager: PiManagerPort;
  processCommand: PiProcessCommand;
  agentDir: string;
  runtimeConfigPath?: string;
  agentDataEndpoint?: () => string | undefined;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  threadStore?: ThreadStorePort;
  emitAppEvent?: (event: Omit<AppEvent, 'sequence'>) => void;
  eventBus?: EventBusPort;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
}

export class PiRuntimeService {
  private readonly activeTurns = new Map<string, { threadId: string; turnId: string }>();
  constructor(private readonly options: PiRuntimeOptions) {}

  async openWorkspace(workspace: string): Promise<{ restoredSession: null; sessionFile: string | null }> {
    const client = await this.openClient(workspace);
    const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
    return {
      restoredSession: null,
      sessionFile: typeof state.sessionFile === 'string' ? state.sessionFile : null,
    };
  }

  async warmWorkspace(workspace: string): Promise<void> {
    const client = await this.openClient(workspace);
    await client.send({ type: 'get_state' });
  }

  closeWorkspace(workspace: string): Promise<void> {
    return this.options.manager.close(workspace);
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    const client = await this.openClient(workspace);
    const adapter = this.options.threadStore && (command === 'agent_prompt' || command === 'agent_abort')
      ? await this.prepareTurn(workspace, command, args)
      : undefined;
    try {
      const result = await client.send({ type, ...args });
      if (adapter && command === 'agent_prompt') {
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'completed', completedAt: Date.now() });
        this.publish({ id: randomUUID(), type: 'turn.completed', timestamp: Date.now(), projectId: workspace, threadId: adapter.threadId, turnId: adapter.turnId, data: {} });
      }
      if (adapter && command === 'agent_abort') {
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'cancelled', completedAt: Date.now() });
        this.publish({ id: randomUUID(), type: 'turn.cancelled', timestamp: Date.now(), projectId: workspace, threadId: adapter.threadId, turnId: adapter.turnId, data: {} });
      }
      if (adapter && (command === 'agent_prompt' || command === 'agent_abort')) this.activeTurns.delete(workspace);
      return result;
    } catch (error) {
      if (adapter && command === 'agent_prompt') {
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'failed', completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        this.publish({ id: randomUUID(), type: 'turn.failed', timestamp: Date.now(), projectId: workspace, threadId: adapter.threadId, turnId: adapter.turnId, data: { error: error instanceof Error ? error.message : String(error) } });
      }
      if (adapter && command === 'agent_prompt') this.activeTurns.delete(workspace);
      throw error;
    }
  }

  async respondUi(workspace: string, response: Record<string, unknown>): Promise<void> {
    const client = await this.openClient(workspace);
    await client.respondUi(response);
  }

  async refreshModelRegistry(): Promise<{ refreshed: string[]; failed: Array<{ workspace: string; error: string }> }> {
    const result = { refreshed: [] as string[], failed: [] as Array<{ workspace: string; error: string }> };
    for (const [workspace, client] of this.options.manager.all?.() ?? []) {
      try {
        const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
        if (typeof state.sessionFile === 'string') await client.send({ type: 'switch_session', sessionPath: state.sessionFile });
        result.refreshed.push(workspace);
      } catch (error) {
        result.failed.push({ workspace, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private async openClient(workspace: string): Promise<PiClientPort> {
    const existing = this.options.manager.get(workspace);
    if (existing) return existing;
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const env: Record<string, string> = { PI_PACKAGE_DIR: this.options.agentDir };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    const endpoint = this.options.agentDataEndpoint?.();
    if (endpoint) env.AGENT_DATA_ENDPOINT = endpoint;
    if (this.options.mcpConfig) env.PI_MCP_CONFIG = JSON.stringify(await this.options.mcpConfig.effective(workspace));
    return this.options.manager.open(workspace, cwd, env);
  }

  private authorize(workspace: string, command: string, args: Record<string, unknown>): Promise<PermissionAuthorization> {
    const profile = typeof args.permissionProfile === 'string' ? args.permissionProfile as PermissionProfileName : 'interactive';
    return this.options.permissionManager?.authorize({ kind: `pi.${command}`, workspace, args }, profile)
      ?? Promise.resolve({ status: 'allowed', decision: 'allow' });
  }

  private async prepareTurn(workspace: string, command: string, args: Record<string, unknown>): Promise<{ threadId: string; turnId: string } | undefined> {
    if (command === 'agent_abort') return this.activeTurns.get(workspace);
    const threadId = randomUUID();
    const turnId = randomUUID();
    const thread = await this.options.threadStore!.createThread({ id: threadId, projectId: workspace, workspace });
    await this.options.threadStore!.createTurn({ id: turnId, threadId, input: typeof args.prompt === 'string' ? args.prompt : '', permissionProfile: typeof args.permissionProfile === 'string' ? args.permissionProfile : 'default' });
    this.activeTurns.set(workspace, { threadId, turnId });
    this.publish({ id: randomUUID(), type: 'thread.created', timestamp: Date.now(), projectId: thread.projectId, threadId, data: thread });
    this.publish({ id: randomUUID(), type: 'turn.queued', timestamp: Date.now(), projectId: workspace, threadId, turnId, data: {} });
    return { threadId, turnId };
  }

  private publish(event: Omit<AppEvent, 'sequence'>): void {
    const published = this.options.eventBus?.publish(event) ?? event;
    this.options.emitAppEvent?.(published);
    void this.options.threadStore?.appendAppEvent?.(published);
  }
}
