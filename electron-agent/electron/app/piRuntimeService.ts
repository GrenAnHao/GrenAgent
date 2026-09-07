import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { PiManager, PiProcessCommand } from '../pi/manager';
import type { PiClientMetadata } from '../pi/client';
import type { Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';
import { adaptPiEvent, type PiProjection } from '../pi/eventAdapter';
import { readSessionIdentity } from './sessionIdentity';

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
  setSessionIdentity?(sessionId: string, sessionPath?: string): void;
}

interface PiManagerPort {
  get(workspace: string): PiClientPort | undefined;
  open(workspace: string, cwd: string, env?: Record<string, string>): PiClientPort;
  open(options: { key: string; cwd: string; logicalWorkspace: string; sessionId?: string; sessionPath?: string; source?: 'interactive' | 'goal'; env?: Record<string, string> }): PiClientPort;
  openGoalWorker?(sessionId: string, workspace: string, sessionPath: string, cwd?: string, env?: Record<string, string>): PiClientPort;
  closeGoalWorker?(sessionId: string): Promise<void>;
  close(workspace: string): Promise<void>;
  all?: () => Array<[string, PiClientPort]>;
}

interface ThreadStorePort {
  createThread(input: { id: string; projectId: string; workspace: string; title?: string; sessionId?: string }): Promise<Thread> | Thread;
  createTurn(input: { id: string; threadId: string; input: string; permissionProfile: string; mode?: Turn['mode']; sessionId?: string }): Promise<Turn> | Turn;
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn> | Turn;
  upsertItem?(item: { id: string; threadId: string; turnId: string; type: 'assistant_message' | 'tool_call'; status: 'started' | 'streaming' | 'completed' | 'failed'; payload: unknown }): Promise<unknown> | unknown;
}
interface McpConfigPort { effective(workspace: string): Promise<Array<{ name: string; config: Record<string, unknown> }>>; runtime?(workspace: string): Promise<Array<{ name: string; config: Record<string, unknown> }>>; }

export interface PiRuntimeEventEnvelope {
  workspace: string;
  sessionId?: string;
  source: 'interactive' | 'goal';
  event: Record<string, unknown>;
}

interface SessionContext {
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
}

interface ActiveTurn {
  workspace: string;
  sessionId?: string;
  sessionPath?: string;
  source: 'interactive' | 'goal';
  threadId: string;
  turnId: string;
}

export interface PiRuntimeOptions {
  manager: PiManagerPort;
  processCommand: PiProcessCommand;
  agentDir: string;
  runtimeConfigPath?: string;
  agentDataEndpoint?: (workspace: string) => string | undefined;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  resolveEnv?: (workspace: string) => Promise<Record<string, string>>;
  threadStore?: ThreadStorePort;
  onEvent?: (event: PiRuntimeEventEnvelope) => void;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
  allowedPluginIds?: () => string[];
}

export class PiRuntimeService {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly assistantItems = new Map<string, string>();
  private readonly itemPayloads = new Map<string, Record<string, unknown>>();
  private readonly workspaceThreads = new Map<string, string>();
  private readonly queuedTurns = new Map<string, Array<{ input: string; permissionProfile: string }>>();
  private readonly permissionProfiles = new Map<string, string>();
  private readonly currentSessionByWorkspace = new Map<string, SessionContext>();
  private readonly goalWorkers = new Map<string, string>();
  constructor(private readonly options: PiRuntimeOptions) {}

  async openWorkspace(workspace: string): Promise<{ restoredSession: null; sessionFile: string | null; sessionId?: string | null }> {
    const client = await this.openClient(workspace);
    const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : null;
    const identity = await this.readCurrentIdentity(workspace, sessionFile, typeof state.sessionId === 'string' ? state.sessionId : undefined);
    if (identity) this.currentSessionByWorkspace.set(workspace, identity);
    return {
      restoredSession: null,
      sessionFile,
      ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
    };
  }

  async warmWorkspace(workspace: string): Promise<void> {
    const client = await this.openClient(workspace);
    await client.send({ type: 'get_state' });
  }

  closeWorkspace(workspace: string): Promise<void> {
    for (const [key, active] of this.activeTurns) if (active.workspace === workspace) this.activeTurns.delete(key);
    for (const key of this.assistantItems.keys()) if (key.startsWith(`${workspace}\0`)) this.assistantItems.delete(key);
    for (const key of this.workspaceThreads.keys()) if (key.startsWith(`${workspace}\0`)) this.workspaceThreads.delete(key);
    for (const key of this.queuedTurns.keys()) if (key.startsWith(`${workspace}\0`)) this.queuedTurns.delete(key);
    for (const key of this.permissionProfiles.keys()) if (key.startsWith(`${workspace}\0`)) this.permissionProfiles.delete(key);
    this.currentSessionByWorkspace.delete(workspace);
    const goalClosures = [...this.goalWorkers.entries()].filter(([, owner]) => owner === workspace).map(([sessionId]) => {
      this.goalWorkers.delete(sessionId);
      return this.options.manager.closeGoalWorker?.(sessionId);
    }).filter((value): value is Promise<void> => Boolean(value));
    if (goalClosures.length) return Promise.all(goalClosures).then(() => this.options.manager.close(workspace));
    return this.options.manager.close(workspace);
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    const session = await this.resolveSession(workspace, args);
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (command === 'agent_prompt' && args.streamingBehavior === 'followUp' && this.activeTurns.has(stateKey)) {
      const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
      return this.enqueueTurn(workspace, input, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', session);
    }
    const client = session.source === 'goal' && session.sessionId && session.sessionPath
      ? await this.openGoalClient(session.sessionId, workspace, session.sessionPath)
      : await this.openClient(workspace);
    if (session.source !== 'goal' && session.sessionId) client.setSessionIdentity?.(session.sessionId, session.sessionPath);
    const rpcArgs = stripSessionArgs(args);
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
      ? await this.prepareTurn(workspace, command, args, session)
      : undefined;
    try {
      const result = await client.send({ type, ...rpcArgs });
      if (command === 'agent_get_state') await this.refreshCurrentSession(workspace, client);
      if (command === 'agent_new_session' || command === 'agent_switch_session' || command === 'agent_fork') {
        this.workspaceThreads.delete(stateKey);
        await this.refreshCurrentSession(workspace, client);
      }
      return result;
    } catch (error) {
      if (adapter && (command === 'agent_prompt' || command === 'agent_follow_up')) {
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'failed', completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        this.emitRuntimeEvent(workspace, session, { type: 'turn.failed', error: error instanceof Error ? error.message : String(error) });
      }
      if (adapter && (command === 'agent_prompt' || command === 'agent_follow_up')) this.activeTurns.delete(stateKey);
      throw error;
    }
  }

  async handlePiEvent(workspace: string, raw: Record<string, unknown>, sessionOrMetadata?: string | PiClientMetadata, source?: 'interactive' | 'goal'): Promise<void> {
    const eventSessionId = typeof sessionOrMetadata === 'string' ? sessionOrMetadata : sessionOrMetadata?.sessionId ?? readOptionalString(raw.sessionId);
    const eventSource = source ?? (typeof sessionOrMetadata === 'object' ? sessionOrMetadata?.source : undefined);
    const stateKey = this.findEventKey(workspace, eventSessionId);
    if (!stateKey) return;
    const active = this.activeTurns.get(stateKey);
    if (!active) return;
    if (eventSessionId && active.sessionId && eventSessionId !== active.sessionId) return;
    if (eventSource && eventSource !== active.source) return;
    const session: SessionContext = { sessionId: active.sessionId, sessionPath: active.sessionPath, source: eventSource ?? active.source };
    this.emitRuntimeEvent(workspace, session, raw);
    const normalized = this.withStableItemId(stateKey, raw);
    // adaptPiEvent 现在只是内部投影器：把 pi 原始事件归一成 turn/item 语义，供下面的
    // threads/turns/items 持久化分支使用。它不再对外广播，也不再写 app_events（AppEvent 已移除）。
    const event = adaptPiEvent(normalized, { projectId: workspace, threadId: active.threadId, turnId: active.turnId });
    if (!event) return;

    if (event.type === 'turn.started') {
      await this.options.threadStore?.updateTurn(active.turnId, { status: 'running', startedAt: event.timestamp });
      return;
    }
    if (event.type === 'item.created' || event.type === 'item.delta' || event.type === 'item.updated') {
      // 流式中间态（item.delta，来自 message_update / tool_execution_update）不落盘：
      // 这类事件每个 token 一次，而 node:sqlite 的 DatabaseSync 是同步 API，逐条写会阻塞
      // 主进程事件循环，把 broadcastPiEvent（webContents.send）排在后面，渲染层迟迟收不到
      // 事件 —— 表现为「深度思考卡在第一个字，直到整段返回才突然全部出现」。
      // 终态（created / updated，含 message_end 的完整 content）仍完整落盘，items 表语义不变。
      if (event.type !== 'item.delta') await this.persistItem(normalized, event, active);
      if (normalized.type === 'message_end') this.assistantItems.delete(stateKey);
      return;
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      const data = isRecord(event.data) ? event.data : {};
      await this.options.threadStore?.updateTurn(active.turnId, {
        status: event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed',
        completedAt: event.timestamp,
        ...(event.type === 'turn.failed' ? { error: readOptionalString(data.errorMessage) ?? readOptionalString(data.error) ?? 'Pi turn failed' } : {}),
      });
      this.activeTurns.delete(stateKey);
      this.assistantItems.delete(stateKey);
      for (const key of this.itemPayloads.keys()) if (key.startsWith(`${active.turnId}:`)) this.itemPayloads.delete(key);
      void this.drainQueuedTurn(workspace, session);
    }
  }

  enqueueTurn(workspace: string, input: string, permissionProfile = 'workspace', session: SessionContext = this.currentSessionByWorkspace.get(workspace) ?? {}): { status: 'queued'; position: number } {
    const stateKey = this.sessionKey(workspace, session.sessionId);
    const queue = this.queuedTurns.get(stateKey) ?? [];
    queue.push({ input, permissionProfile });
    const position = queue.length;
    this.queuedTurns.set(stateKey, queue);
    if (!this.activeTurns.has(stateKey)) void this.drainQueuedTurn(workspace, session);
    return { status: 'queued', position };
  }

  async respondUi(workspace: string, response: Record<string, unknown>): Promise<void> {
    const client = await this.openClient(workspace);
    await client.respondUi(response);
  }

  permissionProfile(workspace: string, sessionId?: string): string | undefined {
    return this.permissionProfiles.get(this.sessionKey(workspace, sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId));
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

  async openGoalWorker(sessionId: string, workspace: string, sessionPath: string): Promise<PiClientPort> {
    if (!sessionId.trim() || !sessionPath.trim()) throw new Error('INVALID_SESSION_IDENTITY');
    const identity = await readSessionIdentity(sessionPath, workspace);
    if (identity.sessionId !== sessionId) throw new Error('SESSION_ID_MISMATCH');
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const env = await this.workerEnv(workspace, cwd, 'goal');
    const client = this.options.manager.openGoalWorker
      ? this.options.manager.openGoalWorker(sessionId, workspace, sessionPath, cwd, env)
      : this.options.manager.open({ key: `__goal__:${sessionId}`, cwd, logicalWorkspace: workspace, sessionId, sessionPath, source: 'goal', env });
    this.goalWorkers.set(sessionId, workspace);
    return client;
  }

  async closeGoalWorker(sessionId: string): Promise<void> {
    this.goalWorkers.delete(sessionId);
    if (this.options.manager.closeGoalWorker) await this.options.manager.closeGoalWorker(sessionId);
    else await this.options.manager.close(`__goal__:${sessionId}`);
  }

  eventEnvelope(workspace: string, raw: Record<string, unknown>, metadata?: PiClientMetadata): PiRuntimeEventEnvelope {
    const sessionId = metadata?.sessionId ?? readOptionalString(raw.sessionId);
    const stateKey = this.findEventKey(workspace, sessionId);
    const active = stateKey ? this.activeTurns.get(stateKey) : undefined;
    const source = metadata?.source ?? active?.source ?? 'interactive';
    return {
      workspace,
      event: raw,
      source,
      ...(sessionId ?? active?.sessionId ? { sessionId: sessionId ?? active?.sessionId } : {}),
    };
  }

  private async openClient(workspace: string): Promise<PiClientPort> {
    const existing = this.options.manager.get(workspace);
    if (existing) return existing;
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const env = await this.workerEnv(workspace, cwd, 'interactive');
    return this.options.manager.open(workspace, cwd, env);
  }

  private async openGoalClient(sessionId: string, workspace: string, sessionPath: string): Promise<PiClientPort> {
    const existing = this.options.manager.get(`__goal__:${sessionId}`);
    if (existing) return existing;
    return this.openGoalWorker(sessionId, workspace, sessionPath);
  }

  private async workerEnv(workspace: string, cwd: string, source: 'interactive' | 'goal'): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      ...(await this.options.resolveEnv?.(workspace) ?? {}),
      PI_PACKAGE_DIR: this.options.agentDir,
    };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    const endpoint = this.options.agentDataEndpoint?.(cwd);
    if (endpoint) env.AGENT_DATA_ENDPOINT = endpoint;
    env.PI_PERMISSION_PROFILE = workspace === '__system__' ? 'automation' : 'workspace';
    if (source === 'goal') env.PI_GOAL_WORKER = '1';
    if (this.options.mcpConfig) env.PI_MCP_CONFIG = JSON.stringify(await (this.options.mcpConfig.runtime?.(workspace) ?? this.options.mcpConfig.effective(workspace)));
    if (this.options.allowedPluginIds) env.PI_ALLOWED_EXTENSIONS = JSON.stringify(this.options.allowedPluginIds());
    return env;
  }

  private authorize(workspace: string, command: string, args: Record<string, unknown>): Promise<PermissionAuthorization> {
    const profile = typeof args.permissionProfile === 'string' ? args.permissionProfile as PermissionProfileName : 'interactive';
    return this.options.permissionManager?.authorize({ kind: `pi.${command}`, workspace, args }, profile)
      ?? Promise.resolve({ status: 'allowed', decision: 'allow' });
  }

  private async prepareTurn(workspace: string, command: string, args: Record<string, unknown>, session: SessionContext): Promise<ActiveTurn | undefined> {
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (command === 'agent_abort') return this.activeTurns.get(stateKey);
    let threadId = this.workspaceThreads.get(stateKey);
    const createThread = !threadId;
    threadId ??= randomUUID();
    const turnId = randomUUID();
    if (createThread) await this.options.threadStore!.createThread({ id: threadId, projectId: workspace, workspace, ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    this.workspaceThreads.set(stateKey, threadId);
    const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
    this.permissionProfiles.set(stateKey, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace');
    await this.options.threadStore!.createTurn({ id: turnId, threadId, input, permissionProfile: typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    const active: ActiveTurn = { workspace, sessionId: session.sessionId, sessionPath: session.sessionPath, source: session.source ?? 'interactive', threadId, turnId };
    this.activeTurns.set(stateKey, active);
    return active;
  }

  private withStableItemId(stateKey: string, raw: Record<string, unknown>): Record<string, unknown> {
    if (raw.type !== 'message_start' && raw.type !== 'message_update' && raw.type !== 'message_end') return raw;
    const message = isRecord(raw.message) ? raw.message : {};
    let id = readOptionalString(message.id) ?? this.assistantItems.get(stateKey);
    if (!id) id = randomUUID();
    this.assistantItems.set(stateKey, id);
    return { ...raw, message: { ...message, id } };
  }

  private async persistItem(raw: Record<string, unknown>, event: PiProjection, active: { threadId: string; turnId: string }): Promise<void> {
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

  private async drainQueuedTurn(workspace: string, session: SessionContext): Promise<void> {
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (this.activeTurns.has(stateKey)) return;
    const queue = this.queuedTurns.get(stateKey);
    const next = queue?.shift();
    if (!next) return;
    if (queue?.length === 0) this.queuedTurns.delete(stateKey);
    try {
      await this.send(workspace, 'agent_follow_up', { message: next.input, permissionProfile: next.permissionProfile, ...session });
    } catch {
      // send() records the failed turn; later enqueued turns remain available for the next terminal event.
    }
  }

  private sessionKey(workspace: string, sessionId?: string): string { return `${workspace}\0${sessionId ?? ''}`; }

  private findEventKey(workspace: string, sessionId?: string): string | undefined {
    if (sessionId) return this.activeTurns.has(this.sessionKey(workspace, sessionId)) ? this.sessionKey(workspace, sessionId) : undefined;
    const legacy = this.sessionKey(workspace);
    if (this.activeTurns.has(legacy)) return legacy;
    const candidates = [...this.activeTurns.entries()].filter(([, active]) => active.workspace === workspace);
    return candidates.length === 1 ? candidates[0][0] : undefined;
  }

  private async resolveSession(workspace: string, args: Record<string, unknown>): Promise<SessionContext> {
    const suppliedId = readOptionalString(args.sessionId);
    const suppliedPath = readOptionalString(args.sessionPath);
    const current = this.currentSessionByWorkspace.get(workspace);
    const session: SessionContext = {
      sessionId: suppliedId ?? current?.sessionId,
      sessionPath: suppliedPath ?? current?.sessionPath,
      source: args.source === 'goal' ? 'goal' : current?.source,
    };
    if (session.sessionPath) {
      const identity = await readSessionIdentity(session.sessionPath, workspace);
      if (session.sessionId && identity.sessionId !== session.sessionId) throw new Error('SESSION_ID_MISMATCH');
      session.sessionId = identity.sessionId;
      session.sessionPath = identity.sessionPath;
      this.currentSessionByWorkspace.set(workspace, { ...session, source: 'interactive' });
    }
    return session;
  }

  private async readCurrentIdentity(workspace: string, sessionFile: string | null, stateSessionId?: string): Promise<SessionContext | undefined> {
    if (!sessionFile) return stateSessionId ? { sessionId: stateSessionId, source: 'interactive' } : undefined;
    try {
      const identity = await readSessionIdentity(sessionFile, workspace);
      return { sessionId: identity.sessionId, sessionPath: identity.sessionPath, source: 'interactive' };
    } catch {
      return stateSessionId ? { sessionId: stateSessionId, sessionPath: sessionFile, source: 'interactive' } : undefined;
    }
  }

  private async refreshCurrentSession(workspace: string, client: PiClientPort): Promise<void> {
    const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
    const identity = await this.readCurrentIdentity(workspace, typeof state.sessionFile === 'string' ? state.sessionFile : null, typeof state.sessionId === 'string' ? state.sessionId : undefined);
    if (identity) this.currentSessionByWorkspace.set(workspace, identity);
  }

  private emitRuntimeEvent(workspace: string, session: SessionContext, event: Record<string, unknown>): void {
    this.options.onEvent?.({ workspace, event, source: session.source ?? 'interactive', ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
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

function stripSessionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, sessionPath: _sessionPath, source: _source, goalId: _goalId, revision: _revision, idempotencyKey: _idempotencyKey, ...rpcArgs } = args;
  return rpcArgs;
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
