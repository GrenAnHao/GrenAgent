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
import { parseApproval, getDefaultApprovalPolicy, setApprovalPolicy, type ApprovalPolicy } from '../../../extensions/_shared/approval.js';
import { getAgentMode, getDefaultAgentMode, isAgentMode, setAgentMode } from '../../../extensions/agent-mode/modes.js';
import { getAllConfig as getRuntimeConfigSnapshot } from '../../../extensions/_shared/runtime-config.js';
import { PLAN_UNCONFIRMED_MESSAGE, planBlocksModeSwitch } from '../../../extensions/agent-mode/planState.js';
import { buildGoalStatus, type GoalStatusEnvelope } from '../../../extensions/goal/status.js';
import { agentModeConfigKey, approvalPolicyConfigKey, contextExclusionConfigKey, mergeRuntimeSettingsFile, sessionDefaultsConfigKey } from './settingsService';
import {
  SESSION_PREFERENCES_ENTRY,
  mergeSessionPreferences,
  parseSessionPreferences,
  parseSessionPreferencesPatch,
  readSessionPreferences,
  type SessionPreferenceEntry,
  type SessionPreferenceField,
  type SessionPreferences,
  type SessionPreferencesAck,
  type SessionPreferencesPatch,
} from '../../../extensions/_shared/session-preferences.js';
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
  agent_set_fast_mode: 'prompt',
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
  agent_get_session_defaults: 'get_state',
  agent_set_session_defaults: 'get_state',
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
  /** 同一会话的偏好写入队列：按收到顺序串行，逐次读最新快照再合并，revision 只增不减。 */
  private readonly preferenceWrites = new Map<string, Promise<unknown>>();
  /** 我们自己派生写下的原生 thinking 回显（sessionId+NUL+level → 模型签名栈）。 */
  private readonly nativeThinkingEchoes = new Map<string, string[]>();
  /** 同一目标会话正在进行的 openAdditional（并发请求共用一次打开）。 */
  private readonly targetOpens = new Map<string, Promise<WorkspaceHandlePort>>();
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
        // 在途偏好写先收口：删除 / 换走之后旧 session 对象不能再往文件里追加条目。
        await this.awaitPreferenceWrites(workspace, handle.session.sessionId);
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
    if (command === 'agent_get_session_defaults') {
      return this.readSessionDefaults(workspace);
    }
    if (command === 'agent_set_session_defaults') {
      return this.writeSessionDefaults(workspace, args.preferences);
    }
    if (command === 'agent_set_model' || command === 'agent_set_thinking_level' || command === 'agent_set_fast_mode') {
      return this.writeSessionPreference(workspace, command, args, targetPath);
    }
    if (command === 'agent_cycle_model' || command === 'agent_cycle_thinking_level') {
      return this.cycleSessionPreference(workspace, command, targetPath);
    }
    if (command === 'agent_get_state' && targetPath) {
      return this.readTargetSessionState(workspace, targetPath);
    }
    if (PROMPT_COMMANDS.has(command)) {
      // prompt / steer / follow_up 都会触发供应商请求，都要过同一道门：
      // 请求的模型不在目录里时不静默改用别的模型，明确报错让 UI 要用户重选。
      // 只有 thinkingLevel 被能力钳制不算：顶层 effective 值照常用。
      await this.assertSessionModelAvailable(workspace, targetPath);
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
      // 会话替换要等在途的偏好写结束：否则那个写拿着的旧 session 对象会在替换后被继续写入 / 提交，
      // 出现“A 的偏好落到 B”或“写进一份已不再代表任何会话的对象”。
      const replacing = this.options.agentHost.get(workspace);
      const replacingId = typeof replacing?.session.sessionId === 'string' ? replacing.session.sessionId : undefined;
      if (replacing && this.hasPendingPreferenceWrite(workspace, replacingId)) {
        await this.awaitPreferenceWrites(workspace, replacingId);
      }
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
    if (command === 'agent_new_session' && args.initialPreferences !== undefined) {
      // 放在停靠 / 忙检查之后：新会话与普通新建走同一套前台保护。
      return this.newSessionWithPreferences(workspace, args);
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
        return this.sessionStateWithPreferences(handle, (await this.ownedState(workspace, result)) as Record<string, unknown>);
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
            // 派生会话可能落在锚点之前、没带上 canonical 条目（锚点之后才保存的偏好不会出现在分支里）。
            // 这时把源会话的请求值补进新身份，别让新会话悄悄回落到 SDK 默认。
            await this.seedForkedPreferences(workspace, handle);
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
    if (command === 'agent_get_state') return this.sessionStateWithPreferences(handle, (await this.ownedState(workspace, handle.getState())) as Record<string, unknown>);
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
   * 模式 / 审批档按会话生效：带 targetSessionPath 时只钉到那份会话（内存 + canonical 条目），别的会话和项目默认都不动。
   * 不带 target 时沿用旧的“最近一次选择即项目默认”行为（草稿入口仍会用到）。
   */
  private async pinSessionControl(
    workspace: string,
    targetPath: string | undefined,
    patch: SessionPreferencesPatch,
  ): Promise<SessionPreferencesAck | undefined> {
    if (!targetPath) return undefined;
    const handle = await this.handleForTarget(workspace, targetPath);
    const sessionId = typeof handle?.session.sessionId === 'string' ? handle.session.sessionId : '';
    if (!handle || !sessionId) throw new Error('SESSION_NOT_LOADED');
    return this.applySessionPreferences(workspace, handle, patch);
  }

  private async writeAgentMode(
    workspace: string,
    rawMode: unknown,
    targetPath?: string,
  ): Promise<{ ok: true; mode: string; preferences?: SessionPreferences } | { ok: false; blocked: 'PLAN_UNCONFIRMED'; mode: string; message: string }> {
    const mode = String(rawMode ?? '').trim().toLowerCase();
    if (!isAgentMode(mode)) throw new Error('INVALID_AGENT_MODE');
    // 未确认的计划只能经侧栏「确认执行」进入执行：手切到能动手的模式直接取消，不动内存、不落盘。
    const owner = targetPath ? await this.handleForTarget(workspace, targetPath) : this.options.agentHost.get(workspace);
    const ownerSessionId = typeof owner?.session.sessionId === 'string' ? owner.session.sessionId : undefined;
    if (planBlocksModeSwitch(ownerSessionId, mode)) {
      return { ok: false, blocked: 'PLAN_UNCONFIRMED', mode: getAgentMode(workspace, ownerSessionId), message: PLAN_UNCONFIRMED_MESSAGE };
    }
    if (targetPath) {
      // 有 target：只改该会话，不碰项目默认。
      const ack = await this.pinSessionControl(workspace, targetPath, { mode });
      return { ok: true, mode, ...(ack ? { preferences: ack.preferences } : {}) };
    }
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

  private async writeApprovalPolicy(
    workspace: string,
    rawLevel: unknown,
    targetPath?: string,
  ): Promise<{ ok: true; level: ApprovalPolicy; preferences?: SessionPreferences }> {
    const level = parseApproval(typeof rawLevel === 'string' ? rawLevel : String(rawLevel ?? ''));
    if (!level) throw new Error('INVALID_APPROVAL_POLICY');
    if (targetPath) {
      const ack = await this.pinSessionControl(workspace, targetPath, { approval: level });
      return { ok: true, level, ...(ack ? { preferences: ack.preferences } : {}) };
    }
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

  /**
   * 按会话路径找到承载它的 handle。
   *
   * - 已在某个 handle 上（前景或停在后台）：直接用它，不切前景。
   * - 已经不在任何 handle 上（后台跑完被拆了）：如果有 openAdditional，就为它另开一个非前景
   *   handle 再 switchSession 过去。这不改 currentSessionByWorkspace，也不 focus，所以不会抢别的窗口的前景。
   * - 没有 openAdditional 或文件不存在 / 属于别的项目：SESSION_NOT_LOADED（绝不复活已删除会话）。
   */
  private async handleForTarget(workspace: string, targetPath: string): Promise<WorkspaceHandlePort | undefined> {
    const owned = this.handleOwningPath(workspace, targetPath);
    if (owned) return owned;
    // 已删除 / 不存在的目标绝不复活：先看文件在不在，再去读它的身份。
    if (!existsSync(targetPath)) return undefined;
    const host = this.options.agentHost;
    if (!host.openAdditional) return undefined;
    const identity = await readSessionIdentity(targetPath, workspace);
    // 同一目标并发两次（两个窗口 / 两条命令）时共用一次打开，避免每个都另开一个 handle。
    const inflightKey = this.sessionKey(workspace, identity.sessionId);
    const existing = this.targetOpens.get(inflightKey);
    if (existing) return existing;
    const task = (async () => {
      const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
      const handle = await host.openAdditional!.call(host, workspace, cwd);
      try {
        const result = await handle.switchSession(identity.sessionPath);
        if (isCancelledResult(result)) throw new Error('SESSION_SWITCH_CANCELLED');
      } catch (error) {
        // 没能切到目标：这个多出来的 handle 不该留着占位。
        try { await host.evict?.call(host, workspace, handle); } catch { /* 拆不掉不影响抛错 */ }
        throw error;
      }
      return handle;
    })();
    this.targetOpens.set(inflightKey, task);
    try {
      return await task;
    } finally {
      if (this.targetOpens.get(inflightKey) === task) this.targetOpens.delete(inflightKey);
    }
  }

  /** 读一份会话日志里的偏好快照（只看内存条目，不构造 runtime）。 */
  private preferencesOf(handle: WorkspaceHandlePort): SessionPreferences {
    return this.preferencesFrom(handle.session);
  }

  /**
   * 读偏好时带上“钳制判定”：canonical 之后 SDK 写的 thinking 条目如果只是当前模型的钳制结果，
   * 不能当成一次新的显式选择（否则用户请求的 high 会被永久降成 off）。
   */
  private preferencesFrom(session: AgentSession | { sessionManager?: unknown; modelRuntime?: unknown; model?: unknown }): SessionPreferences {
    const manager = (session as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
    const entries = typeof manager?.getEntries === 'function' ? manager.getEntries() : [];
    const snapshot = (session as { modelRuntime?: { getAvailableSnapshot?: () => unknown[] } }).modelRuntime?.getAvailableSnapshot?.() ?? [];
    const liveModel = (session as { model?: unknown }).model;
    const parsed = readSessionPreferences((Array.isArray(entries) ? entries : []) as SessionPreferenceEntry[], {
      clampThinking: (level) => {
        const model = liveModel ?? snapshot[0];
        if (!model) return undefined;
        return clampThinkingLevel(model, level);
      },
      suppressNativeThinking: (level) => this.isNativeThinkingEcho(session as AgentSession, level),
    });
    return parsed;
  }

  private sessionPathOf(handle: WorkspaceHandlePort): string | undefined {
    const file = handle.session.sessionFile;
    return typeof file === 'string' && file ? file : undefined;
  }

  /** 模型是否在当前目录里（不存在则 unavailable；不自动改写用户请求）。 */
  private modelUnavailable(session: AgentSession, preferences: SessionPreferences): boolean {
    const wanted = preferences.model;
    if (!wanted) return false;
    const snapshot = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    return !snapshot.some((model) => model.provider === wanted.provider && model.id === wanted.id);
  }

  /** thinking 是否被当前模型能力挡住（例如非推理模型放不下 high）。 */
  private thinkingUnavailable(session: AgentSession, preferences: SessionPreferences): boolean {
    const wanted = preferences.thinkingLevel;
    if (!wanted) return false;
    const model = preferences.model
      ? session.modelRuntime?.getAvailableSnapshot?.().find(
        (item) => item.provider === preferences.model!.provider && item.id === preferences.model!.id,
      )
      : session.model;
    if (!model) return false;
    return !supportedThinkingLevels(model).includes(wanted);
  }

  private unavailableFields(session: AgentSession, preferences: SessionPreferences): SessionPreferenceField[] {
    const fields: SessionPreferenceField[] = [];
    if (this.modelUnavailable(session, preferences)) fields.push('model');
    if (this.thinkingUnavailable(session, preferences)) fields.push('thinkingLevel');
    return fields;
  }

  /** 会话 state + 偏好快照。顶层 model/thinkingLevel 是有效值，preferences 是请求值。 */
  private sessionStateWithPreferences(
    handle: WorkspaceHandlePort,
    base: Record<string, unknown>,
  ): Record<string, unknown> {
    const preferences = this.preferencesOf(handle);
    // base.sessionFile 被清 null（外来会话不归本项目）时不能把 handle 的路径当成已归属。
    const owned = typeof base.sessionFile === 'string' && base.sessionFile ? base.sessionFile : undefined;
    const sessionPath = owned ?? this.sessionPathOf(handle);
    return {
      ...base,
      ...(owned && sessionPath ? { sessionPath, sessionFile: owned } : {}),
      preferences,
      unavailable: this.unavailableFields(handle.session, preferences),
    };
  }

  /**
   * 把一次偏好修改落到会话：先按该 handle 串行排队，读最新快照合并字段，写 canonical 条目，
   * 再把能生效的字段应用到 live。日志写失败直接抛（不改 live），不能假报持久成功。
   */
  private applySessionPreferences(
    workspace: string,
    handle: WorkspaceHandlePort,
    patch: SessionPreferencesPatch,
    options: { failOnUnavailable?: boolean } = {},
  ): Promise<SessionPreferencesAck> {
    // 入队时就锁定会话身份：排到执行时 handle.session 可能已经被 idle switch / new 换掉，
    // 不能再按 handle 对象认为身份固定（否则 A 的 patch 会落到 B）。
    const expectedSessionId = typeof handle.session.sessionId === 'string' ? handle.session.sessionId : undefined;
    const expectedSessionPath = this.sessionPathOf(handle);
    const key = this.sessionKey(workspace, expectedSessionId);
    const previous = this.preferenceWrites.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.applySessionPreferencesNow(workspace, handle, patch, options, {
        sessionId: expectedSessionId,
        sessionPath: expectedSessionPath,
      }));
    this.preferenceWrites.set(key, task as Promise<unknown>);
    return task.finally(() => {
      if (this.preferenceWrites.get(key) === task as Promise<unknown>) this.preferenceWrites.delete(key);
    });
  }

  /**
   * 排到队时校验会话身份。handle 已经换成别的会话时按原 path 另开非前景 handle（不抢前景），
   * 目标文件不在了就拒绝——绝不把这次写落到当前挂在这个 handle 上的会话。
   */
  private async resolvePinnedTarget(
    workspace: string,
    handle: WorkspaceHandlePort,
    expected: { sessionId?: string; sessionPath?: string },
  ): Promise<WorkspaceHandlePort> {
    const currentId = typeof handle.session.sessionId === 'string' ? handle.session.sessionId : undefined;
    const currentPath = this.sessionPathOf(handle);
    const sameSession = expected.sessionPath
      ? Boolean(currentPath && sameSessionPath(currentPath, expected.sessionPath))
      : currentId === expected.sessionId;
    if (sameSession) return handle;
    if (!expected.sessionPath) throw new Error('SESSION_NOT_LOADED');
    const target = await this.handleForTarget(workspace, expected.sessionPath);
    if (!target) throw new Error('SESSION_NOT_LOADED');
    return target;
  }

  /**
   * 记下“这条原生 thinking 条目是我们自己派生的 effective 值”，读取时不当成显式请求。
   * 键是会话 id + 档位 + 当时的模型能力签名，避免误吞用户随后真正的手动切换。
   */
  private suppressNativePreferenceEcho(session: AgentSession, level: string): void {
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
    if (!sessionId) return;
    const live = session.model as { provider?: string; id?: string } | undefined;
    const key = `${sessionId} ${level}`;
    const signature = `${live?.provider ?? ''}/${live?.id ?? ''}`;
    const list = this.nativeThinkingEchoes.get(key) ?? [];
    list.push(signature);
    if (list.length > 8) list.shift();
    this.nativeThinkingEchoes.set(key, list);
  }

  /** 这次 thinking 条目是不是我们自己刚写下的 effective 回显。 */
  private isNativeThinkingEcho(session: AgentSession, level: string): boolean {
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
    if (!sessionId) return false;
    const list = this.nativeThinkingEchoes.get(`${sessionId} ${level}`);
    if (!list || list.length === 0) return false;
    const live = session.model as { provider?: string; id?: string } | undefined;
    const signature = `${live?.provider ?? ''}/${live?.id ?? ''}`;
    const index = list.indexOf(signature);
    if (index < 0) return false;
    // 只吞一次：用户之后真的手动切到同一档位时还能被识别。
    list.splice(index, 1);
    return true;
  }

  /** 写一条恢复条目，把 canonical 退回 base（live 应用失败时用）。 */
  private async restoreCanonical(
    manager: { appendCustomEntry?: (customType: string, data?: unknown) => string } | undefined,
    base: SessionPreferences,
  ): Promise<void> {
    const restored: SessionPreferences = { ...base, revision: base.revision + 1 };
    try {
      await this.appendPreferencesEntry(manager, restored);
    } catch {
      /* 恢复条目也写不进去时保留原始错误，不掩盖 */
    }
  }

  /** handle 上挂的仍是这次写锁定的那份会话（未被 idle switch / new 换走）。 */
  private handleStillOn(
    handle: WorkspaceHandlePort,
    expected: { sessionId?: string; sessionPath?: string },
  ): boolean {
    const currentPath = this.sessionPathOf(handle);
    if (expected.sessionPath) return Boolean(currentPath && sameSessionPath(currentPath, expected.sessionPath));
    const currentId = typeof handle.session.sessionId === 'string' ? handle.session.sessionId : undefined;
    return currentId === expected.sessionId;
  }

  /** 这个会话还有在途的偏好写（队列没清空）。会话替换 / 删除前要等它结束。 */
  private hasPendingPreferenceWrite(workspace: string, sessionId?: string): boolean {
    return this.preferenceWrites.has(this.sessionKey(workspace, sessionId));
  }

  private async awaitPreferenceWrites(workspace: string, sessionId?: string): Promise<void> {
    const pending = this.preferenceWrites.get(this.sessionKey(workspace, sessionId));
    if (pending) await pending.catch(() => {});
  }

  private async applySessionPreferencesNow(
    workspace: string,
    handle: WorkspaceHandlePort,
    patch: SessionPreferencesPatch,
    options: { failOnUnavailable?: boolean },
    expected: { sessionId?: string; sessionPath?: string },
  ): Promise<SessionPreferencesAck> {
    const target = await this.resolvePinnedTarget(workspace, handle, expected);
    // 冻结这一刻的 session 对象：后面 setModel 内部会 await auth，期间同一个 handle 可能被
    // 换成别的会话。所有读写都打在这个旧对象上，提交前再确认 handle 没有换过。
    const session = target.session;
    // 连 sessionManager 一起冻结：它决定条目落到哪个 jsonl（B 的 handle 换上来后 session.sessionManager
    // 已经不是这一份了）。后面的所有 await 都不能再重新读 handle.session.sessionManager。
    const manager = session.sessionManager as unknown as {
      appendCustomEntry?: (customType: string, data?: unknown) => string;
      getEntries?: () => unknown[];
    } | undefined;
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId : undefined;
    // 路径也取冻结对象上的（handle.session.sessionFile 可能已经是换上来那份会话的）。
    const frozenFile = typeof session.sessionFile === 'string' && session.sessionFile ? session.sessionFile : undefined;
    const sessionPath = frozenFile ?? expected.sessionPath;
    const snapshot = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    const base = this.preferencesFrom(session);
    const requested = mergeSessionPreferences(base, patch);

    // 模型不在目录里：保留请求值、不动 live。
    const unavailable: SessionPreferenceField[] = [];
    const applied: SessionPreferenceField[] = [];
    const modelAvailable = patch.model
      ? snapshot.some((model) => model.provider === patch.model!.provider && model.id === patch.model!.id)
      : false;
    if (patch.model && !modelAvailable) unavailable.push('model');
    // 档位被当前模型能力挡住：仍然交给 SDK 钳制（effective 会是更低的合法值），请求值保留。
    // 模型不可用时不动 live，也就不能再套档位（否则会改到当前这个无关模型的会话）。
    const canTouchThinking = patch.model ? modelAvailable : true;
    const wantedThinking = canTouchThinking ? (patch.thinkingLevel ?? (patch.model ? requested.thinkingLevel : undefined)) : undefined;
    if (patch.thinkingLevel && canTouchThinking && this.thinkingUnsupported(session, requested)) {
      unavailable.push('thinkingLevel');
    }

    // 落条目前的 live 快照：写日志失败时要把它还原，不能出现“UI 报失败、会话却已经改了”。
    const liveBefore = {
      model: session.model as unknown,
      thinkingLevel: session.thinkingLevel,
    };
    // 先做 auth 预校验：setModel 失败会留下一条原生 model_change，和 canonical 分叉。
    // 预校验通过再写 canonical，最后才应用 live，这样任何一步失败都只回滚内存、不会写盘不一致。
    if (patch.model && modelAvailable) {
      const model = snapshot.find((item) => item.provider === patch.model!.provider && item.id === patch.model!.id);
      if (model) {
        const runtime = session.modelRuntime as unknown as {
          checkAuth?: (provider: string) => Promise<unknown>;
          hasConfiguredAuth?: (provider: string) => boolean;
        };
        if (typeof runtime.checkAuth === 'function') {
          const auth = await runtime.checkAuth(model.provider);
          if (!auth) throw new Error(`No API key for ${model.provider}/${model.id}`);
        } else if (typeof runtime.hasConfiguredAuth === 'function' && !runtime.hasConfiguredAuth(model.provider)) {
          throw new Error(`No API key for ${model.provider}/${model.id}`);
        }
      }
    }

    const leafBefore = readManagerLeaf(manager);
    // canonical 先落：原生 model_change / thinking_level_change 由 SDK 在应用 live 时追加，
    // 排在 canonical 之后。这样即使 canonical 写成功、后面的 SDK 步骤失败，也不会出现
    // “原生条目已写、canonical 还是旧值”的分叉（读取时老 canonical 仍然主导全字段）。
    try {
      await this.appendPreferencesEntry(manager, requested);
    } catch (error) {
      rollbackPreferenceEntry(manager, requested, leafBefore);
      throw error;
    }

    // canonical 已落盘，再应用 live。这里失败要把 canonical 也补回去（写一条恢复条目），
    // 不能出现“磁盘上留了新请求值、UI 却按失败回滚”的分叉。
    try {
      if (patch.model && modelAvailable) {
        const model = snapshot.find((item) => item.provider === patch.model!.provider && item.id === patch.model!.id);
        if (model) {
          await session.setModel(model);
          applied.push('model');
        }
      }
    } catch (error) {
      await this.restoreLiveState(target, session, liveBefore);
      await this.restoreCanonical(manager, base);
      throw error;
    }
    // 模型换过（或请求了档位）就按请求值重算 effective：setModel 会按 SDK 自己的默认重选档位，
    // 不能让它把请求的 high 留在 medium。能力不够时也真的调一次，让 SDK 钳成 off。
    // 这一下写出的原生 thinking 条目是“我们派生的 effective 值”，标记为 suppress：
    // 冷恢复 / 读取时不能用它反过来当成新的显式请求。
    if (wantedThinking) {
      try {
        this.suppressNativePreferenceEcho(session, wantedThinking);
        session.setThinkingLevel(wantedThinking as Parameters<AgentSession['setThinkingLevel']>[0]);
        if (patch.thinkingLevel) applied.push('thinkingLevel');
      } catch (error) {
        await this.restoreLiveState(target, session, liveBefore);
        await this.restoreCanonical(manager, base);
        throw error;
      }
    }


    if (patch.mode) {
      if (sessionId) setAgentMode(patch.mode, workspace, sessionId);
      applied.push('mode');
    }
    if (patch.approval) {
      if (sessionId) setApprovalPolicy(patch.approval, workspace, sessionId);
      applied.push('approval');
    }
    // Fast 没有 live setter：落到 canonical 即生效，扩展每次请求按发起会话现读。
    if (typeof patch.fastMode === 'boolean') applied.push('fastMode');
    // UI 状态按路径归属；handle 已经被换走时不能拿它推（那会把 A 的值广播成 B 的）。
    if (this.handleStillOn(target, expected)) {
      if (patch.mode) this.pushSessionControlStatus(target, { mode: patch.mode });
      if (patch.approval) this.pushSessionControlStatus(target, { approval: patch.approval });
      // T12：每次成功提交都推完整快照（含 model / thinkingLevel），另一个窗口按 sessionPath + revision 应用。
      // 写盘失败在上面已经抛错，不会走到这里，不能广播没持久化的值。
      this.pushSessionPreferencesStatus(target, requested);
    }
    if (options.failOnUnavailable && unavailable.length > 0) {
      // 草稿首发：模型无效时就别把这次写当成已初始化完成，交给调用方决定。
      throw new Error(`PREFERENCES_UNAVAILABLE: ${unavailable.join(',')}`);
    }
    const finalUnavailable = this.unavailableFields(session, requested);
    // 有效值从这个已经落盘的那份 session 现取（handle 可能已被换成别的会话，不能拿它顶替）。
    const current = session as unknown as { model?: unknown; thinkingLevel?: unknown };
    const state = {
      model: snapshotSessionModel(current.model) ?? null,
      thinkingLevel: typeof current.thinkingLevel === 'string' ? current.thinkingLevel : null,
    };
    return {
      ok: true,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath, sessionFile: sessionPath } : {}),
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      preferences: requested,
      applied,
      unavailable: mergeUnavailable(unavailable, finalUnavailable),
    };
  }

  /**
   * 写 canonical 条目。管理器换来换去（排队期间 handle 换会话）时按 target 上的管理器现取，
   * 写失败必须抛：不能假报持久成功。
   */
  private async appendPreferencesEntry(
    manager: { appendCustomEntry?: (customType: string, data?: unknown) => string } | undefined,
    requested: SessionPreferences,
  ): Promise<void> {
    try {
      if (typeof manager?.appendCustomEntry !== 'function') throw new Error('session manager cannot append entries');
      manager.appendCustomEntry(SESSION_PREFERENCES_ENTRY, requested);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`PREFERENCES_PERSIST_FAILED: ${detail}`);
    }
  }

  /**
   * 派生出来的会话如果自己没有 canonical 条目，就从它已经复制到的原生条目 / 当前 live 值补一条。
   * 已有 canonical（分支里带过来的）就不动：那是源会话在锚点前真实的请求值。
   */
  private async seedForkedPreferences(workspace: string, handle: WorkspaceHandlePort): Promise<void> {
    const session = handle.session;
    const existing = this.preferencesFrom(session);
    if (existing.revision > 0) return;
    const patch: SessionPreferencesPatch = {
      ...(existing.model ? { model: existing.model } : {}),
      ...(existing.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
      ...(existing.mode ? { mode: existing.mode } : {}),
      ...(existing.approval ? { approval: existing.approval } : {}),
      // Fast 的 false 是有效值：按 boolean 判定，truthy 判断会把关闭态丢掉。
      ...(typeof existing.fastMode === 'boolean' ? { fastMode: existing.fastMode } : {}),
    };
    if (Object.keys(patch).length === 0) return;
    try {
      await this.applySessionPreferences(workspace, handle, patch);
    } catch {
      /* 补初值失败不影响派生本身；下次读取仍按原生条目回退 */
    }
  }

  /** 只读一份不在 handle 上的会话的偏好快照（文件不存在时返回空）。 */
  private async detachedPreferences(sessionPath: string): Promise<SessionPreferences> {
    try {
      if (!existsSync(sessionPath)) return { revision: 0 };
      const identity = await readSessionIdentity(sessionPath);
      const manager = SessionManager.open(identity.sessionPath);
      return readSessionPreferences(manager.getEntries() as SessionPreferenceEntry[]);
    } catch {
      return { revision: 0 };
    }
  }

  /** 偏好写盘失败时把 live 还原，避免会话被改成没记进日志的值。 */
  private async restoreLiveState(
    handle: WorkspaceHandlePort,
    target: AgentSession,
    previous: { model: unknown; thinkingLevel: unknown },
  ): Promise<void> {
    const session = target as unknown as {
      state?: { model?: unknown };
      setThinkingLevel(level: string): void;
    };
    try {
      // session.model 是只读 getter（返回 agent.state.model），要写回它背后的 state 字段；
      // 用 setModel 会再追加一条 model_change 并触发事件，回滚不该留下这些副作用。
      if (previous.model && session.state) session.state.model = previous.model;
      if (typeof previous.thinkingLevel === 'string') session.setThinkingLevel(previous.thinkingLevel);
    } catch {
      /* 还原失败不覆盖原始写盘错误 */
    }
  }

  /** 请求的档位不在“当前/请求模型”的支持列表里。 */
  private thinkingUnsupported(session: AgentSession, preferences: SessionPreferences): boolean {
    const wanted = preferences.thinkingLevel;
    if (!wanted) return false;
    const model = preferences.model
      ? session.modelRuntime?.getAvailableSnapshot?.().find(
        (item) => item.provider === preferences.model!.provider && item.id === preferences.model!.id,
      )
      : session.model;
    if (!model) return false;
    return !supportedThinkingLevels(model).includes(wanted);
  }

  private pushSessionPreferencesStatus(handle: WorkspaceHandlePort, preferences: SessionPreferences): void {
    const ui = handle.ui as { context?: { setStatus?: (key: string, value: unknown) => void } } | undefined;
    ui?.context?.setStatus?.('session-preferences', JSON.stringify(preferences));
  }

  private pushSessionControlStatus(handle: WorkspaceHandlePort, patch: { mode?: string; approval?: string }): void {
    const ui = handle.ui as { context?: { setStatus?: (key: string, value: unknown) => void } } | undefined;
    if (patch.mode) ui?.context?.setStatus?.('agent-mode', patch.mode);
    if (patch.approval) ui?.context?.setStatus?.('approval-policy', patch.approval);
  }

  /**
   * cycle 也走 canonical：不写回去的话，下次冷恢复会按旧请求值上，和当前有效值分叉。
   * 模型换位后 SDK 会自己重选档位；这里只把用户明确选的档位写回，不把钳制结果当成新的请求值。
   */
  private async cycleSessionPreference(
    workspace: string,
    command: string,
    targetPath: string | undefined,
  ): Promise<Record<string, unknown>> {
    const handle = targetPath
      ? await this.handleForTarget(workspace, targetPath)
      : await this.resolveHandle(workspace);
    if (!handle) throw new Error('SESSION_NOT_LOADED');
    const s = handle.session;
    if (command === 'agent_cycle_model') {
      const result = await s.cycleModel();
      if (!result) return null as unknown as Record<string, unknown>;
      const model = result.model as { provider?: string; id?: string } | undefined;
      const ack = model?.provider && model.id
        ? await this.applySessionPreferences(workspace, handle, { model: { provider: model.provider, id: model.id } })
        : undefined;
      return {
        ...(snapshotSessionModel(result.model) ?? result),
        ...(ack
          ? {
            sessionPath: ack.sessionPath,
            sessionFile: ack.sessionPath,
            preferences: ack.preferences,
            unavailable: ack.unavailable,
          }
          : {}),
      };
    }
    const level = s.cycleThinkingLevel();
    if (!level) return null as unknown as Record<string, unknown>;
    const ack = await this.applySessionPreferences(workspace, handle, { thinkingLevel: level });
    return {
      level,
      ...(ack.sessionPath ? { sessionPath: ack.sessionPath, sessionFile: ack.sessionPath } : {}),
      preferences: ack.preferences,
      unavailable: ack.unavailable,
      ...(ack.thinkingLevel !== undefined ? { thinkingLevel: ack.thinkingLevel } : {}),
    };
  }

  /** 写模型 / 思考档 / Fast：带 target 按路径路由，不带则回落到当前前景会话。 */
  private async writeSessionPreference(
    workspace: string,
    command: string,
    args: Record<string, unknown>,
    targetPath: string | undefined,
  ): Promise<SessionPreferencesAck> {
    // 先校验参数再解析目标：非法值不该顺手打开 / 切换会话。
    if (command === 'agent_set_fast_mode') {
      // false 是有效值，必须严格按 boolean 判定（不能用 truthy）；没有额外 live setter，
      // 扩展在每次请求前从发起会话的 sessionManager 读这份偏好。
      if (typeof args.enabled !== 'boolean') throw new Error('INVALID_FAST_MODE');
      const enabled = args.enabled;
      const handle = targetPath
        ? await this.handleForTarget(workspace, targetPath)
        : await this.resolveHandle(workspace);
      if (!handle) throw new Error('SESSION_NOT_LOADED');
      return this.applySessionPreferences(workspace, handle, { fastMode: enabled });
    }
    const handle = targetPath
      ? await this.handleForTarget(workspace, targetPath)
      : await this.resolveHandle(workspace);
    if (!handle) throw new Error('SESSION_NOT_LOADED');
    if (command === 'agent_set_model') {
      const provider = readOptionalString(args.provider);
      const modelId = readOptionalString(args.modelId);
      if (!provider || !modelId) throw new Error('INVALID_MODEL');
      return this.applySessionPreferences(workspace, handle, { model: { provider, id: modelId } });
    }
    const level = readOptionalString(args.level);
    if (!level) throw new Error('INVALID_THINKING_LEVEL');
    return this.applySessionPreferences(workspace, handle, { thinkingLevel: level });
  }

  /** 新会话：按 initialPreferences 初始化并返回带路径的回执（不依赖 getState(workspace) 的当前前景）。 */
  private async newSessionWithPreferences(
    workspace: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const initial = parseSessionPreferencesPatch(args.initialPreferences);
    const foreground = await this.resolveHandle(workspace);
    const stateBefore = await foreground.getState();
    const beforeFile = typeof stateBefore.sessionFile === 'string' ? stateBefore.sessionFile : undefined;
    const result = await foreground.newSession();
    if (isCancelledResult(result)) return result;
    // newSession 一返回就锁住新身份：后面的 await（刷新 / 写偏好）期间别的窗口可能又把前景换走，
    // 那时再从 handle.session 取就会拿到别人的会话。
    const session = foreground.session;
    const afterFile = typeof session.sessionFile === 'string' && session.sessionFile ? session.sessionFile : undefined;
    const newSessionId = typeof session.sessionId === 'string' ? session.sessionId : undefined;
    const identity = await this.refreshCurrentSession(workspace, this.handleOps(foreground));
    const lockedFile = afterFile ?? identity?.sessionPath;
    const sameFile = Boolean(beforeFile && lockedFile && sameSessionPath(beforeFile, lockedFile));
    if (sameFile) {
      // newSession 没换文件（测试桩/极端失败）：不能把偏好写进旧会话。
      throw new Error('SESSION_NOT_CREATED');
    }
    if (Object.keys(initial).length === 0) {
      return {
        cancelled: false,
        ...(newSessionId ?? identity?.sessionId ? { sessionId: newSessionId ?? identity?.sessionId } : {}),
        ...(lockedFile ? { sessionPath: lockedFile, sessionFile: lockedFile } : {}),
        preferences: this.preferencesFrom(session),
      };
    }
    const ack = await this.applySessionPreferences(workspace, foreground, initial);
    return {
      cancelled: false,
      ...(ack.sessionId ? { sessionId: ack.sessionId } : {}),
      ...(ack.sessionPath ? { sessionPath: ack.sessionPath, sessionFile: ack.sessionPath } : {}),
      preferences: ack.preferences,
      applied: ack.applied,
      unavailable: ack.unavailable,
    };
  }

  /**
   * 按路径读会话 state：在 handle 上就读该 handle（不切前景）；已释放就只读投影它自己的 jsonl，并标 detached。
   */
  private async readTargetSessionState(workspace: string, targetPath: string): Promise<Record<string, unknown>> {
    const owner = this.handleOwningPath(workspace, targetPath);
    if (owner) {
      return this.sessionStateWithPreferences(owner, (await this.ownedState(workspace, owner.getState())) as Record<string, unknown>);
    }
    const identity = await readSessionIdentity(targetPath, workspace);
    if (!existsSync(identity.sessionPath)) throw new Error('SESSION_NOT_LOADED');
    const manager = SessionManager.open(identity.sessionPath);
    const preferences = readSessionPreferences(manager.getEntries() as SessionPreferenceEntry[]);
    return {
      // 只读投影：内存里的会话不在这里，不编造有效值，只给请求值与身份。
      model: null,
      thinkingLevel: null,
      sessionFile: identity.sessionPath,
      sessionPath: identity.sessionPath,
      sessionId: identity.sessionId,
      preferences,
      unavailable: [],
      detached: true,
    };
  }

  /**
   * prompt 前的最后一道门。
   *
   * 1) 请求的模型不在目录里 → SESSION_MODEL_UNAVAILABLE（UI 禁用之外的保证）；
   * 2) 请求的模型回来了、但 live 还停在 SDK 的 fallback：先把 effective 切回请求的模型，再重套请求档位。
   *    这里只改 effective（不写 canonical），也不把 preferences 改成 live。
   */
  private async assertSessionModelAvailable(workspace: string, targetPath?: string): Promise<void> {
    // 这里只做检查，不为目标另开 handle：目标是停靠的会话就直接看它；不在 handle 上就读它自己的 jsonl
    // （只读，不改任何状态），仍拿前景的模型目录判断。
    const handle = targetPath
      ? this.handleOwningPath(workspace, targetPath)
      : this.options.agentHost.get(workspace);
    if (!handle && !targetPath) return;
    const preferences = handle ? this.preferencesOf(handle) : await this.detachedPreferences(targetPath!);
    if (!preferences.model) return;
    const catalogOwner = handle ?? this.options.agentHost.get(workspace);
    const snapshot = catalogOwner?.session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    const wanted = snapshot.find(
      (model) => model.provider === preferences.model!.provider && model.id === preferences.model!.id,
    );
    if (!wanted) throw new Error('SESSION_MODEL_UNAVAILABLE');
    // 目标不在 handle 上：交给后续 agent_switch_session 路由，这里只拦住不可用模型。
    if (!handle) return;
    const live = handle.session.model as { provider?: string; id?: string } | undefined;
    if (live?.provider === wanted.provider && live.id === wanted.id) return;
    await handle.session.setModel(wanted);
    if (preferences.thinkingLevel) {
      handle.session.setThinkingLevel(preferences.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0]);
    }
  }

  /** 项目默认快照：模式与审查档读 runtime-settings（规范化 workspace 键），模型与思考读 SESSION_DEFAULTS。 */
  private async readSessionDefaults(workspace: string): Promise<SessionPreferences> {
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const config = await this.runtimeConfigSnapshot();
    const pick = (key: string) => config[key];
    const mode = pick(agentModeConfigKey(workspace)) ?? pick(agentModeConfigKey(resolved)) ?? getDefaultAgentMode(workspace);
    const approval = pick(approvalPolicyConfigKey(workspace)) ?? pick(approvalPolicyConfigKey(resolved)) ?? getDefaultApprovalPolicy(workspace);
    const modelDefaults = parseSessionPreferencesPatch(safeJson(pick(sessionDefaultsConfigKey(workspace)) ?? pick(sessionDefaultsConfigKey(resolved))));
    return {
      ...(modelDefaults.model ? { model: modelDefaults.model } : {}),
      ...(modelDefaults.thinkingLevel ? { thinkingLevel: modelDefaults.thinkingLevel } : {}),
      mode: isAgentMode(mode) ? mode : 'agent',
      approval: parseApproval(approval) ?? 'auto',
      ...(typeof modelDefaults.fastMode === 'boolean' ? { fastMode: modelDefaults.fastMode } : {}),
      revision: 0,
    };
  }

  /**
   * 写项目默认：模式 / 审查写原有 AGENT_MODE / APPROVAL_POLICY 键（内存也同步），
   * 模型 / 思考写 SESSION_DEFAULTS。不动任何现存会话。
   */
  private async writeSessionDefaults(workspace: string, raw: unknown): Promise<SessionPreferences> {
    const patch = parseSessionPreferencesPatch(raw);
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const runtimePatch: Record<string, string> = {};
    if (patch.mode) {
      setAgentMode(patch.mode, workspace);
      setAgentMode(patch.mode, resolved);
      runtimePatch[agentModeConfigKey(workspace)] = patch.mode;
      runtimePatch[agentModeConfigKey(resolved)] = patch.mode;
    }
    if (patch.approval) {
      setApprovalPolicy(patch.approval, workspace);
      setApprovalPolicy(patch.approval, resolved);
      runtimePatch[approvalPolicyConfigKey(workspace)] = patch.approval;
      runtimePatch[approvalPolicyConfigKey(resolved)] = patch.approval;
    }
    if (patch.model || patch.thinkingLevel || typeof patch.fastMode === 'boolean') {
      if (!this.options.mergeRuntimeSettings && !this.options.runtimeConfigPath) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
      const existing = parseSessionPreferencesPatch(safeJson(await this.readRawRuntimeKey(sessionDefaultsConfigKey(workspace))));
      const merged: SessionPreferencesPatch = {
        model: patch.model ?? existing.model,
        thinkingLevel: patch.thinkingLevel ?? existing.thinkingLevel,
        // 显式默认 Fast 的 false 也要保留，回读时不能当缺省。
        ...(typeof (patch.fastMode ?? existing.fastMode) === 'boolean' ? { fastMode: patch.fastMode ?? existing.fastMode } : {}),
      };
      const serialized = JSON.stringify({
        ...(merged.model ? { model: merged.model } : {}),
        ...(merged.thinkingLevel ? { thinkingLevel: merged.thinkingLevel } : {}),
        ...(typeof merged.fastMode === 'boolean' ? { fastMode: merged.fastMode } : {}),
      });
      runtimePatch[sessionDefaultsConfigKey(workspace)] = serialized;
      runtimePatch[sessionDefaultsConfigKey(resolved)] = serialized;
    }
    if (Object.keys(runtimePatch).length === 0) return this.readSessionDefaults(workspace);
    if (!this.options.mergeRuntimeSettings && !this.options.runtimeConfigPath) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    await this.mergeRuntimeSettings(runtimePatch);
    return this.readSessionDefaults(workspace);
  }

  private async runtimeConfigSnapshot(): Promise<Record<string, string>> {
    if (this.options.runtimeConfigPath) {
      try {
        const parsed = JSON.parse(await readFile(this.options.runtimeConfigPath, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
      } catch {
        /* 文件还没建：返回空表，下面的内存回退照常工作 */
      }
    }
    return getRuntimeConfigSnapshot();
  }

  private async readRawRuntimeKey(key: string): Promise<string | undefined> {
    return (await this.runtimeConfigSnapshot())[key];
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
      // 模型 / 思考档（含 cycle）一律走 writeSessionPreference / cycleSessionPreference：
      // 直接调 SDK 只会写原生 model_change，canonical 存在后冷恢复会回旧值。
      case 'agent_set_model':
      case 'agent_cycle_model':
      case 'agent_set_thinking_level':
      case 'agent_cycle_thinking_level':
        throw new Error(`SESSION_PREFERENCE_ROUTED: ${command}`);
      case 'agent_get_available_models': return {
        models: s.modelRuntime.getAvailableSnapshot().map((m) => snapshotSessionModel(m) ?? m),
      };
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
  if (!live) {
    // 当前模型已从目录消失：保留旧引用与 canonical 请求值，让 unavailable / prompt guard 提示用户重选。
    // 不能自动退到 snapshot[0]——那会把用户保存的模型静默改掉，模型回到目录后也恢复不过来（T15）。
    return;
  }
  // 同一模型换的是档位映射等配置。setModel 会往会话里再记一条模型切换，这里只换引用。
  const state = handle.session.state;
  if (state.model !== live) state.model = live;
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

/** 会话管理器内部的 leaf 指针（SDK 私有字段，拿不到就不回滚 leaf）。 */
interface ManagerInternals {
  fileEntries?: unknown[];
  byId?: Map<string, unknown>;
  leafId?: string | null;
}

function managerInternals(manager: unknown): ManagerInternals | undefined {
  return manager && typeof manager === 'object' ? (manager as ManagerInternals) : undefined;
}

/** 追加前记下 leaf：落盘失败时要把指针还原，不能停在一条不存在的条目上。 */
function readManagerLeaf(manager: unknown): string | null | undefined {
  return managerInternals(manager)?.leafId;
}

/**
 * 撤掉一条“内存里已经加进去、但没落盘成功”的偏好条目。
 *
 * SDK 的 `_appendEntry` 顺序是 fileEntries.push → byId.set → leafId = id → _persist，
 * 所以 `_persist` 抛错后内存里仍留着这条。这里按 customType 找到它并从内存三处一起摘掉；
 * 找不到（例如 SDK 换了实现）就不动，绝不误删别的条目。
 */
function rollbackPreferenceEntry(
  manager: unknown,
  requested: SessionPreferences,
  leafBefore: string | null | undefined,
): void {
  const internals = managerInternals(manager);
  const entries = internals?.fileEntries;
  if (!Array.isArray(entries) || entries.length === 0) return;
  const last = entries[entries.length - 1] as { id?: string; type?: string; customType?: string; data?: unknown } | undefined;
  if (!last || last.type !== 'custom' || last.customType !== SESSION_PREFERENCES_ENTRY) return;
  // 只撤“这一次写进去的那条”：同样 revision 的旧条目不该被误删（新条目 revision 必然更大）。
  const data = last.data as { revision?: number } | undefined;
  if (data?.revision !== requested.revision) return;
  entries.pop();
  if (last.id) internals?.byId?.delete(last.id);
  if (internals && leafBefore !== undefined) internals.leafId = leafBefore ?? null;
}

/** 从会话管理器读条目（不支持时返回空）。 */
function entriesOf(
  manager: { getEntries?: () => unknown[] } | undefined,
): SessionPreferenceEntry[] {
  const entries = typeof manager?.getEntries === 'function' ? manager.getEntries() : [];
  return (Array.isArray(entries) ? entries : []) as SessionPreferenceEntry[];
}

/** 合并两组不可用字段，去重并保持字段顺序。 */
function mergeUnavailable(
  left: readonly SessionPreferenceField[],
  right: readonly SessionPreferenceField[],
): SessionPreferenceField[] {
  const out: SessionPreferenceField[] = [];
  for (const field of [...left, ...right]) if (!out.includes(field)) out.push(field);
  return out;
}

function safeJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** 与 SDK 的 clampThinkingLevel 同规则：不支持时向更高档找，再向更低档找，最后 off。 */
function clampThinkingLevel(model: unknown, level: string): string | undefined {
  const levels = supportedThinkingLevels(model);
  if (levels.includes(level)) return level;
  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level as (typeof EXTENDED_THINKING_LEVELS)[number]);
  if (requestedIndex === -1) return levels[0] ?? 'off';
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? 'off';
}

/** 与 SDK 的 getSupportedThinkingLevels 同规则：非推理模型只有 off，xhigh/max 需显式映射。 */
const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
function supportedThinkingLevels(model: unknown): string[] {
  const item = model as { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> } | undefined;
  if (!item?.reasoning) return ['off'];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = item.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
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
