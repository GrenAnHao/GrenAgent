import { createReadStream } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentSession, PromptOptions } from '../../../cli/src/pi-sdk.js';
import { snapshotSessionModel, type WorkspaceHandle } from '../agent/workspaceHandle.js';
import type { SessionEventMeta } from '../pi/eventAdapter';
import type { Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';
import { adaptPiEvent, type PiProjection } from '../pi/eventAdapter';
import { isSessionWorkspaceMismatch, readSessionIdentity } from './sessionIdentity';
import { parseApproval, setApprovalPolicy, type ApprovalPolicy } from '../../../extensions/_shared/approval.js';
import { isAgentMode, setAgentMode } from '../../../extensions/agent-mode/modes.js';
import { agentModeConfigKey, approvalPolicyConfigKey, contextExclusionConfigKey, mergeRuntimeSettingsFile } from './settingsService';
import { truncateSessionLines, type TruncateMode } from './truncateSession.js';
import { messagesWithEntryIds } from './messagesWithEntryIds.js';

type PiCommand = keyof typeof commandTypes;
type ImageContent = NonNullable<PromptOptions['images']>[number];

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
  agent_truncate_to: 'truncate',
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

export interface AgentHostPort {
  open(workspace: string, cwd: string): Promise<WorkspaceHandlePort>;
  get(workspace: string): WorkspaceHandlePort | undefined;
  close(workspace: string): Promise<void>;
  workspaces?(): string[];
}
export type WorkspaceHandlePort = Pick<WorkspaceHandle,
  'session' | 'prompt' | 'getState' | 'getCommands' | 'newSession' | 'switchSession' | 'fork' | 'reload' | 'ui' | 'currentTurnOrigin' | 'dispose'>;

/** 第 3 份已删除 client 接缝：会话操作一律走 runOnHandle。 */
interface SessionOps {
  getState(): Promise<Record<string, unknown>>;
  run(command: PiCommand, args: Record<string, unknown>): Promise<unknown>;
  setSessionIdentity?(sessionId: string, sessionPath?: string): void;
}

interface PiEventMeta { sessionId?: string; sessionPath?: string; source?: 'interactive' | 'goal' | 'subagent' }
type EventMeta = string | PiEventMeta | SessionEventMeta;

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
  sessionPath?: string;
  source: 'interactive' | 'goal' | 'subagent';
  event: Record<string, unknown>;
}

export interface PiTurnSettledResult {
  workspace: string;
  sessionId?: string;
  sessionPath?: string;
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
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
  agentDir: string;
  runtimeConfigPath?: string;
  agentDataEndpoint?: (workspace: string) => string | undefined;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  resolveEnv?: (workspace: string) => Promise<Record<string, string>>;
  threadStore?: ThreadStorePort;
  onEvent?: (event: PiRuntimeEventEnvelope) => void;
  onTurnSettled?: (result: PiTurnSettledResult) => void | Promise<void>;
  onSessionForked?: (input: { workspace: string; sourceSessionId: string; targetSessionId: string }) => void | Promise<void>;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
  allowedPluginIds?: () => string[];
  agentHost: AgentHostPort;
  modelRuntimeHost: { refresh(): Promise<void>; workspaces?(): string[] };
}

export class PiRuntimeService {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly assistantItems = new Map<string, string>();
  private readonly itemPayloads = new Map<string, Record<string, unknown>>();
  private readonly workspaceThreads = new Map<string, string>();
  private readonly queuedTurns = new Map<string, Array<{ input: string; permissionProfile: string }>>();
  private readonly permissionProfiles = new Map<string, string>();
  private readonly currentSessionByWorkspace = new Map<string, SessionContext>();
  private readonly pendingSessionForks = new Map<string, { sourceSessionId: string; targetSessionId: string }>();
  private readonly sessionForkSyncInFlight = new Map<string, Promise<boolean>>();
  private exclusionPulseRev = 0;
  constructor(private readonly options: PiRuntimeOptions) {}

  async openWorkspace(workspace: string): Promise<{ restoredSession: null; sessionFile: string | null; sessionId?: string | null }> {
    const ops = this.handleOps(await this.openInteractive(workspace));
    const state = await ops.getState();
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : null;
    const identity = await this.readCurrentIdentity(workspace, sessionFile, typeof state.sessionId === 'string' ? state.sessionId : undefined);
    if (identity) {
      await this.replaceCurrentSession(workspace, identity);
      if (identity.sessionId) ops.setSessionIdentity?.(identity.sessionId, identity.sessionPath);
    }
    const ownedFile = identity?.sessionPath ?? (sessionFile && !await this.sessionFileMismatches(sessionFile, workspace) ? sessionFile : null);
    return {
      restoredSession: null,
      sessionFile: ownedFile,
      ...(identity?.sessionId && ownedFile ? { sessionId: identity.sessionId } : {}),
    };
  }

  async warmWorkspace(workspace: string): Promise<void> {
    await this.openInteractive(workspace);
  }

  async closeWorkspace(workspace: string): Promise<void> {
    for (const [key, active] of this.activeTurns) if (active.workspace === workspace) this.activeTurns.delete(key);
    for (const key of this.assistantItems.keys()) if (key.startsWith(`${workspace}\0`)) this.assistantItems.delete(key);
    for (const key of this.workspaceThreads.keys()) if (key.startsWith(`${workspace}\0`)) this.workspaceThreads.delete(key);
    for (const key of this.queuedTurns.keys()) if (key.startsWith(`${workspace}\0`)) this.queuedTurns.delete(key);
    for (const key of this.permissionProfiles.keys()) if (key.startsWith(`${workspace}\0`)) this.permissionProfiles.delete(key);
    this.currentSessionByWorkspace.delete(workspace);
    await this.options.agentHost.close(workspace);
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    if (command === 'agent_set_mode') {
      return this.writeAgentMode(workspace, args.mode);
    }
    if (command === 'agent_set_approval') {
      return this.writeApprovalPolicy(workspace, args.level);
    }
    if (command === 'agent_exclude_entry' || command === 'agent_restore_entry') {
      return this.writeContextExclusion(workspace, command === 'agent_exclude_entry' ? 'add' : 'remove', args.timestamp);
    }
    if (SESSION_REPLACING_COMMANDS.includes(command) && this.hasInteractiveTurn(workspace)) {
      throw new Error('SESSION_BUSY');
    }
    const session = await this.resolveSessionForCommand(workspace, command, args);
    const sourceSessionId = session.sessionId;
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (command === 'agent_prompt' && shouldFlushFollowUp(args, this.activeTurns.has(stateKey))) {
      return this.flushFollowUp(workspace, session);
    }
    if (command === 'agent_prompt' && shouldEnqueuePrompt(args, this.activeTurns.has(stateKey), this.queuedTurns.get(stateKey)?.length ?? 0)) {
      const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
      return this.enqueueTurn(workspace, input, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', session);
    }
    const handle = await this.resolveHandle(workspace);
    const ops: SessionOps = this.handleOps(handle);
    if (session.sessionId && command !== 'agent_switch_session') ops.setSessionIdentity?.(session.sessionId, session.sessionPath);
    const rpcArgs = command === 'agent_switch_session' && typeof args.sessionPath === 'string'
      ? { ...stripSessionArgs(args), sessionPath: args.sessionPath }
      : stripSessionArgs(args);
    if (command === 'agent_rewind_to') {
      const state = await ops.getState();
      const sessionFile = state.sessionFile;
      if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('no active session file');
      const entryId = await findEntryIdByTimestamp(sessionFile, args.timestamp);
      if (!entryId) throw new Error(`no message with timestamp ${String(args.timestamp)} in session`);
      const result = await ops.run('agent_rewind_to', { entryId });
      if (isCancelledResult(result)) return result;
      const targetIdentity = await this.refreshCurrentSession(workspace, ops);
      if (targetIdentity?.sessionId) ops.setSessionIdentity?.(targetIdentity.sessionId, targetIdentity.sessionPath);
      const targetSessionId = targetIdentity?.sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId;
      if (sourceSessionId && targetSessionId && sourceSessionId !== targetSessionId) {
        await this.syncSessionFork(workspace, sourceSessionId, targetSessionId);
      }
      return result;
    }
    if (command === 'agent_truncate_to') {
      return this.truncateSessionTo(handle, rpcArgs);
    }
    const adapter = this.options.threadStore && shouldTrackTurn(command, args)
      ? await this.prepareTurn(workspace, command, args, session)
      : undefined;
    try {
      const result = await ops.run(command as PiCommand, rpcArgs);
      if (command === 'agent_get_state') {
        await this.refreshCurrentSession(workspace, ops);
        return this.ownedState(workspace, result);
      }
      if (command === 'agent_new_session' || command === 'agent_switch_session' || command === 'agent_fork' || command === 'agent_clone') {
        if (isCancelledResult(result)) return result;
        this.workspaceThreads.delete(stateKey);
        if (command === 'agent_switch_session') {
          this.workspaceThreads.delete(this.sessionKey(workspace, this.currentSessionByWorkspace.get(workspace)?.sessionId));
        }
        const isSessionFork = command === 'agent_fork' || command === 'agent_clone';
        const targetIdentity = await this.refreshCurrentSession(workspace, ops);
        if (targetIdentity?.sessionId) {
          ops.setSessionIdentity?.(targetIdentity.sessionId, targetIdentity.sessionPath);
        }
        if (isSessionFork && sourceSessionId) {
          const targetSessionId = targetIdentity?.sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId;
          if (targetSessionId && targetSessionId !== sourceSessionId) {
            await this.syncSessionFork(workspace, sourceSessionId, targetSessionId);
          }
        }
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

  async handlePiEvent(workspace: string, raw: Record<string, unknown>, sessionOrMetadata?: EventMeta, source?: 'interactive' | 'goal' | 'subagent'): Promise<void> {
    const eventSessionId = typeof sessionOrMetadata === 'string' ? sessionOrMetadata : sessionOrMetadata?.sessionId ?? readOptionalString(raw.sessionId);
    const eventSource = source ?? (typeof sessionOrMetadata === 'object' ? sessionOrMetadata?.source : undefined);
    if (eventSource === 'subagent') return;
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
      try {
        await this.options.onTurnSettled?.({
          workspace,
          ...(active.sessionId ? { sessionId: active.sessionId } : {}),
          ...(active.sessionPath ? { sessionPath: active.sessionPath } : {}),
          turnId: active.turnId,
          status: event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed',
          summary: summarizeTurn(raw, event),
        });
      } finally {
        await this.drainQueuedTurn(workspace, session).catch(() => {});
      }
    }
  }

  /** Convert an unexpected Pi process exit into a terminal turn result. */
  async handlePiExit(workspace: string, code: number | null, sessionOrMetadata?: EventMeta): Promise<void> {
    const eventSessionId = typeof sessionOrMetadata === 'string' ? sessionOrMetadata : sessionOrMetadata?.sessionId;
    const eventSource = typeof sessionOrMetadata === 'object' ? sessionOrMetadata?.source : undefined;
    const summary = `Pi exited unexpectedly${code === null ? '' : ` (${code})`}`;
    const stateKey = this.findEventKey(workspace, eventSessionId);
    const active = stateKey ? this.activeTurns.get(stateKey) : undefined;
    if (!stateKey || !active || (eventSource && eventSource !== active.source)) return;
    this.activeTurns.delete(stateKey);
    await this.options.threadStore?.updateTurn(active.turnId, {
      status: 'failed', completedAt: Date.now(), error: summary,
    });
    try {
      await this.options.onTurnSettled?.({
        workspace,
        ...(active.sessionId ? { sessionId: active.sessionId } : {}),
        ...(active.sessionPath ? { sessionPath: active.sessionPath } : {}),
        turnId: active.turnId,
        status: 'failed',
        summary,
      });
    } finally {
      await this.drainQueuedTurn(workspace, { sessionId: active.sessionId, sessionPath: active.sessionPath, source: active.source }).catch(() => {});
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
    const handle = this.options.agentHost.get(workspace);
    if (!handle) return;
    handle.ui.respond(readOptionalString(response.id) ?? '', response);
  }

  async rejectUiRequest(workspace: string, _metadata: EventMeta | undefined, requestId: string): Promise<void> {
    if (!requestId.trim()) return;
    this.options.agentHost.get(workspace)?.ui.respond(requestId, { cancelled: true });
  }

  permissionProfile(workspace: string, sessionId?: string): string | undefined {
    return this.permissionProfiles.get(this.sessionKey(workspace, sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId));
  }

  async refreshModelRegistry(): Promise<{ refreshed: string[]; failed: Array<{ workspace: string; error: string }> }> {
    await this.options.modelRuntimeHost.refresh();
    const result = { refreshed: [] as string[], failed: [] as Array<{ workspace: string; error: string }> };
    const workspaces = this.options.agentHost.workspaces?.() ?? this.options.modelRuntimeHost.workspaces?.() ?? [];
    for (const workspace of workspaces) {
      try {
        const handle = this.options.agentHost.get(workspace);
        const snapshot = handle?.session.modelRuntime.getAvailableSnapshot() ?? [];
        const current = handle?.session.model as { provider?: string; id?: string } | undefined;
        const stillThere = Boolean(
          current?.provider &&
            current.id &&
            snapshot.some((model) => model.provider === current.provider && model.id === current.id),
        );
        if (handle && current && !stillThere) {
          const next = snapshot[0];
          if (next) await handle.session.setModel(next);
        }
        result.refreshed.push(workspace);
      } catch (error) {
        result.failed.push({ workspace, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  eventEnvelope(workspace: string, raw: Record<string, unknown>, metadata?: EventMeta): PiRuntimeEventEnvelope {
    const sessionId = (typeof metadata === 'string' ? metadata : metadata?.sessionId) ?? readOptionalString(raw.sessionId);
    const sessionPath = typeof metadata === 'object' ? metadata?.sessionPath : undefined;
    const stateKey = this.findEventKey(workspace, sessionId);
    const active = stateKey ? this.activeTurns.get(stateKey) : undefined;
    const source = (typeof metadata === 'object' ? metadata?.source : undefined) ?? active?.source ?? 'interactive';
    return {
      workspace,
      event: raw,
      source,
      ...(sessionId ?? active?.sessionId ? { sessionId: sessionId ?? active?.sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }

  /** per-(workspace, source) 配置进 ALS（去掉 PI_PACKAGE_DIR/PI_RUNTIME_CONFIG/PI_GOAL_WORKER/PI_ALLOWED_EXTENSIONS 进程级键）。 */
  async turnConfig(workspace: string, cwd: string, origin: 'main' | 'goal'): Promise<Record<string, string>> {
    const env = await this.workerEnv(workspace, cwd, origin === 'goal' ? 'goal' : 'interactive');
    delete env.PI_PACKAGE_DIR;
    delete env.PI_RUNTIME_CONFIG;
    delete env.PI_GOAL_WORKER;
    delete env.PI_ALLOWED_EXTENSIONS;
    return env;
  }

  private async writeContextExclusion(
    workspace: string,
    op: 'add' | 'remove',
    rawTimestamp: unknown,
  ): Promise<{ ok: true; op: 'add' | 'remove'; timestamp: number }> {
    const timestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Number(rawTimestamp);
    if (!Number.isFinite(timestamp)) throw new Error('INVALID_CONTEXT_EXCLUSION_TIMESTAMP');
    const path = this.options.runtimeConfigPath;
    if (!path) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    this.exclusionPulseRev = Math.max(Date.now(), this.exclusionPulseRev + 1);
    const pulse = JSON.stringify({ op, ts: timestamp, rev: this.exclusionPulseRev });
    await mergeRuntimeSettingsFile(path, {
      [contextExclusionConfigKey(workspace)]: pulse,
      [contextExclusionConfigKey(resolved)]: pulse,
    });
    return { ok: true, op, timestamp };
  }

  private async writeAgentMode(workspace: string, rawMode: unknown): Promise<{ ok: true; mode: string }> {
    const mode = String(rawMode ?? '').trim().toLowerCase();
    if (!isAgentMode(mode)) throw new Error('INVALID_AGENT_MODE');
    setAgentMode(mode, workspace);
    const path = this.options.runtimeConfigPath;
    if (!path) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    setAgentMode(mode, resolved);
    await mergeRuntimeSettingsFile(path, {
      [agentModeConfigKey(workspace)]: mode,
      [agentModeConfigKey(resolved)]: mode,
    });
    return { ok: true, mode };
  }

  private async writeApprovalPolicy(workspace: string, rawLevel: unknown): Promise<{ ok: true; level: ApprovalPolicy }> {
    const level = parseApproval(typeof rawLevel === 'string' ? rawLevel : String(rawLevel ?? ''));
    if (!level) throw new Error('INVALID_APPROVAL_POLICY');
    setApprovalPolicy(level, workspace);
    const path = this.options.runtimeConfigPath;
    if (!path) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    setApprovalPolicy(level, resolved);
    await mergeRuntimeSettingsFile(path, {
      [approvalPolicyConfigKey(workspace)]: level,
      [approvalPolicyConfigKey(resolved)]: level,
    });
    return { ok: true, level };
  }

  private async runOnHandle(handle: WorkspaceHandlePort, command: PiCommand, args: Record<string, unknown>, origin: 'main' | 'goal'): Promise<unknown> {
    const s = handle.session;
    const images = Array.isArray(args.images) ? (args.images as ImageContent[]) : undefined;
    switch (command) {
      case 'agent_prompt':
        return handle.prompt(readInput(args), { images, ...(args.streamingBehavior ? { streamingBehavior: args.streamingBehavior as 'steer' | 'followUp' } : {}) }, origin);
      case 'agent_steer': await s.steer(readInput(args), images); return undefined;
      case 'agent_follow_up': await s.followUp(readInput(args), images); return undefined;
      case 'agent_abort': await s.abort(); return undefined;
      case 'agent_set_model': {
        const model = s.modelRuntime.getAvailableSnapshot().find((m) => m.provider === args.provider && m.id === args.modelId);
        if (!model) throw new Error(`Model not found: ${String(args.provider)}/${String(args.modelId)}`);
        await s.setModel(model);
        return snapshotSessionModel(model) ?? model;
      }
      case 'agent_cycle_model': return (await s.cycleModel()) ?? null;
      case 'agent_get_available_models': return {
        models: s.modelRuntime.getAvailableSnapshot().map((m) => snapshotSessionModel(m) ?? m),
      };
      case 'agent_set_thinking_level': s.setThinkingLevel(args.level as Parameters<AgentSession['setThinkingLevel']>[0]); return undefined;
      case 'agent_cycle_thinking_level': { const level = s.cycleThinkingLevel(); return level ? { level } : null; }
      case 'agent_compact': return s.compact(typeof args.customInstructions === 'string' ? args.customInstructions : undefined);
      case 'agent_set_auto_compaction': s.setAutoCompactionEnabled(args.enabled === true); return undefined;
      case 'agent_abort_retry': s.abortRetry(); return undefined;
      case 'agent_get_session_stats': return s.getSessionStats();
      case 'agent_get_state': return handle.getState();
      case 'agent_get_messages': {
        const build = s.sessionManager?.buildSessionProjection;
        if (typeof build === 'function') {
          return { messages: messagesWithEntryIds(build.call(s.sessionManager)) };
        }
        return { messages: s.messages };
      }
      case 'agent_get_commands': return handle.getCommands();
      case 'agent_get_fork_messages': return { messages: s.getUserMessagesForForking() };
      case 'agent_set_session_name': {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('Session name cannot be empty');
        s.setSessionName(name);
        return undefined;
      }
      case 'agent_new_session': return handle.newSession();
      case 'agent_switch_session': return handle.switchSession(String(args.sessionPath ?? ''));
      case 'agent_fork': return { ...(await handle.fork(String(args.entryId ?? ''))), };
      case 'agent_clone': {
        const leafId = s.sessionManager.getLeafId();
        if (!leafId) throw new Error('Cannot clone session: no current entry selected');
        return { cancelled: (await handle.fork(leafId, { position: 'at' })).cancelled };
      }
      case 'agent_rewind_to': return handle.fork(String(args.entryId ?? ''));
      case 'agent_truncate_to': throw new Error('agent_truncate_to must run through truncateSessionTo');
      default: throw new Error(`Unsupported handle command: ${command}`);
    }
  }

  private async truncateSessionTo(handle: WorkspaceHandlePort, args: Record<string, unknown>): Promise<unknown> {
    const state = handle.getState();
    const sessionFile = state.sessionFile;
    if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('no active session file');
    const entryId = typeof args.entryId === 'string' ? args.entryId.trim() : '';
    if (!entryId) throw new Error('entryId is required');
    const mode = args.mode;
    if (mode !== 'drop-target' && mode !== 'keep-target') {
      throw new Error('mode must be drop-target or keep-target');
    }

    if (handle.session.isStreaming) await handle.session.abort();
    await handle.session.waitForIdle();

    const raw = await readFile(sessionFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const result = truncateSessionLines(lines, entryId, mode as TruncateMode);
    if (!result.ok) return result;

    const temporary = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${result.lines.join('\n')}\n`, 'utf8');
      await rename(temporary, sessionFile);
    } catch (error) {
      // rename 成功后 temporary 路径已不存在；仅在写/换名失败时清掉残留 tmp，绝不删 sessionFile。
      await rm(temporary, { force: true });
      throw error;
    }

    try {
      await handle.reload();
    } catch (firstError) {
      try {
        await handle.reload();
      } catch (secondError) {
        const cause = secondError instanceof Error ? secondError.message : String(secondError);
        const prior = firstError instanceof Error ? firstError.message : String(firstError);
        throw new Error(
          `Session file truncated on disk but in-memory session reload failed (retried once; first: ${prior}): ${cause}`,
        );
      }
    }
    return result;
  }

  private handleOps(handle: WorkspaceHandlePort, origin: 'main' | 'goal' = 'main'): SessionOps {
    return {
      getState: async () => handle.getState(),
      run: (command, args) => this.runOnHandle(handle, command, args, origin),
      // 进程内 session 自知身份，无需回写。
    };
  }

  private async openInteractive(workspace: string): Promise<WorkspaceHandlePort> {
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    return this.options.agentHost.open(workspace, cwd);
  }

  private async resolveHandle(workspace: string): Promise<WorkspaceHandlePort> {
    return this.options.agentHost.get(workspace) ?? await this.openInteractive(workspace);
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
    env.PI_HUMAN_ORIGIN_TOKEN = source === 'interactive' ? '1' : '0';
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
    const turnId = readOptionalString(args.turnId) ?? randomUUID();
    if (createThread) await this.options.threadStore!.createThread({ id: threadId, projectId: workspace, workspace, ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    this.workspaceThreads.set(stateKey, threadId);
    const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
    this.permissionProfiles.set(stateKey, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace');
    await this.options.threadStore!.createTurn({ id: turnId, threadId, input, permissionProfile: typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    const active: ActiveTurn = {
      workspace,
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      source: session.source ?? 'interactive',
      threadId,
      turnId,
    };
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

  private async flushFollowUp(workspace: string, session: SessionContext): Promise<unknown> {
    const handle = await this.resolveHandle(workspace);
    if (handle.session.isStreaming) return undefined;
    const queued = [...handle.session.getFollowUpMessages()];
    if (queued.length === 0) return undefined;
    const restored = handle.session.clearQueue();
    for (const item of restored.steering) await handle.session.steer(item);
    for (const item of restored.followUp.slice(1)) await handle.session.followUp(item);
    return this.send(workspace, 'agent_prompt', { message: queued[0], ...session });
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

  private hasInteractiveTurn(workspace: string): boolean {
    return [...this.activeTurns.values()].some((turn) => turn.workspace === workspace && turn.source === 'interactive');
  }

  private findEventKey(workspace: string, sessionId?: string): string | undefined {
    if (sessionId) return this.activeTurns.has(this.sessionKey(workspace, sessionId)) ? this.sessionKey(workspace, sessionId) : undefined;
    const legacy = this.sessionKey(workspace);
    if (this.activeTurns.has(legacy)) return legacy;
    const candidates = [...this.activeTurns.entries()].filter(([, active]) => active.workspace === workspace);
    return candidates.length === 1 ? candidates[0][0] : undefined;
  }

  private async resolveSessionForCommand(workspace: string, command: string, args: Record<string, unknown>): Promise<SessionContext> {
    try {
      return await this.resolveSession(workspace, args, { deferInteractiveBinding: command === 'agent_switch_session' });
    } catch (error) {
      if (isSessionWorkspaceMismatch(error) && (command === 'agent_new_session' || command === 'agent_get_state' || command === 'agent_get_available_models')) {
        this.currentSessionByWorkspace.delete(workspace);
        return { source: 'interactive' };
      }
      throw error;
    }
  }

  private async sessionFileMismatches(sessionFile: string, workspace: string): Promise<boolean> {
    try {
      await readSessionIdentity(sessionFile, workspace);
      return false;
    } catch (error) {
      return isSessionWorkspaceMismatch(error);
    }
  }

  private async ownedState(workspace: string, result: unknown): Promise<unknown> {
    if (!result || typeof result !== 'object') return result;
    const state = result as Record<string, unknown>;
    const file = state.sessionFile;
    if (typeof file !== 'string' || !file || !await this.sessionFileMismatches(file, workspace)) return result;
    return { ...state, sessionFile: null, sessionId: null };
  }

  private async resolveSession(workspace: string, args: Record<string, unknown>, options?: { deferInteractiveBinding?: boolean }): Promise<SessionContext> {
    const suppliedId = readOptionalString(args.sessionId);
    const suppliedPath = readOptionalString(args.sessionPath);
    const current = this.currentSessionByWorkspace.get(workspace);
    const session: SessionContext = {
      sessionId: suppliedId ?? (suppliedPath ? undefined : current?.sessionId),
      sessionPath: suppliedPath ?? current?.sessionPath,
      source: current?.source,
    };
    if (session.sessionPath) {
      const identity = await readSessionIdentity(session.sessionPath, workspace);
      if (session.sessionId && identity.sessionId !== session.sessionId) throw new Error('SESSION_ID_MISMATCH');
      session.sessionId = identity.sessionId;
      session.sessionPath = identity.sessionPath;
      const interactive = { ...session, source: 'interactive' as const };
      if (options?.deferInteractiveBinding) Object.assign(session, interactive);
      else await this.replaceCurrentSession(workspace, interactive);
    }
    return session;
  }

  private async readCurrentIdentity(workspace: string, sessionFile: string | null, stateSessionId?: string): Promise<SessionContext | undefined> {
    if (!sessionFile) return stateSessionId ? { sessionId: stateSessionId, source: 'interactive' } : undefined;
    try {
      const identity = await readSessionIdentity(sessionFile, workspace);
      return { sessionId: identity.sessionId, sessionPath: identity.sessionPath, source: 'interactive' };
    } catch (error) {
      if (isSessionWorkspaceMismatch(error)) return undefined;
      return stateSessionId ? { sessionId: stateSessionId, sessionPath: sessionFile, source: 'interactive' } : undefined;
    }
  }

  private async refreshCurrentSession(workspace: string, ops: SessionOps): Promise<SessionContext | undefined> {
    const state = await ops.getState();
    const identity = await this.readCurrentIdentity(workspace, typeof state.sessionFile === 'string' ? state.sessionFile : null, typeof state.sessionId === 'string' ? state.sessionId : undefined);
    if (identity) {
      await this.replaceCurrentSession(workspace, identity);
      if (identity.sessionId) ops.setSessionIdentity?.(identity.sessionId, identity.sessionPath);
    }
    return identity;
  }

  /** Used by AgentData project authorization for the currently open session. */
  async ownsSession(workspace: string, sessionId: string): Promise<boolean> {
    return this.currentSessionByWorkspace.get(workspace)?.sessionId === sessionId;
  }

  private async replaceCurrentSession(workspace: string, identity: SessionContext): Promise<void> {
    this.currentSessionByWorkspace.set(workspace, identity);
    if (identity.sessionId) await this.retryPendingSessionFork(workspace, identity.sessionId);
  }

  private async syncSessionFork(workspace: string, sourceSessionId: string, targetSessionId: string): Promise<boolean> {
    const callback = this.options.onSessionForked;
    const key = this.sessionKey(workspace, targetSessionId);
    if (!callback) {
      this.pendingSessionForks.delete(key);
      return true;
    }
    const running = this.sessionForkSyncInFlight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        await callback({ workspace, sourceSessionId, targetSessionId });
        this.pendingSessionForks.delete(key);
        return true;
      } catch {
        this.pendingSessionForks.set(key, { sourceSessionId, targetSessionId });
        return false;
      }
    })();
    this.sessionForkSyncInFlight.set(key, task);
    try { return await task; } finally {
      if (this.sessionForkSyncInFlight.get(key) === task) this.sessionForkSyncInFlight.delete(key);
    }
  }

  private async retryPendingSessionFork(workspace: string, targetSessionId: string): Promise<boolean> {
    const pending = this.pendingSessionForks.get(this.sessionKey(workspace, targetSessionId));
    if (!pending) return true;
    return this.syncSessionFork(workspace, pending.sourceSessionId, pending.targetSessionId);
  }

  private emitRuntimeEvent(workspace: string, session: SessionContext, event: Record<string, unknown>): void {
    this.options.onEvent?.({ workspace, event, source: session.source ?? 'interactive', ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
  }
}

function shouldFlushFollowUp(args: Record<string, unknown>, hasActiveTurn: boolean): boolean {
  if (hasActiveTurn || args.streamingBehavior !== 'followUp') return false;
  const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
  return !input.trim();
}

function shouldEnqueuePrompt(args: Record<string, unknown>, hasActiveTurn: boolean, queuedCount: number): boolean {
  if (args.streamingBehavior === 'steer') return false;
  if (shouldFlushFollowUp(args, hasActiveTurn)) return false;
  if (queuedCount > 0) return true;
  return args.streamingBehavior === 'followUp' && hasActiveTurn;
}

function shouldTrackTurn(command: string, args: Record<string, unknown>): boolean {
  if (command === 'agent_abort') return true;
  if (command === 'agent_follow_up') return false;
  if (command !== 'agent_prompt') return false;
  if (args.streamingBehavior === 'steer') return false;
  if (args.streamingBehavior === 'followUp') return true;
  const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
  return !input.trimStart().startsWith('/');
}

const SESSION_REPLACING_COMMANDS = ['agent_switch_session', 'agent_new_session', 'agent_fork', 'agent_clone', 'agent_rewind_to'];

function summarizeTurn(raw: Record<string, unknown>, event: PiProjection): string {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const text = messages
    .filter(isRecord)
    .filter(message => message.role === 'assistant')
    .map(message => message.content)
    .map(content => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .filter(isRecord)
        .filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text as string)
        .join('');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  if (text) return text.slice(-4000);
  const data = isRecord(event.data) ? event.data : {};
  return readOptionalString(data.errorMessage)
    ?? readOptionalString(data.error)
    ?? (event.type === 'turn.completed' ? 'Turn completed without an assistant summary.' : `Turn ${event.type.replace('turn.', '')}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCancelledResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.cancelled === true;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readInput(args: Record<string, unknown>): string {
  return typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
}

function stripSessionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, sessionPath: _sessionPath, source: _source, goalId: _goalId, goalCondition: _goalCondition, revision: _revision, nextRound: _nextRound, idempotencyKey: _idempotencyKey, turnId: _turnId, ...rpcArgs } = args;
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
