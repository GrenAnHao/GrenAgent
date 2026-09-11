import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentSession, PromptOptions } from '../../../cli/src/pi-sdk.js';
import type { WorkspaceHandle } from '../agent/workspaceHandle.js';
import type { SessionEventMeta } from '../pi/eventAdapter';
import type { Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';
import { adaptPiEvent, type PiProjection } from '../pi/eventAdapter';
import { readSessionIdentity } from './sessionIdentity';
import { setApprovalPolicy } from '../../../extensions/_shared/approval.js';
import { approvalPolicyConfigKey, contextExclusionConfigKey, mergeRuntimeSettingsFile } from './settingsService';

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
}
export type WorkspaceHandlePort = Pick<WorkspaceHandle,
  'session' | 'prompt' | 'getState' | 'getCommands' | 'newSession' | 'switchSession' | 'fork' | 'ui' | 'currentTurnOrigin' | 'dispose'>;

export interface GoalHostPort {
  open(workspace: string, sessionId: string, sessionPath: string): Promise<WorkspaceHandlePort>;
  get(workspace: string, sessionId: string): WorkspaceHandlePort | undefined;
  findBySessionPath(sessionPath: string): { workspace: string; sessionId: string; handle: WorkspaceHandlePort } | undefined;
  dispose(workspace: string, sessionId: string): Promise<void>;
  disposeAllForWorkspace(workspace: string): Promise<void>;
}

/** 第 3 份已删除 client 接缝：会话操作一律走 runOnHandle。 */
interface SessionOps {
  getState(): Promise<Record<string, unknown>>;
  run(command: PiCommand, args: Record<string, unknown>): Promise<unknown>;
  setSessionIdentity?(sessionId: string, sessionPath?: string): void;
}

interface PiEventMeta { sessionId?: string; sessionPath?: string; source?: 'interactive' | 'goal' }
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
  source: 'interactive' | 'goal';
  event: Record<string, unknown>;
}

export interface PiGoalTurnRequest {
  workspace: string;
  sessionId: string;
  sessionPath?: string;
  turnId: string;
  goal: { goalId: string; revision: number; nextRound: number; idempotencyKey: string; condition: string };
}

export interface PiTurnSettledResult {
  workspace: string;
  sessionId?: string;
  sessionPath?: string;
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  goal?: { goalId: string; revision: number; nextRound: number; idempotencyKey: string };
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
  goal?: { goalId: string; revision: number; nextRound: number; idempotencyKey: string };
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
  migrateLegacyGoal?: (input: {
    workspace: string;
    sessionId: string;
    sessionPath: string;
    condition: string;
    react: number;
    paused: boolean;
    legacyEntryTimestamp?: string | number;
  }) => void | Promise<void>;
  bindGoalSession?: (workspace: string, sessionId: string, source?: 'interactive' | 'goal') => Promise<void> | void;
  unbindGoalSession?: (workspace: string, sessionId: string) => Promise<void> | void;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
  allowedPluginIds?: () => string[];
  agentHost: AgentHostPort;
  goalHost: GoalHostPort;
  modelRuntimeHost: { refresh(): Promise<void>; workspaces?(): string[] };
}

export class PiRuntimeService {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly assistantItems = new Map<string, string>();
  private readonly itemPayloads = new Map<string, Record<string, unknown>>();
  private readonly workspaceThreads = new Map<string, string>();
  private readonly queuedTurns = new Map<string, Array<{ input: string; permissionProfile: string }>>();
  private readonly queuedGoalTurns = new Map<string, PiGoalTurnRequest[]>();
  private readonly permissionProfiles = new Map<string, string>();
  private readonly currentSessionByWorkspace = new Map<string, SessionContext>();
  // Goal workers are scoped by the pair, not by session id alone: a session id
  // reaching this boundary is caller-supplied and not yet validated against a
  // session file, so it must never address another workspace's worker.
  private readonly goalWorkers = new Map<string, string>();
  private readonly sessionPaths = new Map<string, { workspace: string; sessionPath: string }>();
  private readonly goalTurnKeys = new Map<string, string>();
  private readonly legacyMigrationKeys = new Set<string>();
  private readonly legacyMigrationInFlight = new Map<string, Promise<void>>();
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
    return {
      restoredSession: null,
      sessionFile,
      ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
    };
  }

  async warmWorkspace(workspace: string): Promise<void> {
    await this.openInteractive(workspace);
  }

  async closeWorkspace(workspace: string): Promise<void> {
    const closingGoalTurns = new Map<string, ActiveTurn>();
    for (const active of this.activeTurns.values()) {
      if (active.workspace === workspace && active.source === 'goal' && active.goal) closingGoalTurns.set(active.turnId, active);
    }
    for (const [key, queue] of this.queuedGoalTurns) {
      if (!key.startsWith(`${workspace}\0`)) continue;
      for (const queued of queue) {
        if (closingGoalTurns.has(queued.turnId)) continue;
        closingGoalTurns.set(queued.turnId, {
          workspace,
          sessionId: queued.sessionId,
          sessionPath: queued.sessionPath,
          source: 'goal',
          threadId: '',
          turnId: queued.turnId,
          goal: queued.goal,
        });
      }
    }
    let failure: unknown;
    let hasFailure = false;
    for (const turn of closingGoalTurns.values()) {
      try {
        await this.options.onTurnSettled?.({
          workspace,
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
          ...(turn.sessionPath ? { sessionPath: turn.sessionPath } : {}),
          turnId: turn.turnId,
          status: 'cancelled',
          summary: 'Workspace closed before the Goal turn completed.',
          goal: turn.goal,
        });
      } catch (error) {
        if (!hasFailure) { failure = error; hasFailure = true; }
      }
    }
    for (const [key, active] of this.activeTurns) if (active.workspace === workspace) this.activeTurns.delete(key);
    for (const key of this.assistantItems.keys()) if (key.startsWith(`${workspace}\0`)) this.assistantItems.delete(key);
    for (const key of this.workspaceThreads.keys()) if (key.startsWith(`${workspace}\0`)) this.workspaceThreads.delete(key);
    for (const key of this.queuedTurns.keys()) if (key.startsWith(`${workspace}\0`)) this.queuedTurns.delete(key);
    for (const key of this.queuedGoalTurns.keys()) if (key.startsWith(`${workspace}\0`)) this.queuedGoalTurns.delete(key);
    for (const key of this.permissionProfiles.keys()) if (key.startsWith(`${workspace}\0`)) this.permissionProfiles.delete(key);
    const previousSession = this.currentSessionByWorkspace.get(workspace);
    this.currentSessionByWorkspace.delete(workspace);
    const goalSessions = [...this.goalWorkers.entries()]
      .filter(([, owner]) => owner === workspace)
      .map(([key]) => sessionIdFromStateKey(key));
    const closedGoals = await Promise.allSettled(goalSessions.map((sessionId) => this.closeGoalWorker(sessionId, workspace)));
    for (const result of closedGoals) {
      if (result.status === 'rejected' && !hasFailure) { failure = result.reason; hasFailure = true; }
    }
    try {
      // Closing the visible worker must be attempted even when a headless
      // Goal worker has already exited or failed to close.
      await this.options.agentHost.close(workspace);
    } catch (error) {
      if (!hasFailure) { failure = error; hasFailure = true; }
    }
    try {
      if (previousSession?.sessionId) await this.options.unbindGoalSession?.(workspace, previousSession.sessionId);
    } catch (error) {
      if (!hasFailure) { failure = error; hasFailure = true; }
    }
    for (const [key, owner] of this.sessionPaths) if (owner.workspace === workspace) this.sessionPaths.delete(key);
    for (const key of this.goalTurnKeys.keys()) if (key.startsWith(`${workspace}\0`)) this.goalTurnKeys.delete(key);
    for (const key of this.legacyMigrationKeys) {
      if (key.startsWith(`${workspace}\0`) && !this.legacyMigrationInFlight.has(key)) this.legacyMigrationKeys.delete(key);
    }
    if (hasFailure) throw failure;
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    // A headless Goal worker shares its session with the visible worker. It may
    // never switch, replace, fork or rewind what the user is looking at, so the
    // rejection happens before authorization can widen an automation profile.
    if (args.source === 'goal' && SESSION_REPLACING_COMMANDS.includes(command)) throw new Error('GOAL_SESSION_COMMAND_FORBIDDEN');
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    if (command === 'agent_set_approval') {
      return this.writeApprovalPolicy(workspace, args.level);
    }
    if (command === 'agent_exclude_entry' || command === 'agent_restore_entry') {
      return this.writeContextExclusion(workspace, command === 'agent_exclude_entry' ? 'add' : 'remove', args.timestamp);
    }
    if (SESSION_REPLACING_COMMANDS.includes(command) && this.hasInteractiveTurn(workspace)) {
      throw new Error('SESSION_BUSY');
    }
    const session = await this.resolveSession(workspace, args, { deferInteractiveBinding: command === 'agent_switch_session' });
    const sourceSessionId = session.sessionId;
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (command === 'agent_prompt' && session.source === 'goal' && this.activeTurns.has(stateKey)) {
      return this.queueGoalTurnFromArgs(workspace, session, args);
    }
    if (command === 'agent_prompt' && session.source === 'goal' && args.streamingBehavior === 'followUp') {
      throw new Error('INVALID_GOAL_TURN');
    }
    if (command === 'agent_prompt' && args.streamingBehavior === 'followUp' && this.activeTurns.has(stateKey)) {
      const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
      return this.enqueueTurn(workspace, input, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', session);
    }
    if (session.source !== 'goal') {
      await this.preemptGoalTurn(workspace, command, args);
    }
    const handle = await this.resolveHandle(workspace, session);
    const origin = session.source === 'goal' ? 'goal' : 'main';
    const ops: SessionOps = this.handleOps(handle, origin);
    if (session.source !== 'goal' && session.sessionId && command !== 'agent_switch_session') ops.setSessionIdentity?.(session.sessionId, session.sessionPath);
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
      const targetIdentity = await this.refreshCurrentSession(workspace, ops, false);
      if (targetIdentity?.sessionId) ops.setSessionIdentity?.(targetIdentity.sessionId, targetIdentity.sessionPath);
      const targetSessionId = targetIdentity?.sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId;
      const forkReady = sourceSessionId && targetSessionId && sourceSessionId !== targetSessionId
        ? await this.syncSessionFork(workspace, sourceSessionId, targetSessionId)
        : true;
      if (targetIdentity && forkReady) await this.migrateLegacyGoal(workspace, targetIdentity);
      return result;
    }
    // The first lease check runs before opening the worker. Recheck after the
    // async open because a user turn may have started while the worker spawned.
    if (command === 'agent_prompt' && session.source === 'goal' && this.activeTurns.has(stateKey)) {
      return this.queueGoalTurnFromArgs(workspace, session, args);
    }
    if (session.source === 'goal' && (command === 'agent_prompt' || command === 'agent_follow_up') && !readGoalTurnMetadata(args)) {
      throw new Error('INVALID_GOAL_TURN');
    }
    const adapter = this.options.threadStore && shouldTrackTurn(command, args)
      ? await this.prepareTurn(workspace, command, args, session)
      : undefined;
    try {
      const result = await ops.run(command as PiCommand, rpcArgs);
      // Only an interactive command may move the visible session pointer. A
      // Goal worker polling its own state must stay invisible to the UI.
      if (command === 'agent_get_state' && session.source !== 'goal') await this.refreshCurrentSession(workspace, ops);
      if (command === 'agent_new_session' || command === 'agent_switch_session' || command === 'agent_fork' || command === 'agent_clone') {
        if (isCancelledResult(result)) return result;
        this.workspaceThreads.delete(stateKey);
        if (command === 'agent_switch_session') {
          this.workspaceThreads.delete(this.sessionKey(workspace, this.currentSessionByWorkspace.get(workspace)?.sessionId));
        }
        const isSessionFork = command === 'agent_fork' || command === 'agent_clone';
        const targetIdentity = isSessionFork
          ? await this.refreshCurrentSession(workspace, ops, false)
          : await this.refreshCurrentSession(workspace, ops);
        if (targetIdentity?.sessionId) {
          ops.setSessionIdentity?.(targetIdentity.sessionId, targetIdentity.sessionPath);
        }
        if (isSessionFork && sourceSessionId) {
          const targetSessionId = targetIdentity?.sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId;
          const forkReady = targetSessionId && targetSessionId !== sourceSessionId
            ? await this.syncSessionFork(workspace, sourceSessionId, targetSessionId)
            : true;
          if (targetIdentity && forkReady) await this.migrateLegacyGoal(workspace, targetIdentity);
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

  async handlePiEvent(workspace: string, raw: Record<string, unknown>, sessionOrMetadata?: EventMeta, source?: 'interactive' | 'goal'): Promise<void> {
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
      try {
        await this.options.onTurnSettled?.({
          workspace,
          ...(active.sessionId ? { sessionId: active.sessionId } : {}),
          ...(active.sessionPath ? { sessionPath: active.sessionPath } : {}),
          turnId: active.turnId,
          status: event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed',
          summary: summarizeTurn(raw, event),
          ...(active.goal ? { goal: active.goal } : {}),
        });
      } finally {
        // A coordinator callback may fail while persisting or judging. The
        // terminal Pi event must still release the next queued turn.
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
    if (!stateKey || !active || (eventSource && eventSource !== active.source)) {
      // A crashed Goal worker can still own queued automatic turns even when no
      // turn is active. Their AgentData leases must not stay claimed.
      if (eventSource === 'goal' && eventSessionId) {
        await this.failQueuedGoalTurns(workspace, this.sessionKey(workspace, eventSessionId), summary);
      }
      return;
    }
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
        ...(active.goal ? { goal: active.goal } : {}),
      });
    } finally {
      if (active.source === 'goal') await this.failQueuedGoalTurns(workspace, stateKey, summary);
      else await this.drainQueuedTurn(workspace, { sessionId: active.sessionId, sessionPath: active.sessionPath, source: active.source }).catch(() => {});
    }
  }

  /**
   * Report every queued automatic turn as a runtime failure before dropping it.
   * Each queued turn already holds a claimed AgentData lease, so removing the
   * in-memory entry alone would leave the Goal waiting on a turn that can never
   * run. The reason is a runtime fault, never a business blockage.
   */
  private async failQueuedGoalTurns(workspace: string, stateKey: string, summary: string): Promise<void> {
    const queued = this.queuedGoalTurns.get(stateKey);
    if (!queued?.length) {
      this.queuedGoalTurns.delete(stateKey);
      return;
    }
    this.queuedGoalTurns.delete(stateKey);
    for (const item of queued) {
      this.goalTurnKeys.delete(this.goalTurnKey(workspace, item.sessionId, item.goal.idempotencyKey));
      try {
        await this.options.onTurnSettled?.({
          workspace,
          sessionId: item.sessionId,
          ...(item.sessionPath ? { sessionPath: item.sessionPath } : {}),
          turnId: item.turnId,
          status: 'failed',
          summary,
          goal: {
            goalId: item.goal.goalId,
            revision: item.goal.revision,
            nextRound: item.goal.nextRound,
            idempotencyKey: item.goal.idempotencyKey,
          },
        });
      } catch {
        // One failed callback must not strand the remaining queued leases.
      }
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

  /** Reject a UI request from a headless Goal worker without routing it to the visible worker. */
  async rejectUiRequest(workspace: string, metadata: EventMeta | undefined, requestId: string): Promise<void> {
    if (!requestId.trim()) return;
    const meta = typeof metadata === 'string' ? { sessionId: metadata } : metadata;
    const handle = meta?.source === 'goal' && meta.sessionId
      ? this.options.goalHost.get(workspace, meta.sessionId) ?? this.options.agentHost.get(workspace)
      : this.options.agentHost.get(workspace);
    handle?.ui.respond(requestId, { cancelled: true });
  }

  permissionProfile(workspace: string, sessionId?: string): string | undefined {
    return this.permissionProfiles.get(this.sessionKey(workspace, sessionId ?? this.currentSessionByWorkspace.get(workspace)?.sessionId));
  }

  async refreshModelRegistry(): Promise<{ refreshed: string[]; failed: Array<{ workspace: string; error: string }> }> {
    await this.options.modelRuntimeHost.refresh();
    const result = { refreshed: [] as string[], failed: [] as Array<{ workspace: string; error: string }> };
    for (const workspace of this.options.modelRuntimeHost.workspaces?.() ?? []) {
      result.refreshed.push(workspace);
    }
    return result;
  }

  async openGoalWorker(sessionId: string, workspace: string, sessionPath: string): Promise<WorkspaceHandlePort> {
    if (!sessionId.trim() || !sessionPath.trim()) throw new Error('INVALID_SESSION_IDENTITY');
    const identity = await readSessionIdentity(sessionPath, workspace);
    if (identity.sessionId !== sessionId) throw new Error('SESSION_ID_MISMATCH');
    await this.bindSession(workspace, { ...identity, source: 'goal' });
    const stateKey = this.sessionKey(workspace, sessionId);
    this.sessionPaths.set(stateKey, { workspace, sessionPath });
    const existing = this.options.goalHost.get(workspace, sessionId);
    const handle = existing ?? await this.options.goalHost.open(workspace, sessionId, sessionPath);
    try {
      const stateSessionId = handle.session.sessionId;
      if (stateSessionId && stateSessionId !== sessionId) throw new Error('GOAL_WORKER_SESSION_MISMATCH');
      const statePath = typeof handle.session.sessionFile === 'string' ? handle.session.sessionFile : undefined;
      if (statePath && normalizeSessionPath(statePath) !== normalizeSessionPath(sessionPath)) throw new Error('GOAL_WORKER_SESSION_MISMATCH');
    } catch (error) {
      await this.closeGoalWorker(sessionId, workspace).catch(() => {});
      throw error;
    }
    this.goalWorkers.set(stateKey, workspace);
    return handle;
  }

  async closeGoalWorker(sessionId: string, workspace?: string): Promise<void> {
    const stateKey = this.resolveGoalStateKey(sessionId, workspace);
    const owner = stateKey ? this.goalWorkers.get(stateKey) ?? this.sessionPaths.get(stateKey)?.workspace : workspace;
    if (stateKey) this.goalWorkers.delete(stateKey);
    try {
      if (owner !== undefined) await this.options.goalHost.dispose(owner, sessionId);
    } finally {
      // Always release the path and restore the interactive binding, even if
      // dispose rejects.
      if (stateKey) this.sessionPaths.delete(stateKey);
      if (owner !== undefined) {
        try {
          await this.options.unbindGoalSession?.(owner, sessionId);
        } finally {
          const current = this.currentSessionByWorkspace.get(owner);
          if (current?.sessionId === sessionId) await this.bindSession(owner, current);
        }
      }
    }
  }

  /** Queue exactly one automatic turn for a committed Goal dispatch. */
  async enqueueGoalTurn(input: PiGoalTurnRequest): Promise<void> {
    const visible = this.currentSessionByWorkspace.get(input.workspace);
    const sessionPath = input.sessionPath
      ?? this.sessionPaths.get(this.sessionKey(input.workspace, input.sessionId))?.sessionPath
      // The visible session path only describes its own session id; borrowing it
      // for another session would run the automatic turn against the wrong file.
      ?? (visible?.sessionId === input.sessionId ? visible.sessionPath : undefined);
    if (!input.sessionId.trim() || !sessionPath?.trim() || !input.turnId.trim() || !input.goal.goalId.trim()) throw new Error('INVALID_GOAL_TURN');
    const turnKey = this.goalTurnKey(input.workspace, input.sessionId, input.goal.idempotencyKey);
    const prior = this.goalTurnKeys.get(turnKey);
    if (prior) {
      if (prior !== input.turnId) throw new Error('GOAL_TURN_IDEMPOTENCY_CONFLICT');
      return;
    }
    const stateKey = this.sessionKey(input.workspace, input.sessionId);
    if (this.activeTurns.has(stateKey)) {
      this.goalTurnKeys.set(turnKey, input.turnId);
      const queue = this.queuedGoalTurns.get(stateKey) ?? [];
      queue.push({ ...input, sessionPath });
      this.queuedGoalTurns.set(stateKey, queue);
      return;
    }
    this.goalTurnKeys.set(turnKey, input.turnId);
    try {
      await this.dispatchGoalTurn({ ...input, sessionPath });
    } catch (error) {
      this.goalTurnKeys.delete(turnKey);
      throw error;
    }
  }

  eventEnvelope(workspace: string, raw: Record<string, unknown>, metadata?: EventMeta): PiRuntimeEventEnvelope {
    const sessionId = (typeof metadata === 'string' ? metadata : metadata?.sessionId) ?? readOptionalString(raw.sessionId);
    const stateKey = this.findEventKey(workspace, sessionId);
    const active = stateKey ? this.activeTurns.get(stateKey) : undefined;
    const source = (typeof metadata === 'object' ? metadata?.source : undefined) ?? active?.source ?? 'interactive';
    return {
      workspace,
      event: raw,
      source,
      ...(sessionId ?? active?.sessionId ? { sessionId: sessionId ?? active?.sessionId } : {}),
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

  private async writeApprovalPolicy(workspace: string, rawLevel: unknown): Promise<{ ok: true; level: 'ask' | 'auto' | 'full' }> {
    const level = String(rawLevel ?? '').trim().toLowerCase();
    if (level !== 'ask' && level !== 'auto' && level !== 'full') throw new Error('INVALID_APPROVAL_POLICY');
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
      case 'agent_set_mode':
        return handle.prompt(`/mode ${String(args.mode ?? '')}`, {}, origin);
      case 'agent_steer': await s.steer(readInput(args), images); return undefined;
      case 'agent_follow_up': await s.followUp(readInput(args), images); return undefined;
      case 'agent_abort': await s.abort(); return undefined;
      case 'agent_set_model': {
        const model = s.modelRuntime.getAvailableSnapshot().find((m) => m.provider === args.provider && m.id === args.modelId);
        if (!model) throw new Error(`Model not found: ${String(args.provider)}/${String(args.modelId)}`);
        await s.setModel(model);
        return model;
      }
      case 'agent_cycle_model': return (await s.cycleModel()) ?? null;
      case 'agent_get_available_models': return { models: s.modelRuntime.getAvailableSnapshot() };
      case 'agent_set_thinking_level': s.setThinkingLevel(args.level as Parameters<AgentSession['setThinkingLevel']>[0]); return undefined;
      case 'agent_cycle_thinking_level': { const level = s.cycleThinkingLevel(); return level ? { level } : null; }
      case 'agent_compact': return s.compact(typeof args.customInstructions === 'string' ? args.customInstructions : undefined);
      case 'agent_set_auto_compaction': s.setAutoCompactionEnabled(args.enabled === true); return undefined;
      case 'agent_abort_retry': s.abortRetry(); return undefined;
      case 'agent_get_session_stats': return s.getSessionStats();
      case 'agent_get_state': return handle.getState();
      case 'agent_get_messages': return { messages: s.messages };
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
      default: throw new Error(`Unsupported handle command: ${command}`);
    }
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

  private async resolveHandle(workspace: string, session: SessionContext): Promise<WorkspaceHandlePort> {
    const interactive = this.options.agentHost.get(workspace) ?? await this.openInteractive(workspace);
    if (session.source !== 'goal') return interactive;
    if (!session.sessionId) throw new Error('INVALID_SESSION_IDENTITY');
    const visibleId = interactive.session?.sessionId;
    if (visibleId && visibleId === session.sessionId) return interactive;
    if (!session.sessionPath) throw new Error('INVALID_SESSION_IDENTITY');
    return this.openGoalWorker(session.sessionId, workspace, session.sessionPath);
  }

  private async preemptGoalTurn(workspace: string, command: string, args: Record<string, unknown>): Promise<void> {
    const interactive = this.options.agentHost.get(workspace);
    if (interactive && (command === 'agent_prompt' || SESSION_REPLACING_COMMANDS.includes(command)) && interactive.currentTurnOrigin === 'goal') {
      await interactive.session.abort();
      await interactive.session.waitForIdle();
    }
    if (!SESSION_REPLACING_COMMANDS.includes(command)) return;
    const target = command === 'agent_switch_session' && typeof args.sessionPath === 'string'
      ? args.sessionPath
      : undefined;
    if (!target) return;
    const held = this.options.goalHost.findBySessionPath(target);
    if (held) await this.options.goalHost.dispose(held.workspace, held.sessionId);
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
    // The Goal extension must distinguish a top-level interactive worker from
    // headless/automatic workers when deciding whether create_goal is allowed.
    // This is injected by the trusted main process, never supplied by tool
    // arguments. Goal workers explicitly receive the non-human value so an
    // inherited environment cannot accidentally grant mutation authority.
    env.PI_HUMAN_ORIGIN_TOKEN = source === 'interactive' ? '1' : '0';
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
    const turnId = readOptionalString(args.turnId) ?? randomUUID();
    if (createThread) await this.options.threadStore!.createThread({ id: threadId, projectId: workspace, workspace, ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    this.workspaceThreads.set(stateKey, threadId);
    const input = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : '';
    this.permissionProfiles.set(stateKey, typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace');
    await this.options.threadStore!.createTurn({ id: turnId, threadId, input, permissionProfile: typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
    const goal = session.source === 'goal'
      ? readGoalTurnMetadata(args)
      : undefined;
    if (session.source === 'goal' && !goal) throw new Error('INVALID_GOAL_TURN');
    const active: ActiveTurn = {
      workspace,
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      source: session.source ?? 'interactive',
      threadId,
      turnId,
      ...(goal ? { goal } : {}),
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

  private async drainQueuedTurn(workspace: string, session: SessionContext): Promise<void> {
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (this.activeTurns.has(stateKey)) return;
    const queue = this.queuedTurns.get(stateKey);
    const next = queue?.shift();
    if (!next) {
      await this.drainGoalTurn(workspace, session.sessionId);
      return;
    }
    if (queue?.length === 0) this.queuedTurns.delete(stateKey);
    try {
      await this.send(workspace, 'agent_follow_up', { message: next.input, permissionProfile: next.permissionProfile, ...session });
    } catch {
      // send() records the failed turn; later enqueued turns remain available for the next terminal event.
    }
  }

  private async dispatchGoalTurn(input: PiGoalTurnRequest): Promise<unknown> {
    return this.send(input.workspace, 'agent_prompt', {
      message: goalPrompt(input.goal.condition),
      permissionProfile: 'automation',
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      source: 'goal',
      turnId: input.turnId,
      goalId: input.goal.goalId,
      goalCondition: input.goal.condition,
      revision: input.goal.revision,
      nextRound: input.goal.nextRound,
      idempotencyKey: input.goal.idempotencyKey,
    });
  }

  private queueGoalTurnFromArgs(workspace: string, session: SessionContext, args: Record<string, unknown>): { status: 'queued'; position: number } {
    const sessionId = session.sessionId;
    const sessionPath = session.sessionPath
      ?? (sessionId ? this.sessionPaths.get(this.sessionKey(workspace, sessionId))?.sessionPath : undefined);
    const goalId = readOptionalString(args.goalId);
    const idempotencyKey = readOptionalString(args.idempotencyKey);
    const turnId = readOptionalString(args.turnId);
    const condition = readOptionalString(args.goalCondition) ?? readOptionalString(args.message);
    const revision = readPositiveInteger(args.revision);
    const nextRound = readPositiveInteger(args.nextRound);
    if (!sessionId || !sessionPath || !goalId || !idempotencyKey || !turnId || !condition || revision === undefined || nextRound === undefined) {
      throw new Error('INVALID_GOAL_TURN');
    }
    const turnKey = this.goalTurnKey(workspace, sessionId, idempotencyKey);
    const prior = this.goalTurnKeys.get(turnKey);
    if (prior && prior !== turnId) throw new Error('GOAL_TURN_IDEMPOTENCY_CONFLICT');
    const stateKey = this.sessionKey(workspace, sessionId);
    const queue = this.queuedGoalTurns.get(stateKey) ?? [];
    const existing = queue.find((item) => item.goal.idempotencyKey === idempotencyKey);
    if (existing) return { status: 'queued', position: queue.indexOf(existing) + 1 };
    this.goalTurnKeys.set(turnKey, turnId);
    queue.push({ workspace, sessionId, sessionPath, turnId, goal: { goalId, revision, nextRound, idempotencyKey, condition } });
    this.queuedGoalTurns.set(stateKey, queue);
    return { status: 'queued', position: queue.length };
  }

  private async drainGoalTurn(workspace: string, sessionId?: string): Promise<void> {
    const stateKey = this.sessionKey(workspace, sessionId);
    if (this.activeTurns.has(stateKey)) return;
    const queue = this.queuedGoalTurns.get(stateKey);
    const next = queue?.shift();
    if (!next) return;
    if (queue?.length === 0) this.queuedGoalTurns.delete(stateKey);
    try {
      await this.dispatchGoalTurn(next);
      // A concurrent interactive turn may have won the lease while the goal
      // worker was opening. In that case send() re-queued this request.
      const stillQueued = this.queuedGoalTurns.get(stateKey)?.some((item) => item.goal.idempotencyKey === next.goal.idempotencyKey);
      if (!stillQueued && !this.activeTurns.has(stateKey)) this.goalTurnKeys.delete(this.goalTurnKey(workspace, sessionId, next.goal.idempotencyKey));
    } catch (error) {
      this.goalTurnKeys.delete(this.goalTurnKey(workspace, sessionId, next.goal.idempotencyKey));
      try {
        await this.options.onTurnSettled?.({
          workspace,
          ...(sessionId ? { sessionId } : {}),
          ...(next.sessionPath ? { sessionPath: next.sessionPath } : {}),
          turnId: next.turnId,
          status: 'failed',
          summary: error instanceof Error ? error.message : String(error),
          goal: { ...next.goal },
        });
      } finally {
        // Keep draining automatic turns even when the failure callback itself
        // rejects. A terminal dispatch error must not strand later queue items.
        await this.drainGoalTurn(workspace, sessionId).catch(() => {});
      }
    }
  }

  private sessionKey(workspace: string, sessionId?: string): string { return `${workspace}\0${sessionId ?? ''}`; }

  private goalTurnKey(workspace: string, sessionId: string | undefined, idempotencyKey: string): string {
    return `${this.sessionKey(workspace, sessionId)}\0${idempotencyKey}`;
  }

  private resolveGoalStateKey(sessionId: string, workspace?: string): string | undefined {
    if (workspace !== undefined) return this.sessionKey(workspace, sessionId);
    const suffix = `\0${sessionId}`;
    const matches = new Set<string>();
    for (const key of this.goalWorkers.keys()) if (key.endsWith(suffix)) matches.add(key);
    for (const key of this.sessionPaths.keys()) if (key.endsWith(suffix)) matches.add(key);
    if (matches.size > 1) throw new Error('AMBIGUOUS_GOAL_SESSION');
    return matches.values().next().value as string | undefined;
  }

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

  private async resolveSession(workspace: string, args: Record<string, unknown>, options?: { deferInteractiveBinding?: boolean }): Promise<SessionContext> {
    const suppliedId = readOptionalString(args.sessionId);
    const suppliedPath = readOptionalString(args.sessionPath);
    const current = this.currentSessionByWorkspace.get(workspace);
    // A Goal command must name its own session. Inheriting the visible session
    // identity would route headless work into the session the user is reading.
    const isGoal = args.source === 'goal';
    const boundPath = isGoal && suppliedId ? this.sessionPaths.get(this.sessionKey(workspace, suppliedId))?.sessionPath : undefined;
    const session: SessionContext = {
      sessionId: suppliedId ?? (suppliedPath || isGoal ? undefined : current?.sessionId),
      sessionPath: suppliedPath ?? (isGoal ? boundPath : current?.sessionPath),
      source: isGoal ? 'goal' : current?.source,
    };
    if (session.sessionPath) {
      const identity = await readSessionIdentity(session.sessionPath, workspace);
      if (session.sessionId && identity.sessionId !== session.sessionId) throw new Error('SESSION_ID_MISMATCH');
      session.sessionId = identity.sessionId;
      session.sessionPath = identity.sessionPath;
      const interactive = { ...session, source: 'interactive' as const };
      if (options?.deferInteractiveBinding) Object.assign(session, interactive);
      else if (session.source !== 'goal') await this.replaceCurrentSession(workspace, interactive);
      else await this.bindSession(workspace, session);
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

  private async refreshCurrentSession(workspace: string, ops: SessionOps, migrateLegacy = true): Promise<SessionContext | undefined> {
    const state = await ops.getState();
    const identity = await this.readCurrentIdentity(workspace, typeof state.sessionFile === 'string' ? state.sessionFile : null, typeof state.sessionId === 'string' ? state.sessionId : undefined);
    if (identity) {
      await this.replaceCurrentSession(workspace, identity, migrateLegacy);
      if (identity.sessionId) ops.setSessionIdentity?.(identity.sessionId, identity.sessionPath);
    }
    return identity;
  }

  /** Used by AgentData project authorization for the currently open session. */
  async ownsSession(workspace: string, sessionId: string): Promise<boolean> {
    return this.currentSessionByWorkspace.get(workspace)?.sessionId === sessionId
      || this.options.goalHost.get(workspace, sessionId) !== undefined
      || this.goalWorkers.get(this.sessionKey(workspace, sessionId)) === workspace;
  }

  private async bindSession(workspace: string, identity: SessionContext): Promise<void> {
    if (identity.sessionId) {
      await this.options.bindGoalSession?.(workspace, identity.sessionId, identity.source === 'goal' ? 'goal' : 'interactive');
      if (identity.sessionPath) this.sessionPaths.set(this.sessionKey(workspace, identity.sessionId), { workspace, sessionPath: identity.sessionPath });
    }
  }

  private async replaceCurrentSession(workspace: string, identity: SessionContext, migrateLegacy = true): Promise<void> {
    const previous = this.currentSessionByWorkspace.get(workspace);
    const switching = previous?.sessionId !== identity.sessionId;
    const nextKey = this.sessionKey(workspace, identity.sessionId);
    const previousNextPath = this.sessionPaths.get(nextKey);
    try {
      await this.bindSession(workspace, identity);
      if (previous?.sessionId && switching && this.goalWorkers.get(this.sessionKey(workspace, previous.sessionId)) !== workspace) {
        await this.options.unbindGoalSession?.(workspace, previous.sessionId);
      }
    } catch (error) {
      if (identity.sessionId && switching && this.goalWorkers.get(nextKey) !== workspace) {
        try { await this.options.unbindGoalSession?.(workspace, identity.sessionId); } catch { /* preserve the original switch error */ }
      }
      if (previousNextPath) this.sessionPaths.set(nextKey, previousNextPath);
      else this.sessionPaths.delete(nextKey);
      throw error;
    }
    this.currentSessionByWorkspace.set(workspace, identity);
    const forkReady = identity.sessionId ? await this.retryPendingSessionFork(workspace, identity.sessionId) : true;
    if (migrateLegacy && forkReady) await this.migrateLegacyGoal(workspace, identity);
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

  private async migrateLegacyGoal(workspace: string, identity: SessionContext): Promise<void> {
    const sessionId = identity.sessionId;
    const sessionPath = identity.sessionPath;
    const migrate = this.options.migrateLegacyGoal;
    if (!sessionId || !sessionPath || !migrate) return;
    const key = this.sessionKey(workspace, sessionId);
    if (this.legacyMigrationKeys.has(key)) return;
    while (true) {
      if (this.legacyMigrationKeys.has(key)) return;
      const running = this.legacyMigrationInFlight.get(key);
      if (!running) break;
      await running;
    }
    const task = (async () => {
      try {
        const result = await readLegacyGoalEntry(sessionPath);
        if (!result.stable) return;
        if (result.goal) await migrate({ workspace, sessionId, sessionPath, ...result.goal });
        // A confirmed missing legacy entry is a successful no-op. If the
        // session file is unavailable or still being written, leave the key
        // unset so a later refresh can retry it.
        this.legacyMigrationKeys.add(key);
      } catch {
        // Legacy recovery is best effort and must not prevent opening a session.
      }
    })();
    this.legacyMigrationInFlight.set(key, task);
    try {
      await task;
    } finally {
      if (this.legacyMigrationInFlight.get(key) === task) this.legacyMigrationInFlight.delete(key);
    }
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

/** Commands that replace or branch the visible session; never available to a Goal worker. */
const SESSION_REPLACING_COMMANDS = ['agent_switch_session', 'agent_new_session', 'agent_fork', 'agent_clone', 'agent_rewind_to'];

function sessionIdFromStateKey(key: string): string {
  const separator = key.indexOf('\0');
  return separator < 0 ? key : key.slice(separator + 1);
}

function readGoalTurnMetadata(args: Record<string, unknown>): ActiveTurn['goal'] | undefined {
  const goalId = readOptionalString(args.goalId);
  const idempotencyKey = readOptionalString(args.idempotencyKey);
  const revision = readPositiveInteger(args.revision);
  const nextRound = readPositiveInteger(args.nextRound);
  if (!goalId || !idempotencyKey || revision === undefined || nextRound === undefined) return undefined;
  return { goalId, revision, nextRound, idempotencyKey };
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function goalPrompt(condition: string): string {
  return [
    'Continue working toward the active session goal.',
    'Inspect the current repository state, make the next concrete safe change, and verify it.',
    `Goal condition: ${condition}`,
    'Do not declare completion unless the condition is actually satisfied. If blocked, explain the exact blocker and what evidence would unblock it.',
  ].join('\n');
}

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
    ?? (event.type === 'turn.completed' ? 'Goal turn completed without an assistant summary.' : `Goal turn ${event.type.replace('turn.', '')}.`);
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

function normalizeSessionPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function stripSessionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, sessionPath: _sessionPath, source: _source, goalId: _goalId, goalCondition: _goalCondition, revision: _revision, nextRound: _nextRound, idempotencyKey: _idempotencyKey, turnId: _turnId, ...rpcArgs } = args;
  return rpcArgs;
}

interface LegacyGoalEntry {
  condition: string;
  react: number;
  paused: boolean;
  legacyEntryTimestamp?: string | number;
}

interface LegacyGoalReadResult {
  stable: boolean;
  goal?: LegacyGoalEntry;
}

async function readLegacyGoalEntry(sessionFile: string): Promise<LegacyGoalReadResult> {
  let text: string;
  try { text = await readFile(sessionFile, 'utf8'); } catch { return { stable: false }; }
  const lines = text.split(/\r?\n/);
  let lastNonEmptyLine = -1;
  for (let index = 0; index < lines.length; index += 1) if (lines[index].trim()) lastNonEmptyLine = index;
  if (lastNonEmptyLine < 0) return { stable: false };
  const entries: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      // A malformed final line is usually a partially written session entry;
      // retry after Pi has finished appending it. Older malformed lines can be
      // ignored without blocking recovery of a later valid branch.
      if (index === lastNonEmptyLine) return { stable: false };
    }
  }
  if (!entries.length) return { stable: false };
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) if (typeof entry.id === 'string' && entry.id) byId.set(entry.id, entry);
  const leaf = [...entries].reverse().find((entry) => entry.type !== 'session' && typeof entry.id === 'string' && entry.id);
  const branchIds = new Set<string>();
  if (leaf && typeof leaf.id === 'string') {
    let current: Record<string, unknown> | undefined = leaf;
    while (current && typeof current.id === 'string' && !branchIds.has(current.id)) {
      branchIds.add(current.id);
      current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
    }
  }
  const candidateEntries = branchIds.size
    ? entries.filter((entry) => typeof entry.id !== 'string' || branchIds.has(entry.id))
    : entries;
  let latest: LegacyGoalEntry | undefined;
  for (const parsed of candidateEntries) {
    if (parsed.type !== 'custom' || parsed.customType !== 'goal') continue;
    let data: unknown = parsed.data;
    // A few early sidecars serialized custom data in `content`; accept that
    // shape without treating arbitrary display text as a Goal.
    if (data === undefined && typeof parsed.content === 'string') {
      try { data = JSON.parse(parsed.content); } catch { data = undefined; }
    }
    if (!isRecord(data) || typeof data.goalId === 'string' || isRecord(data.snapshot)) {
      latest = undefined;
      continue;
    }
    const condition = typeof data.condition === 'string' ? data.condition.trim() : '';
    if (!condition) { latest = undefined; continue; }
    const reactValue = Number(data.react);
    const react = Number.isSafeInteger(reactValue) && reactValue >= 0 ? reactValue : 0;
    const timestamp = parsed.timestamp;
    latest = {
      condition,
      react,
      paused: data.paused === true,
      ...(typeof timestamp === 'string' && timestamp ? { legacyEntryTimestamp: timestamp } : {}),
      ...(typeof timestamp === 'number' && Number.isSafeInteger(timestamp) ? { legacyEntryTimestamp: timestamp } : {}),
    };
  }
  return { stable: true, ...(latest ? { goal: latest } : {}) };
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
