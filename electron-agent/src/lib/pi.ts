import { Channel, invoke, listen, type UnlistenFn } from '../platform/runtime';
import type { SessionStats } from './sessionStats';
export type { SessionStats } from './sessionStats';
import type { UsageReport } from './usageReport';
export type { UsageReport } from './usageReport';
import type { PackageListItem, PackageSearchResult } from '../../electron/app/piPackageModel';
export type { PackageListItem, PackageSearchResult, MarketplaceHit } from '../../electron/app/piPackageModel';
import type { AskUserDraft } from '../../electron/agent/askUserDraft';
import type { DevinAccountView } from './devinAccount';
export type { DevinAccountView } from './devinAccount';
export type PackageInstallScope = 'user' | 'project';

export interface PiEventEnvelope {
  workspace: string;
  event: AgentEvent;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal' | 'subagent';
}
export interface PiUiRequestEnvelope {
  workspace: string;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
  request: ExtensionUiRequest;
}
export interface PiExitEnvelope {
  workspace: string;
  code: number | null;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: unknown[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message?: AgentMessage; assistantMessageEvent: AssistantMessageEvent; usage?: unknown }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown; parentToolCallId?: string }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean; parentToolCallId?: string }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: string }
  | { type: 'compaction_end'; reason: string; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; error: string }
  | { type: string; [k: string]: unknown };

export interface AgentMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content: unknown;
  [k: string]: unknown;
}
export type ToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
export type AssistantMessageEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'toolcall_start'; contentIndex: number; id?: string; toolName?: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; id?: string; toolName?: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallBlock }
  | { type: string; [k: string]: unknown };

export interface ExtensionUiRequest {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  source?: 'extension' | 'permission';
  /** 宿主最多等多少毫秒；到点它会发 dismiss 收回这条请求。 */
  timeout?: number;
  /** 子代理经父会话问人时带上（extensions/_shared/approval-route.ts），顶层在前。 */
  subagents?: Array<{ agentId: string; label: string }>;
  [k: string]: unknown;
}

export interface OpenWorkspaceResult {
  restoredSession: string | null;
  sessionFile: string | null;
  sessionId?: string | null;
}

export interface ImageItem {
  name: string;
  bytes: number;
  modifiedMs: number;
}

export interface ProviderConfigPayload {
  modelsJson: string | null;
  authJson: string | null;
  agentDir: string;
}

export type McpConfigScope = 'settings' | 'global' | 'project';

export interface ManagedMcpConfig {
  name: string;
  config: object;
  enabled: boolean;
  scope: McpConfigScope;
}
export interface RefreshResult {
  refreshed: string[];
  failed: { workspace: string; error: string }[];
}

export interface DiagnoseRequest {
  /** 取消时按它找到这一次请求。 */
  requestId: string;
  providerId: string;
  modelId: string;
  prompt: string;
  /** true：输出边到边推送；false：完成后一次给全文。 */
  stream: boolean;
  /** pi 思考档（minimal…max）；不传 = 关闭。 */
  reasoning?: string;
}

export interface DiagnoseChunk {
  type: 'text' | 'thinking';
  text: string;
}

export interface DiagnoseResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string | null;
  content: string;
  thinking?: string;
  ttftMs: number;
  totalMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  tokensPerSec?: number | null;
}

export interface EnhancePromptResult {
  ok: boolean;
  content: string;
  error?: string;
  cancelled?: boolean;
}

export interface SubAgentItem {
  id: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | string;
  model?: string | null;
  /** 子会话实际运行的思考档位（pi 档位名）。embedded 子代理起会话后才有。 */
  thinkingLevel?: string | null;
  /** 子进程会话文件已写出时才算真正跑起来。没有它时界面显示启动中。 */
  sessionPath?: string | null;
  /** 已解析能力档案 JSON（含 fs/name），前端据此推断「类型（只读/工作）」。 */
  profile?: string | null;
  output?: string | null;
  error?: string | null;
  exitCode?: number | null;
  /** 原始 `--mode json` JSONL transcript（运行期增量写入），前端据此实时回放子代理完整工具调用+文本流。 */
  transcript?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SubagentCatalogMode = 'one-shot' | 'continuable';
export type CatalogActivity = 'running' | 'idle' | 'ready' | 'settled' | 'unavailable';
export type SubagentDelivery = 'followUp' | 'steer';

export interface SubagentCatalogEntry {
  id: string;
  sessionPath: string;
  createdAt: number;
  mode: SubagentCatalogMode;
  label: string;
}

export interface SubagentCatalogView {
  entries: SubagentCatalogEntry[];
  diagnostics: Array<{ id: string; reason: 'corrupt' }>;
}

export interface CatalogRowView extends SubagentCatalogEntry {
  activity: CatalogActivity;
  hasChildren: boolean;
  tokens?: number;
  durationMs?: number;
  diagnostic?: 'corrupt' | 'unavailable';
}

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'staged' | 'untracked' | string;
}
export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}
export interface GitBranches {
  current: string;
  branches: BranchInfo[];
}
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  subject: string;
  timestamp: number;
  refs: string[];
}

/** 同项目多份会话同时在跑时，主进程按这个 jsonl 找到对应的 handle。缺省打到前景会话。 */
function target(sessionPath?: string | null): { targetSessionPath?: string } {
  return sessionPath ? { targetSessionPath: sessionPath } : {};
}

export const pi = {
  openWorkspace:(workspace: string) =>
    invoke<OpenWorkspaceResult>('open_workspace', { workspace }),
  closeWorkspace: (workspace: string) => invoke<void>('close_workspace', { workspace }),
  warmWorkspace: (workspace: string) => invoke<void>('warm_workspace', { workspace }),
  prompt: (
    workspace: string,
    message: string,
    streamingBehavior?: 'steer' | 'followUp',
    images?: Array<{ type: 'image'; mimeType: string; data: string }>,
    targetSessionPath?: string | null,
  ) =>
    invoke<unknown>('agent_prompt', {
      workspace,
      message,
      images: images?.length ? images : undefined,
      streamingBehavior,
      ...target(targetSessionPath),
    }),
  abort: (workspace: string, targetSessionPath?: string | null) =>
    invoke<unknown>('agent_abort', { workspace, ...target(targetSessionPath) }),
  /** 暂停后取走尚未注入的引导，跟进队列原样放回。 */
  takeSteering: (workspace: string, targetSessionPath?: string | null) =>
    invoke<{ steering: string[] }>('agent_take_steering', { workspace, ...target(targetSessionPath) }),
  setModel: (workspace: string, provider: string, modelId: string) =>
    invoke<unknown>('agent_set_model', { workspace, provider, modelId }),
  cycleModel: (workspace: string) => invoke<unknown>('agent_cycle_model', { workspace }),
  getAvailableModels: (workspace: string) => invoke<unknown>('agent_get_available_models', { workspace }),
  setThinkingLevel: (workspace: string, level: string) =>
    invoke<unknown>('agent_set_thinking_level', { workspace, level }),
  /** 带会话路径时只改那份会话；草稿不带，改项目默认（新会话继承）。 */
  setMode: (workspace: string, mode: string, targetSessionPath?: string | null) =>
    invoke<unknown>('agent_set_mode', { workspace, mode, ...target(targetSessionPath) }),
  setApproval: (workspace: string, level: string, targetSessionPath?: string | null) =>
    invoke<unknown>('agent_set_approval', { workspace, level, ...target(targetSessionPath) }),
  /** 删任意段：把某条消息（按毫秒 timestamp）移出 LLM 上下文（对模型不可见、不删盘、可恢复）。 */
  excludeEntry: (workspace: string, timestamp: number) =>
    invoke<unknown>('agent_exclude_entry', { workspace, timestamp }),
  /** 恢复被移出上下文的消息。 */
  restoreEntry: (workspace: string, timestamp: number) =>
    invoke<unknown>('agent_restore_entry', { workspace, timestamp }),
  /** 回退到此：把会话回退到某条消息（按毫秒 timestamp）——后端读会话树把 timestamp 映射成 entry id 后 fork 出新分支并切换。 */
  rewindTo: (workspace: string, timestamp: number) =>
    invoke<unknown>('agent_rewind_to', { workspace, timestamp }),
  /**
   * 原地截断会话：按 entryId 删除目标（或仅其后继）并 reload。
   * mode: drop-target 连目标一起删；keep-target 保留目标只删后代。
   */
  truncateTo: (workspace: string, entryId: string, mode: 'drop-target' | 'keep-target') =>
    invoke<{ ok: true; lines: string[] } | { ok: false; reason: 'branched' | 'missing' }>('agent_truncate_to', {
      workspace,
      entryId,
      mode,
    }),
  /**
   * 直接按 entry id fork 出新分支（保留原路径，符合会话树模型）。
   * 预留给后续 Phase（手动 fork / 编辑后重生成）：当前前端无调用方，对应后端 command 已存在并注册。
   */
  fork: (workspace: string, entryId: string) =>
    invoke<unknown>('agent_fork', { workspace, entryId }),
  /**
   * 预览 fork 后将保留的消息。
   * 预留给后续 Phase（回退 / 编辑前预览）：当前前端无调用方，对应后端 command 已存在并注册。
   */
  getForkMessages: (workspace: string) =>
    invoke<{ messages: AgentMessage[] }>('agent_get_fork_messages', { workspace }),
  compact: (workspace: string) => invoke<unknown>('agent_compact', { workspace }),
  getState: (workspace: string, targetSessionPath?: string | null) =>
    invoke<unknown>('agent_get_state', { workspace, ...target(targetSessionPath) }),
  /** 主进程仍在跑的交互回合。渲染进程热更新后用来恢复停止按钮和侧边栏运行态。 */
  listRunningTurns: () =>
    invoke<Array<{ workspace: string; sessionId?: string; sessionPath?: string }>>('agent_list_running_turns'),
  getMessages: (workspace: string, targetSessionPath?: string | null) =>
    invoke<{ messages: AgentMessage[] }>('agent_get_messages', { workspace, ...target(targetSessionPath) }),
  newSession: (workspace: string) => invoke<unknown>('agent_new_session', { workspace }),
  switchSession: (workspace: string, sessionPath: string) =>
    invoke<unknown>('agent_switch_session', { workspace, sessionPath }),
  listSessions: (workspace: string) => invoke<SessionInfo[]>('list_pi_sessions', { workspace }),
  listAllSessions: () => invoke<SessionInfo[]>('list_all_sessions'),
  /** 已打开但可能还没有会话文件的项目目录。 */
  listProjects: () => invoke<string[]>('list_projects'),
  setSessionName: (workspace: string, name: string) =>
    invoke<unknown>('agent_set_session_name', { workspace, name }),
  setSessionDisplayName: (sessionPath: string, name: string) =>
    invoke<void>('set_session_display_name', { sessionPath, name }),
  deleteSession: (workspace: string, sessionPath: string) =>
    invoke<void>('delete_pi_session', { workspace, sessionPath }),
  createConversation: () => invoke<{ cwd: string }>('create_conversation'),
  getWorksDir: () => invoke<string>('get_works_dir'),
  /** 清理 works 下所有无会话的孤儿对话目录（保留 keep 列表）；返回删除条数。 */
  pruneOrphanConversations: (keep: string[]) =>
    invoke<number>('prune_orphan_conversations', { keep }),
  deleteConversation: (workspace: string) =>
    invoke<void>('delete_conversation', { workspace }),
  removeProject: (workspace: string) =>
    invoke<void>('remove_project', { workspace }),
  respondUi: (workspace: string, response: Record<string, unknown>) =>
    invoke<void>('extension_ui_respond', { workspace, response }),
  resolvePermission: (id: string, resolution: 'allow' | 'deny') =>
    invoke<unknown>('permission_resolve', { requestId: id, resolution }),
  getSessionStats: (workspace: string, targetSessionPath?: string | null) =>
    invoke<SessionStats>('agent_get_session_stats', { workspace, ...target(targetSessionPath) }),
  readAskUserDraft: (workspace: string, toolCallId: string) =>
    invoke<AskUserDraft | null>('ask_user_draft_read', { workspace, toolCallId }),
  writeAskUserDraft: (workspace: string, draft: AskUserDraft) =>
    invoke<void>('ask_user_draft_write', { workspace, draft }),
  deleteAskUserDraft: (workspace: string) =>
    invoke<void>('ask_user_draft_delete', { workspace }),
  completeAskUser: (workspace: string, toolCallId: string, value?: string, cancelled?: boolean) =>
    invoke<'ok' | 'duplicate'>('agent_complete_ask_user', { workspace, toolCallId, value, cancelled }),
  getUsageReport: () => invoke<UsageReport>('usage_report'),
  getCommands: (workspace: string) => invoke<unknown>('agent_get_commands', { workspace }),
  createList: (workspace: string) => invoke<ImageItem[]>('create_list', { workspace }),
  createImage: (workspace: string, name: string) =>
    invoke<string>('create_image', { workspace, name }),
  getSettings: () => invoke<Record<string, string>>('get_settings'),
  devinAccountStatus: () => invoke<DevinAccountView>('devin_account_status'),
  devinAccountLogin: () => invoke<DevinAccountView>('devin_account_login'),
  devinAccountLogout: () => invoke<DevinAccountView>('devin_account_logout'),
  setSettings: (settings: Record<string, string>) =>
    invoke<void>('set_settings', { settings }),
  listMcpConfigs: (workspace: string) =>
    invoke<ManagedMcpConfig[]>('list_mcp_configs', { workspace }),
  packageList: (workspace: string) =>
    invoke<PackageListItem[]>('package_list', { workspace }),
  packageSearch: (query: string) =>
    invoke<PackageSearchResult>('package_search', { query }),
  packageInstall: (workspace: string, name: string, version: string, scope: PackageInstallScope) =>
    invoke<void>('package_install', { workspace, name, version, scope }),
  packageRemove: (workspace: string, source: string, scope: PackageInstallScope) =>
    invoke<void>('package_remove', { workspace, source, scope }),
  packageSetEnabled: (workspace: string, source: string, scope: PackageInstallScope, enabled: boolean) =>
    invoke<void>('package_set_enabled', { workspace, source, scope, enabled }),
  upsertMcpConfig: (
    workspace: string,
    scope: McpConfigScope,
    name: string,
    config: object,
    enabled: boolean,
  ) => invoke<void>('upsert_mcp_config', { workspace, scope, name, config, enabled }),
  removeMcpConfig: (workspace: string, scope: McpConfigScope, name: string) =>
    invoke<void>('remove_mcp_config', { workspace, scope, name }),
  reloadMcpServer: (workspace: string, name: string) =>
    invoke<void>('reload_mcp_server', { workspace, name }),
  getProviderConfig: () => invoke<ProviderConfigPayload>('get_provider_config'),
  setProviderConfig: (modelsJson: string, authJson: string) =>
    invoke<RefreshResult>('set_provider_config', { modelsJson, authJson }),
  refreshModelRegistry: () => invoke<RefreshResult>('refresh_model_registry'),
  fetchProviderModels: (baseUrl: string, apiKey: string, api: string, headers?: Record<string, string>) =>
    invoke<string[]>('fetch_provider_models', { baseUrl, apiKey, api, headers }),
  /** 项目无关地列出运行时解析后的模型（probe-models 子命令）：未打开项目 / 冷启动 / 真对话模式可用。 */
  listModelsGlobal: () => invoke<unknown>('list_models_global'),
  /** Mermaid 渲染失败时的非流式一次性修复：用当前会话模型生成修正后的 mermaid 代码（不进对话历史）。 */
  fixMermaid: (workspace: string, code: string, error: string) =>
    invoke<string>('fix_mermaid_diagram', { workspace, code, error }),
  diagnoseProviderModel: (request: DiagnoseRequest, onChunk: Channel<DiagnoseChunk>) =>
    invoke<DiagnoseResult>('diagnose_provider_model', { ...request, onChunk }),
  abortDiagnoseProviderModel: (requestId: string) => invoke<void>('diagnose_provider_model_abort', { requestId }),
  enhancePrompt: (workspace: string, text: string, onChunk: Channel<string>, goalText?: string) =>
    invoke<EnhancePromptResult>('enhance_prompt', { workspace, text, onChunk, goalText }),
  abortEnhancePrompt: (workspace: string) => invoke<void>('enhance_prompt_abort', { workspace }),
  /** 给了 sessionPath 只列这份会话派出去的子代理（含孙级）；不给列整个项目。 */
  subagentList: (workspace: string, sessionPath?: string | null) =>
    invoke<SubAgentItem[]>('subagent_list', { workspace, ...(sessionPath ? { sessionPath } : {}) }),
  /** 按需拉取单个子代理的完整 JSONL transcript（打开详情面板时调用，不在轮询路径中）。 */
  subagentGetTranscript: (workspace: string, agentId: string) =>
    invoke<string | null>('subagent_get_transcript', { workspace, agentId }),
  subagentGetSessionMessages: (sessionPath: string) =>
    invoke<{ messages: AgentMessage[] }>('subagent_get_session_messages', { sessionPath }),
  subagentCancel: (workspace: string, agentId: string) =>
    invoke<void>('subagent_cancel', { workspace, agentId }),
  /** 后台 job 当前保留的输出与状态；job 不在（重启、已清理）时是 null。 */
  jobSnapshot: (jobId: string, startedAt: number) =>
    invoke<JobLiveSnapshot | null>('job_snapshot', { jobId, startedAt }),
  /** 用户停止后台 job（原因记为 cancelled by the user，模型会收到结算通知）。 */
  jobKill: (jobId: string, startedAt: number) =>
    invoke<'requested' | 'already-finished' | 'not-found'>('job_kill', { jobId, startedAt }),
  subagentCatalog: (parentSessionPath: string) =>
    invoke<SubagentCatalogView>('subagent_catalog', { parentSessionPath }),
  subagentCatalogRow: (sessionPath: string) =>
    invoke<CatalogRowView>('subagent_catalog_row', { sessionPath }),
  subagentPrompt: (
    workspace: string,
    parentSessionPath: string,
    sessionPath: string,
    message: string,
    delivery: SubagentDelivery,
  ) => invoke<void>('subagent_prompt', { workspace, parentSessionPath, sessionPath, message, delivery }),
  subagentInterrupt: (workspace: string, parentSessionPath: string, sessionPath: string) =>
    invoke<void>('subagent_interrupt', { workspace, parentSessionPath, sessionPath }),
  readUiHistory: (workspace: string, sessionKey: string) =>
    invoke<string>('ui_history_read', { workspace, sessionKey }),
  writeUiHistory: (workspace: string, sessionKey: string, content: string) =>
    invoke<void>('ui_history_write', { workspace, sessionKey, content }),
  deleteUiHistory: (workspace: string, sessionKey: string) =>
    invoke<void>('ui_history_delete', { workspace, sessionKey }),
  runCommand: (workspace: string, command: string) =>
    invoke<unknown>('agent_prompt', { workspace, message: command }),
  readFile: (workspace: string, path: string) => invoke<string>('read_file', { workspace, path }),
  getGitDiff: (workspace: string, file: string) =>
    invoke<string>('get_git_diff', { workspacePath: workspace, filePath: file }),
  getGitStatus: (workspace: string) =>
    invoke<GitFileStatus[]>('get_git_status', { workspacePath: workspace }),
  getGitBranches: (workspace: string) =>
    invoke<GitBranches>('get_git_branches', { workspacePath: workspace }),
  gitCheckout: (workspace: string, branch: string) =>
    invoke<void>('git_checkout', { workspacePath: workspace, branch }),
  gitCreateBranch: (workspace: string, name: string, checkout = true) =>
    invoke<void>('git_create_branch', { workspacePath: workspace, name, checkout }),
  getGitLogGraph: (workspace: string, limit?: number, skip = 0) =>
    invoke<GitLogEntry[]>('get_git_log_graph', { workspacePath: workspace, limit: limit ?? null, skip }),
};

/**
 * 回传 extension UI 响应（confirm/select/input...）到 pi sidecar。
 * 形状须符合 pi RPC：{ type: "extension_ui_response", id, value|confirmed|cancelled }。
 */
export const extensionUiRespond = (workspace: string, response: Record<string, unknown>) =>
  pi.respondUi(workspace, response);

export const writeAskUserDraft = (workspace: string, draft: AskUserDraft) =>
  pi.writeAskUserDraft(workspace, draft);

export const deleteAskUserDraft = (workspace: string) => pi.deleteAskUserDraft(workspace);

export const completeAskUser = (
  workspace: string,
  toolCallId: string,
  value?: string,
  cancelled?: boolean,
) => pi.completeAskUser(workspace, toolCallId, value, cancelled);

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  name: string | null;
}

/** 后台 job 的界面投影（与 extensions/jobs/observer.ts 的 JobLiveView 同形）。 */
export interface JobLiveView {
  id: string;
  kind: string;
  label: string;
  owner: string;
  workspace: string;
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'killed';
  progress?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}
export interface JobFrame {
  job: JobLiveView;
  delta?: { from: number; text: string; next: number; lossy: boolean };
  removed?: true;
}
export interface JobLiveSnapshot {
  job: JobLiveView;
  text: string;
  next: number;
  lossy: boolean;
  spillPaths?: string[];
}
export function onJobFrames(handler: (e: { frames: JobFrame[] }) => void): Promise<UnlistenFn> {
  return listen<{ frames: JobFrame[] }>('pi://jobs', (e) => handler(e.payload));
}

export function onPiEvent(handler: (e: PiEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<PiEventEnvelope>('pi://event', (e) => handler(e.payload));
}
export function onPiUiRequest(handler: (e: PiUiRequestEnvelope) => void): Promise<UnlistenFn> {
  return listen<PiUiRequestEnvelope>('pi://ui-request', (e) => handler(e.payload));
}
export function onPiExit(handler: (e: PiExitEnvelope) => void): Promise<UnlistenFn> {
  return listen<PiExitEnvelope>('pi://exit', (e) => handler(e.payload));
}
