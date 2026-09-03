import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { PiManager, PiProcessCommand } from '../pi/manager';
import type { AppEvent, Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';
import { adaptPiEvent } from '../pi/eventAdapter';

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
  agent_set_mode: 'prompt',
  agent_set_approval: 'prompt',
  agent_exclude_entry: 'prompt',
  agent_restore_entry: 'prompt',
  agent_rewind_to: 'fork',
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
  upsertItem?(item: { id: string; threadId: string; turnId: string; type: 'assistant_message' | 'tool_call'; status: 'started' | 'streaming' | 'completed' | 'failed'; payload: unknown }): Promise<unknown> | unknown;
}
interface EventBusPort { publish(event: Omit<AppEvent, 'sequence'>): AppEvent; }
interface McpConfigPort { effective(workspace: string): Promise<Array<{ name: string; config: Record<string, unknown> }>>; runtime?(workspace: string): Promise<Array<{ name: string; config: Record<string, unknown> }>>; }

export interface PiRuntimeOptions {
  manager: PiManagerPort;
  processCommand: PiProcessCommand;
  agentDir: string;
  runtimeConfigPath?: string;
  agentDataEndpoint?: () => string | undefined;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  resolveEnv?: (workspace: string) => Promise<Record<string, string>>;
  threadStore?: ThreadStorePort;
  emitAppEvent?: (event: Omit<AppEvent, 'sequence'>) => void;
  eventBus?: EventBusPort;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
  allowedPluginIds?: () => string[];
}

export class PiRuntimeService {
  private readonly activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private readonly assistantItems = new Map<string, string>();
  private readonly itemPayloads = new Map<string, Record<string, unknown>>();
  private readonly workspaceThreads = new Map<string, string>();
  private readonly queuedTurns = new Map<string, Array<{ input: string; permissionProfile: string }>>();
  private readonly permissionProfiles = new Map<string, string>();
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
    this.activeTurns.delete(workspace);
    this.assistantItems.delete(workspace);
    this.workspaceThreads.delete(workspace);
    this.queuedTurns.delete(workspace);
    this.permissionProfiles.delete(workspace);
    return this.options.manager.close(workspace);
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    if (command === 'agent_prompt' && args.streamingBehavior === 'followUp' && this.activeTurns.has(workspace)) {
      const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
      return this.enqueueTurn(workspace, input, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace');
    }
    const client = await this.openClient(workspace);
    if (command === 'agent_set_mode') {
      return client.send({ type: 'prompt', message: `/mode ${String(args.mode ?? '')}` });
    }
    if (command === 'agent_set_approval') {
      return client.send({ type: 'prompt', message: `/approval ${String(args.level ?? '')}` });
    }
    if (command === 'agent_exclude_entry') {
      return client.send({ type: 'prompt', message: `/ctx-exclude ${String(args.timestamp ?? '')}` });
    }
    if (command === 'agent_restore_entry') {
      return client.send({ type: 'prompt', message: `/ctx-restore ${String(args.timestamp ?? '')}` });
    }
    if (command === 'agent_rewind_to') {
      const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
      const sessionFile = state.sessionFile;
      if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('no active session file');
      const entryId = await findEntryIdByTimestamp(sessionFile, args.timestamp);
      if (!entryId) throw new Error(`no message with timestamp ${String(args.timestamp)} in session`);
      return client.send({ type: 'fork', entryId });
    }
    const adapter = this.options.threadStore && shouldTrackTurn(command, args)
      ? await this.prepareTurn(workspace, command, args)
      : undefined;
    try {
      const result = await client.send({ type, ...args });
      if (command === 'agent_new_session' || command === 'agent_switch_session') this.workspaceThreads.delete(workspace);
      return result;
    } catch (error) {
      if (adapter && (command === 'agent_prompt' || command === 'agent_follow_up')) {
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'failed', completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        this.publish({ id: randomUUID(), type: 'turn.failed', timestamp: Date.now(), projectId: workspace, threadId: adapter.threadId, turnId: adapter.turnId, data: { error: error instanceof Error ? error.message : String(error) } });
      }
      if (adapter && (command === 'agent_prompt' || command === 'agent_follow_up')) this.activeTurns.delete(workspace);
      throw error;
    }
  }

  async handlePiEvent(workspace: string, raw: Record<string, unknown>): Promise<void> {
    const active = this.activeTurns.get(workspace);
    if (!active) return;
    const normalized = this.withStableItemId(workspace, raw);
    const event = adaptPiEvent(normalized, { projectId: workspace, ...active });
    if (!event) return;

    this.publish(event);
    if (event.type === 'turn.started') {
      await this.options.threadStore?.updateTurn(active.turnId, { status: 'running', startedAt: event.timestamp });
      return;
    }
    if (event.type === 'item.created' || event.type === 'item.delta' || event.type === 'item.updated') {
      await this.persistItem(normalized, event, active);
      if (normalized.type === 'message_end') this.assistantItems.delete(workspace);
      return;
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      const data = isRecord(event.data) ? event.data : {};
      await this.options.threadStore?.updateTurn(active.turnId, {
        status: event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed',
        completedAt: event.timestamp,
        ...(event.type === 'turn.failed' ? { error: readOptionalString(data.errorMessage) ?? readOptionalString(data.error) ?? 'Pi turn failed' } : {}),
      });
      this.activeTurns.delete(workspace);
      this.assistantItems.delete(workspace);
      for (const key of this.itemPayloads.keys()) if (key.startsWith(`${active.turnId}:`)) this.itemPayloads.delete(key);
      void this.drainQueuedTurn(workspace);
    }
  }

  enqueueTurn(workspace: string, input: string, permissionProfile = 'workspace'): { status: 'queued'; position: number } {
    const queue = this.queuedTurns.get(workspace) ?? [];
    queue.push({ input, permissionProfile });
    const position = queue.length;
    this.queuedTurns.set(workspace, queue);
    if (!this.activeTurns.has(workspace)) void this.drainQueuedTurn(workspace);
    return { status: 'queued', position };
  }

  async respondUi(workspace: string, response: Record<string, unknown>): Promise<void> {
    const client = await this.openClient(workspace);
    await client.respondUi(response);
  }

  permissionProfile(workspace: string): string | undefined { return this.permissionProfiles.get(workspace); }

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
    const env: Record<string, string> = {
      ...(await this.options.resolveEnv?.(workspace) ?? {}),
      PI_PACKAGE_DIR: this.options.agentDir,
    };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    const endpoint = this.options.agentDataEndpoint?.();
    if (endpoint) env.AGENT_DATA_ENDPOINT = endpoint;
    env.PI_PERMISSION_PROFILE = workspace === '__system__' ? 'automation' : 'workspace';
    if (this.options.mcpConfig) env.PI_MCP_CONFIG = JSON.stringify(await (this.options.mcpConfig.runtime?.(workspace) ?? this.options.mcpConfig.effective(workspace)));
    if (this.options.allowedPluginIds) env.PI_ALLOWED_EXTENSIONS = JSON.stringify(this.options.allowedPluginIds());
    return this.options.manager.open(workspace, cwd, env);
  }

  private authorize(workspace: string, command: string, args: Record<string, unknown>): Promise<PermissionAuthorization> {
    const profile = typeof args.permissionProfile === 'string' ? args.permissionProfile as PermissionProfileName : 'interactive';
    return this.options.permissionManager?.authorize({ kind: `pi.${command}`, workspace, args }, profile)
      ?? Promise.resolve({ status: 'allowed', decision: 'allow' });
  }

  private async prepareTurn(workspace: string, command: string, args: Record<string, unknown>): Promise<{ threadId: string; turnId: string } | undefined> {
    if (command === 'agent_abort') return this.activeTurns.get(workspace);
    let threadId = this.workspaceThreads.get(workspace);
    const createThread = !threadId;
    threadId ??= randomUUID();
    const turnId = randomUUID();
    const thread = createThread ? await this.options.threadStore!.createThread({ id: threadId, projectId: workspace, workspace }) : undefined;
    this.workspaceThreads.set(workspace, threadId);
    const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
    this.permissionProfiles.set(workspace, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace');
    await this.options.threadStore!.createTurn({ id: turnId, threadId, input, permissionProfile: typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace' });
    this.activeTurns.set(workspace, { threadId, turnId });
    if (thread) this.publish({ id: randomUUID(), type: 'thread.created', timestamp: Date.now(), projectId: thread.projectId, threadId, data: thread });
    this.publish({ id: randomUUID(), type: 'turn.queued', timestamp: Date.now(), projectId: workspace, threadId, turnId, data: {} });
    return { threadId, turnId };
  }

  private withStableItemId(workspace: string, raw: Record<string, unknown>): Record<string, unknown> {
    if (raw.type !== 'message_start' && raw.type !== 'message_update' && raw.type !== 'message_end') return raw;
    const message = isRecord(raw.message) ? raw.message : {};
    let id = readOptionalString(message.id) ?? this.assistantItems.get(workspace);
    if (!id) id = randomUUID();
    this.assistantItems.set(workspace, id);
    return { ...raw, message: { ...message, id } };
  }

  private async persistItem(raw: Record<string, unknown>, event: Omit<AppEvent, 'sequence'>, active: { threadId: string; turnId: string }): Promise<void> {
    if (!event.itemId || !this.options.threadStore?.upsertItem) return;
    const isTool = typeof raw.type === 'string' && raw.type.startsWith('tool_execution_');
    const key = `${active.turnId}:${event.itemId}`;
    const data = isRecord(event.data) ? event.data : {};
    const payload = { ...(this.itemPayloads.get(key) ?? {}), ...data };
    this.itemPayloads.set(key, payload);
    await this.options.threadStore.upsertItem({
      id: event.itemId,
      threadId: active.threadId,
      turnId: active.turnId,
      type: isTool ? 'tool_call' : 'assistant_message',
      status: event.type === 'item.updated' ? (raw.isError === true ? 'failed' : 'completed') : event.type === 'item.delta' ? 'streaming' : 'started',
      payload,
    });
  }

  private async drainQueuedTurn(workspace: string): Promise<void> {
    if (this.activeTurns.has(workspace)) return;
    const queue = this.queuedTurns.get(workspace);
    const next = queue?.shift();
    if (!next) return;
    if (queue?.length === 0) this.queuedTurns.delete(workspace);
    try {
      await this.send(workspace, 'agent_follow_up', { message: next.input, permissionProfile: next.permissionProfile });
    } catch {
      // send() records the failed turn; later enqueued turns remain available for the next terminal event.
    }
  }

  private publish(event: Omit<AppEvent, 'sequence'>): void {
    const published = this.options.eventBus?.publish(event) ?? event;
    this.options.emitAppEvent?.(published);
    if (published.type === 'item.delta') return;
    const write = this.options.threadStore?.appendAppEvent?.(published);
    if (write instanceof Promise) void write.catch((error) => console.error('Failed to persist app event', error));
  }
}

function shouldTrackTurn(command: string, args: Record<string, unknown>): boolean {
  if (command === 'agent_abort' || command === 'agent_follow_up') return true;
  if (command !== 'agent_prompt') return false;
  if (args.streamingBehavior === 'steer') return false;
  if (args.streamingBehavior === 'followUp') return true;
  const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
  return !input.trimStart().startsWith('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

async function findEntryIdByTimestamp(sessionFile: string, timestamp: unknown): Promise<string | undefined> {
  const reader = createInterface({ input: createReadStream(sessionFile), crlfDelay: Infinity });
  let found: string | undefined;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const value = entry as Record<string, unknown>;
      const message = value.message;
      if (value.type !== 'message' || !message || typeof message !== 'object') continue;
      if ((message as Record<string, unknown>).timestamp !== timestamp) continue;
      if (typeof value.id === 'string') found = value.id;
    }
  } finally {
    reader.close();
  }
  return found;
}
