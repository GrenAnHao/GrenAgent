import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { SessionManager, type AgentSession, type PromptOptions } from '../../../cli/src/pi-sdk.js';
import { snapshotSessionModel, type WorkspaceHandle } from '../agent/workspaceHandle.js';
import type { SessionEventMeta } from '../pi/eventAdapter';
import type { Thread, Turn } from './appServer/types';
import type { PermissionAuthorization, PermissionManager, PermissionProfileName } from './permissionManager';
import { adaptPiEvent, type PiProjection } from '../pi/eventAdapter';
import { isSessionWorkspaceMismatch, readSessionIdentity } from './sessionIdentity';
import { parseApproval, setApprovalPolicy, type ApprovalPolicy } from '../../../extensions/_shared/approval.js';
import { getAgentMode, isAgentMode, setAgentMode } from '../../../extensions/agent-mode/modes.js';
import { PLAN_UNCONFIRMED_MESSAGE, planBlocksModeSwitch } from '../../../extensions/agent-mode/planState.js';
import { buildGoalStatus, type GoalStatusEnvelope } from '../../../extensions/goal/status.js';
import { agentModeConfigKey, approvalPolicyConfigKey, contextExclusionConfigKey, mergeRuntimeSettingsFile } from './settingsService';
import { truncateSessionLines, type TruncateMode } from './truncateSession.js';
import { messagesWithEntryIds, type SessionProjectionLike } from './messagesWithEntryIds.js';
import { deleteAskUserDraft, readAskUserDraft, writeAskUserDraft, type AskUserDraft } from '../agent/askUserDraft.js';
import { completeAskUser, finishCompleteAskUser } from '../agent/completeAskUser.js';
import { withEstimatedContextUsage } from './contextUsageEstimate.js';
import { cancelQueuedSteer } from './cancelQueuedSteer.js';
import { syncSessionFromDisk, type SessionFileSync } from './syncSessionFromDisk.js';

type PiCommand = keyof typeof commandTypes;
type ImageContent = NonNullable<PromptOptions['images']>[number];

const commandTypes = {
  agent_prompt: 'prompt',
  agent_steer: 'steer',
  agent_follow_up: 'follow_up',
  agent_abort: 'abort',
  agent_take_steering: 'abort',
  agent_cancel_steer: 'abort',
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
  agent_get_goal: 'get_state',
  agent_get_commands: 'get_commands',
  agent_new_session: 'new_session',
  agent_switch_session: 'switch_session',
  agent_fork: 'fork',
  agent_clone: 'clone',
  agent_get_fork_messages: 'get_fork_messages',
  agent_set_session_name: 'set_session_name',
  ask_user_draft_read: 'prompt',
  ask_user_draft_write: 'prompt',
  ask_user_draft_delete: 'prompt',
  agent_complete_ask_user: 'prompt',
} as const;

export interface AgentHostPort {
  open(workspace: string, cwd: string): Promise<WorkspaceHandlePort>;
  get(workspace: string): WorkspaceHandlePort | undefined;
  close(workspace: string): Promise<void>;
  workspaces?(): string[];
  /** 同一项目里同时活着的 handle。没有时退回 get。 */
  list?(workspace: string): WorkspaceHandlePort[];
  /** 再开一个 handle，不替换当前前景。 */
  openAdditional?(workspace: string, cwd: string): Promise<WorkspaceHandlePort>;
  focus?(workspace: string, handle: WorkspaceHandlePort): void;
  /** 只拆这一个 handle；前景是它时落到剩下的那个。 */
  evict?(workspace: string, handle: WorkspaceHandlePort): Promise<void>;
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

/** 返回值不用：agent-host 子进程里经 RPC 交给主进程的 AgentData 写库。 */
interface ThreadStorePort {
  createThread(input: { id: string; projectId: string; workspace: string; title?: string; sessionId?: string }): Promise<Thread | unknown> | Thread;
  createTurn(input: { id: string; threadId: string; input: string; permissionProfile: string; mode?: Turn['mode']; sessionId?: string }): Promise<Turn | unknown> | Turn;
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn | unknown> | Turn;
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
  /** agent-host 子进程里向主进程要；主进程的 AgentData 才发得出令牌。 */
  agentDataEndpoint?: (workspace: string) => string | undefined | Promise<string | undefined>;
  /**
   * 合并写 runtime-settings.json。主进程的 SettingsService 也写这份文件，锁只在主进程里，
   * 子进程必须交给主进程写。不传时在本进程内直接合并（单进程测试）。
   */
  mergeRuntimeSettings?: (patch: Record<string, string>) => Promise<void>;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  resolveEnv?: (workspace: string) => Promise<Record<string, string>>;
  threadStore?: ThreadStorePort;
  onEvent?: (event: PiRuntimeEventEnvelope) => void;
  onTurnSettled?: (result: PiTurnSettledResult) => void | Promise<void>;
  onSessionForked?: (input: { workspace: string; sourceSessionId: string; targetSessionId: string }) => void | Promise<void>;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  mcpConfig?: McpConfigPort;
  allowedPluginIds?: () => string[] | Promise<string[]>;
  /**
   * 这个会话名下是否还有存活的后台任务。任务属于启动它的会话（owner = sessionId），
   * 会话被销毁（换走、拆掉停靠的 handle）时 jobs 扩展会把它的任务一并取消，
   * 所以有存活任务的会话换走时要停靠，停靠期间也不能被当成空闲拆掉。
   */
  hasLiveJobs?: (sessionId: string) => boolean;
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

  /**
   * 渲染进程热更新后内存里的 isStreaming 会丢。这里把主进程仍在跑的交互回合交回去，
   * 供界面加载完重新点亮停止按钮和侧边栏运行态。
   */
  listRunningTurns(): Array<{ workspace: string; sessionId?: string; sessionPath?: string }> {
    const rows: Array<{ workspace: string; sessionId?: string; sessionPath?: string }> = [];
    const covered = new Set<string>();
    for (const workspace of this.options.agentHost.workspaces?.() ?? []) {
      for (const handle of this.handlesOf(workspace)) {
        const session = handle.session;
        if (!session?.isStreaming) continue;
        const sessionId = typeof session.sessionId === 'string' ? session.sessionId : undefined;
        const sessionPath = typeof session.sessionFile === 'string' ? session.sessionFile : undefined;
        covered.add(this.sessionKey(workspace, sessionId));
        rows.push({
          workspace,
          ...(sessionId ? { sessionId } : {}),
          ...(sessionPath ? { sessionPath } : {}),
        });
      }
    }
    for (const active of this.activeTurns.values()) {
      if (active.source !== 'interactive') continue;
      const key = this.sessionKey(active.workspace, active.sessionId);
      if (covered.has(key)) continue;
      covered.add(key);
      rows.push({
        workspace: active.workspace,
        ...(active.sessionId ? { sessionId: active.sessionId } : {}),
        ...(active.sessionPath ? { sessionPath: active.sessionPath } : {}),
      });
    }
    return rows;
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

  /**
   * 删会话前把它从运行时摘下。SDK 的会话一旦落盘就逐条 appendFileSync：文件删了、会话还挂在 handle 上
   * （尤其还在跑），后面的条目会把同一路径重建成无头文件，侧栏按路径推断 cwd 照样列出来，重启后会话又回来。
   * 停在后台的 handle 直接拆掉；前景是它就在同一个 handle 上换成新的空会话（渲染层删当前会话后按 getState 取这份）。
   * 换会话被扩展取消时抛错：调用方不能接着删掉还挂在 handle 上的文件。
   */
  async releaseSessions(sessionPaths: readonly string[]): Promise<void> {
    const wanted = sessionPaths.filter((path) => typeof path === 'string' && path.length > 0);
    if (wanted.length === 0) return;
    for (const workspace of this.options.agentHost.workspaces?.() ?? []) {
      for (const handle of this.handlesOf(workspace)) {
        const file = sessionFileOf(handle);
        if (!file || !wanted.some((path) => sameSessionPath(file, path))) continue;
        await this.releaseHandleSession(workspace, handle);
      }
    }
  }

  private async releaseHandleSession(workspace: string, handle: WorkspaceHandlePort): Promise<void> {
    const { sessionId } = this.contextOf(handle);
    const stateKey = this.sessionKey(workspace, sessionId);
    // 先清排队：回合结算时 drainQueuedTurn 会把下一条再发回这份会话。
    this.queuedTurns.delete(stateKey);
    try { handle.session.clearQueue(); } catch { /* 会话已经拆了 */ }
    const active = this.activeTurns.get(stateKey);
    const host = this.options.agentHost;
    if (host.evict && handle !== host.get(workspace)) {
      // dispose 会先取消挂起的询问再 abort，然后 session_shutdown（后台任务、子代理跟着收口）。
      await host.evict.call(host, workspace, handle);
    } else {
      // 不走 send('agent_new_session')：忙的前景会被停靠、有后台任务的也会被停靠，而这里就是要拆掉它。
      // newSession 自己会先 abort 在跑的回合。
      const result = await handle.newSession();
      if (isCancelledResult(result)) throw new Error('SESSION_RELEASE_CANCELLED');
      await this.refreshCurrentSession(workspace, this.handleOps(handle));
    }
    // 回合结算事件可能在拆除后才到，也可能随 handle 一起丢了。这里收尾，
    // 否则 listRunningTurns 仍把它当成在跑，渲染层重载后侧栏又亮起来。
    if (active && this.activeTurns.get(stateKey) === active) {
      this.activeTurns.delete(stateKey);
      try {
        await this.options.threadStore?.updateTurn(active.turnId, { status: 'cancelled', completedAt: Date.now() });
      } catch {
        /* 回合记录写失败不阻断删除 */
      }
    }
    this.queuedTurns.delete(stateKey);
    this.assistantItems.delete(stateKey);
    this.workspaceThreads.delete(stateKey);
    this.permissionProfiles.delete(stateKey);
  }

  async send(workspace: string, command: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    // targetSessionPath 只是路由提示：渲染层说明这条命令属于哪份会话。它不参与 resolveSession，
    // 否则会把 currentSessionByWorkspace 改成后台那份。
    const targetPath = readOptionalString(rawArgs.targetSessionPath);
    const { targetSessionPath: _targetSessionPath, ...args } = rawArgs;
    const authorization = await this.authorize(workspace, command, args);
    if (authorization.status === 'denied') throw new Error(`Pi operation denied: ${command}`);
    if (authorization.status === 'blocked') return authorization;
    if (command === 'agent_set_mode') {
      return this.writeAgentMode(workspace, args.mode, targetPath);
    }
    if (command === 'agent_set_approval') {
      return this.writeApprovalPolicy(workspace, args.level, targetPath);
    }
    if (command === 'agent_exclude_entry' || command === 'agent_restore_entry') {
      return this.writeContextExclusion(workspace, command === 'agent_exclude_entry' ? 'add' : 'remove', args.timestamp);
    }
    if (command === 'agent_get_goal') {
      return this.readGoalStatus(workspace, targetPath);
    }
    if (targetPath && ROUTED_COMMANDS.has(command)) {
      const owner = this.handleOwningPath(workspace, targetPath);
      if (owner && owner !== this.options.agentHost.get(workspace)) {
        return this.sendRouted(workspace, owner, command, args);
      }
      if (!owner) {
        // 目标会话已经不在任何 handle 上：停止 / 取引导没有可作用的回合，不能落到别的会话。
        if (command === 'agent_abort') return undefined;
        if (command === 'agent_take_steering') return { steering: [] };
        if (command === 'agent_cancel_steer') return { cancelled: false };
        // 要快照的会话已经不在 handle 上（后台跑完被拆了）：读它自己的会话文件，不能拿前景那份顶替。
        if (command === 'agent_get_messages') return this.readDetachedMessages(workspace, targetPath);
        if (PROMPT_COMMANDS.has(command)) {
          const switched = await this.send(workspace, 'agent_switch_session', { sessionPath: targetPath });
          if (isCancelledResult(switched)) throw new Error('SESSION_SWITCH_CANCELLED');
        }
      }
    }
    if (command === 'agent_switch_session') {
      const focused = await this.focusExistingSession(workspace, args);
      if (focused) return focused;
    }
    if (SESSION_REPLACING_COMMANDS.includes(command)) {
      // 换会话 / 新建可以停靠正在跑的 handle，再开一个。fork / rewind 会改正在跑的那份，仍然拒绝。
      const canPark = command === 'agent_switch_session' || command === 'agent_new_session';
      if (this.foregroundIsBusy(workspace)) {
        if (!canPark || !await this.parkForeground(workspace)) throw new Error('SESSION_BUSY');
      } else if (canPark && this.foregroundOwnsLiveJobs(workspace)) {
        // 回合已经结束、只剩后台任务在跑的会话：原地替换会触发 session_shutdown，把任务一并取消。
        // 停靠失败（宿主不支持）时退回原地替换，不能因为这个拒绝用户切会话。
        await this.parkForeground(workspace);
      }
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
    if (command === 'ask_user_draft_read' || command === 'ask_user_draft_write' || command === 'ask_user_draft_delete') {
      const sessionFile = handle.session.sessionFile;
      if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('ask_user draft requires a session file');
      if (command === 'ask_user_draft_read') {
        const toolCallId = args.toolCallId;
        if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('toolCallId must be a non-empty string');
        return readAskUserDraft(sessionFile, toolCallId);
      }
      if (command === 'ask_user_draft_write') {
        const draft = args.draft;
        if (!draft || typeof draft !== 'object' || typeof (draft as AskUserDraft).toolCallId !== 'string') {
          throw new Error('draft must be an object with a string toolCallId');
        }
        return writeAskUserDraft(sessionFile, draft as AskUserDraft);
      }
      return deleteAskUserDraft(sessionFile);
    }
    if (command === 'agent_complete_ask_user') {
      const toolCallId = args.toolCallId;
      if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('toolCallId must be a non-empty string');
      // 界面重载后卡片走补写，但原回合可能还堵在 ctx.ui.input 上。这时把答案交回那次请求，
      // 不能再 append 一条工具结果。
      if (handle.session.isStreaming) {
        const requestId = handle.ui.pendingAskUserRequestId();
        if (!requestId) throw new Error('ask_user completion requires an idle session');
        handle.ui.respond(requestId, {
          ...(args.cancelled === true ? { cancelled: true } : {}),
          ...(typeof args.value === 'string' ? { value: args.value } : {}),
        });
        const sessionFile = handle.session.sessionFile;
        if (typeof sessionFile === 'string' && sessionFile) {
          return finishCompleteAskUser('ok', () => deleteAskUserDraft(sessionFile));
        }
        return 'ok';
      }
      const result = await completeAskUser(handle.session, {
        toolCallId,
        value: typeof args.value === 'string' ? args.value : undefined,
        cancelled: args.cancelled === true,
      });
      const sessionFile = handle.session.sessionFile;
      if (typeof sessionFile === 'string' && sessionFile) {
        return finishCompleteAskUser(result, () => deleteAskUserDraft(sessionFile));
      }
      return result;
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

  /**
   * 命令属于停在后台的那份会话：直接打到它的 handle，前景和 currentSessionByWorkspace 都不动。
   * 回合登记按这份会话自己的 sessionId，事件回来时才对得上。
   */
  private async sendRouted(workspace: string, handle: WorkspaceHandlePort, command: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.contextOf(handle);
    const stateKey = this.sessionKey(workspace, session.sessionId);
    const rpcArgs = stripSessionArgs(args);
    if (command === 'agent_prompt' && shouldFlushFollowUp(args, this.activeTurns.has(stateKey))) {
      return this.flushFollowUpOn(workspace, handle, session);
    }
    if (command === 'agent_prompt' && shouldEnqueuePrompt(args, this.activeTurns.has(stateKey), this.queuedTurns.get(stateKey)?.length ?? 0)) {
      return this.enqueueTurn(workspace, readInput(args), typeof args.permissionProfile === 'string' ? args.permissionProfile : 'workspace', session);
    }
    if (command === 'agent_get_state') return this.ownedState(workspace, handle.getState());
    const adapter = this.options.threadStore && shouldTrackTurn(command, args)
      ? await this.prepareTurn(workspace, command, args, session)
      : undefined;
    try {
      return await this.runOnHandle(handle, command as PiCommand, rpcArgs, 'main');
    } catch (error) {
      if (adapter && command === 'agent_prompt') {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.threadStore!.updateTurn(adapter.turnId, { status: 'failed', completedAt: Date.now(), error: message });
        this.emitRuntimeEvent(workspace, session, { type: 'turn.failed', error: message });
        this.activeTurns.delete(stateKey);
      }
      throw error;
    }
  }

  /**
   * 按会话路径读 Goal 投影，和扩展 setStatus("goal") 推的是同一种信封。
   * 会话在 handle 上就读内存里的条目（含还没落盘的那几条）；不在就读会话文件。
   * 不起 handle、不触发 session_start，也不进回合队列：会话跑着也能立刻读。
   */
  private async readGoalStatus(workspace: string, sessionPath: string | undefined): Promise<GoalStatusEnvelope | null> {
    if (!sessionPath) return null;
    const owner = this.handleOwningPath(workspace, sessionPath);
    if (owner) {
      const sessionId = owner.session.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) return null;
      return buildGoalStatus({ entries: owner.session.sessionManager.getEntries(), sessionId });
    }
    const identity = await readSessionIdentity(sessionPath, workspace);
    if (!existsSync(identity.sessionPath)) return null;
    const manager = SessionManager.open(identity.sessionPath);
    return buildGoalStatus({ entries: manager.getEntries(), sessionId: manager.getSessionId() || identity.sessionId });
  }

  /** 只读地投影一份不在任何 handle 上的会话。路径必须属于这个项目。 */
  private async readDetachedMessages(workspace: string, sessionPath: string): Promise<{ messages: unknown[] }> {
    const identity = await readSessionIdentity(sessionPath, workspace);
    if (!existsSync(identity.sessionPath)) return { messages: [] };
    const manager = SessionManager.open(identity.sessionPath);
    return { messages: messagesWithEntryIds(manager.buildSessionProjection() as unknown as SessionProjectionLike) };
  }

  private contextOf(handle: WorkspaceHandlePort): SessionContext {
    const sessionId = typeof handle.session.sessionId === 'string' && handle.session.sessionId ? handle.session.sessionId : undefined;
    const sessionPath = sessionFileOf(handle);
    return { ...(sessionId ? { sessionId } : {}), ...(sessionPath ? { sessionPath } : {}), source: 'interactive' };
  }

  private handleOwningPath(workspace: string, sessionPath: string): WorkspaceHandlePort | undefined {
    return this.handlesOf(workspace).find((handle) => {
      const file = sessionFileOf(handle);
      return Boolean(file && sameSessionPath(file, sessionPath));
    });
  }

  /** 按会话身份找停在后台的 handle；前景或找不到时返回 undefined，走原来的前景路径。 */
  private parkedHandleFor(workspace: string, session: SessionContext): WorkspaceHandlePort | undefined {
    const foreground = this.options.agentHost.get(workspace);
    const owner = this.handlesOf(workspace).find((handle) => {
      if (session.sessionPath) {
        const file = sessionFileOf(handle);
        if (file && sameSessionPath(file, session.sessionPath)) return true;
      }
      return Boolean(session.sessionId && handle.session.sessionId === session.sessionId);
    });
    return owner && owner !== foreground ? owner : undefined;
  }

  /** 停在后台的会话跑完、没有排队也没有等待中的询问时拆掉它。前景和最后一个 handle 永远保留。 */
  private async releaseIdleParked(workspace: string, session: SessionContext): Promise<void> {
    const evict = this.options.agentHost.evict;
    if (!evict) return;
    const handle = this.parkedHandleFor(workspace, session);
    if (!handle || this.handlesOf(workspace).length < 2) return;
    try { await handle.session.waitForIdle?.(); } catch { return; }
    const stateKey = this.sessionKey(workspace, session.sessionId);
    if (handle === this.options.agentHost.get(workspace)) return;
    if (!this.handlesOf(workspace).includes(handle) || this.handlesOf(workspace).length < 2) return;
    if (handle.session.isStreaming || this.activeTurns.has(stateKey)) return;
    if ((this.queuedTurns.get(stateKey)?.length ?? 0) > 0) return;
    if ((handle.session.getFollowUpMessages?.() ?? []).length > 0) return;
    const ui = handle.ui as { hasAnyPending?: () => boolean };
    if (ui.hasAnyPending?.()) return;
    // 后台任务还在跑：任务跟着这个会话，拆掉 handle 会把它们取消。任务结算后会话被叫醒，跑完那一轮会再走到这里。
    if (this.ownsLiveJobs(handle)) return;
    await evict.call(this.options.agentHost, workspace, handle);
  }

  async handlePiEvent(workspace: string, raw: Record<string, unknown>, sessionOrMetadata?: EventMeta, source?: 'interactive' | 'goal' | 'subagent'): Promise<void> {
    const eventSessionId = typeof sessionOrMetadata === 'string' ? sessionOrMetadata : sessionOrMetadata?.sessionId ?? readOptionalString(raw.sessionId);
    const eventSource = source ?? (typeof sessionOrMetadata === 'object' ? sessionOrMetadata?.source : undefined);
    if (eventSource === 'subagent') return;
    const stateKey = this.findEventKey(workspace, eventSessionId);
    if (!stateKey) {
      // 没有登记回合（未接 threadStore 或斜杠命令）时，后台会话跑完也要释放它的 handle。
      if (raw.type === 'agent_end' && raw.willRetry !== true && eventSource !== 'goal') {
        const eventPath = typeof sessionOrMetadata === 'object' ? sessionOrMetadata?.sessionPath : undefined;
        void this.releaseIdleParked(workspace, {
          ...(eventSessionId ? { sessionId: eventSessionId } : {}),
          ...(eventPath ? { sessionPath: eventPath } : {}),
        }).catch(() => {});
      }
      return;
    }
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
        await this.releaseIdleParked(workspace, session).catch(() => {});
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
    const requestId = readOptionalString(response.id) ?? '';
    this.uiOwner(workspace, requestId)?.ui.respond(requestId, response);
  }

  async rejectUiRequest(workspace: string, _metadata: EventMeta | undefined, requestId: string): Promise<void> {
    if (!requestId.trim()) return;
    this.uiOwner(workspace, requestId)?.ui.respond(requestId, { cancelled: true });
  }

  /** 哪个 handle 挂着这条 UI 请求。后台会话的确认 / 询问要回到它自己那份，找不到再落前景。 */
  private uiOwner(workspace: string, requestId: string): WorkspaceHandlePort | undefined {
    const handles = this.handlesOf(workspace);
    const match = requestId ? handles.find((handle) => {
      const ui = handle.ui as { hasPending?: (id: string) => boolean; pendingAskUserRequestId?: () => string | undefined };
      if (typeof ui.hasPending === 'function') return ui.hasPending(requestId);
      return typeof ui.pendingAskUserRequestId === 'function' && ui.pendingAskUserRequestId() === requestId;
    }) : undefined;
    return match ?? this.options.agentHost.get(workspace) ?? handles[0];
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
        // 停在后台的会话也要换上新快照，否则切回去还拿着旧的模型引用。
        for (const handle of this.handlesOf(workspace)) await refreshHandleModel(handle);
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
    if (!this.options.mergeRuntimeSettings && !this.options.runtimeConfigPath) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    this.exclusionPulseRev = Math.max(Date.now(), this.exclusionPulseRev + 1);
    const pulse = JSON.stringify({ op, ts: timestamp, rev: this.exclusionPulseRev });
    await this.mergeRuntimeSettings({
      [contextExclusionConfigKey(workspace)]: pulse,
      [contextExclusionConfigKey(resolved)]: pulse,
    });
    return { ok: true, op, timestamp };
  }

  /**
   * 模式 / 审批档按会话生效：带 targetSessionPath 时钉到那份会话（内存 + 会话条目），别的会话不动。
   * 项目默认照旧写内存与盘（最近一次选择），只给草稿和之后新建的会话继承；已打开的会话各自钉住不跟。
   */
  private pinSessionControl(workspace: string, targetPath: string | undefined, patch: { mode?: string; approval?: string }): void {
    if (!targetPath) return;
    const handle = this.handleOwningPath(workspace, targetPath);
    const sessionId = typeof handle?.session.sessionId === 'string' ? handle.session.sessionId : '';
    if (!handle || !sessionId) return;
    if (patch.mode && isAgentMode(patch.mode)) setAgentMode(patch.mode, workspace, sessionId);
    const approval = patch.approval ? parseApproval(patch.approval) : undefined;
    if (approval) setApprovalPolicy(approval, workspace, sessionId);
    try {
      handle.session.sessionManager?.appendCustomEntry?.('session-controls', patch);
    } catch {
      /* 内存已钉住；落条目失败只影响重启后的回读 */
    }
    if (patch.mode) handle.ui.context.setStatus('agent-mode', patch.mode);
    if (approval) handle.ui.context.setStatus('approval-policy', approval);
  }

  private async writeAgentMode(
    workspace: string,
    rawMode: unknown,
    targetPath?: string,
  ): Promise<{ ok: true; mode: string } | { ok: false; blocked: 'PLAN_UNCONFIRMED'; mode: string; message: string }> {
    const mode = String(rawMode ?? '').trim().toLowerCase();
    if (!isAgentMode(mode)) throw new Error('INVALID_AGENT_MODE');
    // 未确认的计划只能经侧栏「确认执行」进入执行：手切到能动手的模式直接取消，不动内存、不落盘。
    const owner = targetPath ? this.handleOwningPath(workspace, targetPath) : this.options.agentHost.get(workspace);
    const ownerSessionId = typeof owner?.session.sessionId === 'string' ? owner.session.sessionId : undefined;
    if (planBlocksModeSwitch(ownerSessionId, mode)) {
      return { ok: false, blocked: 'PLAN_UNCONFIRMED', mode: getAgentMode(workspace, ownerSessionId), message: PLAN_UNCONFIRMED_MESSAGE };
    }
    this.pinSessionControl(workspace, targetPath, { mode });
    setAgentMode(mode, workspace);
    if (!this.options.mergeRuntimeSettings && !this.options.runtimeConfigPath) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    setAgentMode(mode, resolved);
    await this.mergeRuntimeSettings({
      [agentModeConfigKey(workspace)]: mode,
      [agentModeConfigKey(resolved)]: mode,
    });
    return { ok: true, mode };
  }

  private async writeApprovalPolicy(workspace: string, rawLevel: unknown, targetPath?: string): Promise<{ ok: true; level: ApprovalPolicy }> {
    const level = parseApproval(typeof rawLevel === 'string' ? rawLevel : String(rawLevel ?? ''));
    if (!level) throw new Error('INVALID_APPROVAL_POLICY');
    this.pinSessionControl(workspace, targetPath, { approval: level });
    setApprovalPolicy(level, workspace);
    if (!this.options.mergeRuntimeSettings && !this.options.runtimeConfigPath) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    setApprovalPolicy(level, resolved);
    await this.mergeRuntimeSettings({
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
      case 'agent_take_steering': {
        const restored = s.clearQueue();
        for (const item of restored.followUp) await s.followUp(item);
        return { steering: restored.steering };
      }
      case 'agent_cancel_steer':
        return cancelQueuedSteer(s, readInput(args), { allowSole: args.allowSole === true });
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
      case 'agent_get_session_stats': {
        let systemPrompt = '';
        try {
          systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt : '';
        } catch {
          systemPrompt = '';
        }
        return withEstimatedContextUsage(s.getSessionStats(), {
          messages: s.messages,
          systemPrompt,
        });
      }
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

    // 内存里的会话先按截断后的文件重读条目、重建上下文，再 reload 让扩展按新条目重建状态。
    // 只 reload 不够：AgentSession.reload() 不重读会话文件，模型下一轮仍会读到被删掉的回复。
    const resync = async () => {
      syncSessionFromDisk(handle.session as unknown as SessionFileSync, sessionFile);
      await handle.reload();
    };
    try {
      await resync();
    } catch (firstError) {
      try {
        await resync();
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

  private handlesOf(workspace: string): WorkspaceHandlePort[] {
    const listed = this.options.agentHost.list?.(workspace) ?? [];
    if (listed.length > 0) return listed;
    const current = this.options.agentHost.get(workspace);
    return current ? [current] : [];
  }

  /** 目标会话已经在某个 handle 上时只切换前景，不调用 switchSession。 */
  private async focusExistingSession(workspace: string, args: Record<string, unknown>): Promise<{ cancelled: false } | undefined> {
    const targetPath = readOptionalString(args.sessionPath);
    if (!targetPath) return undefined;
    const current = this.options.agentHost.get(workspace) ?? await this.openInteractive(workspace);
    const currentFile = sessionFileOf(current);
    if (currentFile && sameSessionPath(currentFile, targetPath)) return { cancelled: false };
    const owned = this.handlesOf(workspace).find((handle) => {
      const file = sessionFileOf(handle);
      return Boolean(file && sameSessionPath(file, targetPath));
    });
    if (!owned || owned === current) return undefined;
    this.options.agentHost.focus?.(workspace, owned);
    await this.refreshCurrentSession(workspace, this.handleOps(owned));
    return { cancelled: false };
  }

  /** 前景正在跑时另开 handle 并把它设为前景。宿主不支持时返回 false，调用方抛 SESSION_BUSY。 */
  private async parkForeground(workspace: string): Promise<boolean> {
    const host = this.options.agentHost;
    if (!host.openAdditional || !host.focus) return false;
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const extra = await host.openAdditional(workspace, cwd);
    host.focus(workspace, extra);
    return true;
  }

  private ownsLiveJobs(handle: WorkspaceHandlePort | undefined): boolean {
    const sessionId = handle?.session?.sessionId;
    return typeof sessionId === 'string' && sessionId !== '' && Boolean(this.options.hasLiveJobs?.(sessionId));
  }

  private foregroundOwnsLiveJobs(workspace: string): boolean {
    return this.ownsLiveJobs(this.options.agentHost.get(workspace));
  }

  private foregroundIsBusy(workspace: string): boolean {
    const handle = this.options.agentHost.get(workspace);
    if (handle?.session.isStreaming) return true;
    const sessionId = typeof handle?.session.sessionId === 'string' ? handle.session.sessionId : undefined;
    return [...this.activeTurns.values()].some((turn) => {
      if (turn.workspace !== workspace || turn.source !== 'interactive') return false;
      if (!turn.sessionId || !sessionId) return true;
      return turn.sessionId === sessionId;
    });
  }

  private async workerEnv(workspace: string, cwd: string, source: 'interactive' | 'goal'): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      ...(await this.options.resolveEnv?.(workspace) ?? {}),
      PI_PACKAGE_DIR: this.options.agentDir,
    };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    const endpoint = await this.options.agentDataEndpoint?.(cwd);
    if (endpoint) env.AGENT_DATA_ENDPOINT = endpoint;
    env.PI_PERMISSION_PROFILE = workspace === '__system__' ? 'automation' : 'workspace';
    env.PI_HUMAN_ORIGIN_TOKEN = source === 'interactive' ? '1' : '0';
    if (this.options.mcpConfig) env.PI_MCP_CONFIG = JSON.stringify(await (this.options.mcpConfig.runtime?.(workspace) ?? this.options.mcpConfig.effective(workspace)));
    if (this.options.allowedPluginIds) env.PI_ALLOWED_EXTENSIONS = JSON.stringify(await this.options.allowedPluginIds());
    return env;
  }

  private async mergeRuntimeSettings(patch: Record<string, string>): Promise<void> {
    if (this.options.mergeRuntimeSettings) return this.options.mergeRuntimeSettings(patch);
    const path = this.options.runtimeConfigPath;
    if (!path) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    await mergeRuntimeSettingsFile(path, patch);
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
    return this.flushFollowUpOn(workspace, await this.resolveHandle(workspace), session);
  }

  private async flushFollowUpOn(workspace: string, handle: WorkspaceHandlePort, session: SessionContext): Promise<unknown> {
    if (handle.session.isStreaming) return undefined;
    const queued = [...handle.session.getFollowUpMessages()];
    if (queued.length === 0) return undefined;
    const restored = handle.session.clearQueue();
    for (const item of restored.steering) await handle.session.steer(item);
    for (const item of restored.followUp.slice(1)) await handle.session.followUp(item);
    if (handle !== this.options.agentHost.get(workspace)) {
      return this.sendRouted(workspace, handle, 'agent_prompt', { message: queued[0] });
    }
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
      // 排队的会话停在后台时直接打到它的 handle；走前景路径会把排队内容发进当前画面那份会话。
      const parked = this.parkedHandleFor(workspace, session);
      if (parked) {
        await this.sendRouted(workspace, parked, 'agent_follow_up', { message: next.input, permissionProfile: next.permissionProfile });
      } else {
        await this.send(workspace, 'agent_follow_up', { message: next.input, permissionProfile: next.permissionProfile, ...session });
      }
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

  /** Used by AgentData project authorization for an open session, including one parked in the background. */
  async ownsSession(workspace: string, sessionId: string): Promise<boolean> {
    if (this.currentSessionByWorkspace.get(workspace)?.sessionId === sessionId) return true;
    return this.handlesOf(workspace).some((handle) => handle.session.sessionId === sessionId);
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

/** 带 targetSessionPath 时可以打到停在后台那份会话的命令。 */
const ROUTED_COMMANDS = new Set([
  'agent_prompt', 'agent_steer', 'agent_follow_up', 'agent_abort', 'agent_take_steering', 'agent_cancel_steer',
  'agent_get_messages', 'agent_get_session_stats', 'agent_get_state',
]);
const PROMPT_COMMANDS = new Set(['agent_prompt', 'agent_steer', 'agent_follow_up']);

async function refreshHandleModel(handle: WorkspaceHandlePort): Promise<void> {
  const snapshot = handle.session.modelRuntime.getAvailableSnapshot() ?? [];
  const current = handle.session.model as { provider?: string; id?: string } | undefined;
  const live = current?.provider && current.id
    ? snapshot.find((model) => model.provider === current.provider && model.id === current.id)
    : undefined;
  if (live) {
    // 同一模型换的是档位映射等配置。setModel 会往会话里再记一条模型切换，这里只换引用。
    const state = handle.session.state;
    if (state.model !== live) state.model = live;
  } else if (current) {
    const next = snapshot[0];
    if (next) await handle.session.setModel(next);
  }
}

function sessionFileOf(handle: WorkspaceHandlePort): string | undefined {
  const file = handle.session.sessionFile;
  return typeof file === 'string' && file ? file : undefined;
}

function sameSessionPath(left: string, right: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(left) === norm(right);
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
  const { sessionId: _sessionId, sessionPath: _sessionPath, source: _source, goalId: _goalId, goalCondition: _goalCondition, revision: _revision, nextRound: _nextRound, idempotencyKey: _idempotencyKey, turnId: _turnId, targetSessionPath: _targetSessionPath, ...rpcArgs } = args;
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
