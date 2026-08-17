import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionStats } from './sessionStats';
export type { SessionStats } from './sessionStats';
import type { UsageReport } from './usageReport';
export type { UsageReport } from './usageReport';

export interface PiEventEnvelope {
  workspace: string;
  event: AgentEvent;
}
export interface PiUiRequestEnvelope {
  workspace: string;
  request: ExtensionUiRequest;
}
export interface PiExitEnvelope {
  workspace: string;
  code: number | null;
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: unknown[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
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
export type AssistantMessageEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: string; [k: string]: unknown };

export interface ExtensionUiRequest {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  [k: string]: unknown;
}

export interface OpenWorkspaceResult {
  restoredSession: string | null;
  sessionFile: string | null;
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
export interface RefreshResult {
  refreshed: string[];
  failed: { workspace: string; error: string }[];
}

export interface DiagnoseResult {
  ok: boolean;
  error?: string | null;
  content: string;
  ttftMs: number;
  totalMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  tokensPerSec?: number | null;
}

export interface SubAgentItem {
  id: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | string;
  model?: string | null;
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

export const pi = {
  openWorkspace: (workspace: string) =>
    invoke<OpenWorkspaceResult>('open_workspace', { workspace }),
  closeWorkspace: (workspace: string) => invoke<void>('close_workspace', { workspace }),
  warmWorkspace: (workspace: string) => invoke<void>('warm_workspace', { workspace }),
  prompt: (
    workspace: string,
    message: string,
    streamingBehavior?: 'steer' | 'followUp',
    images?: Array<{ type: 'image'; mimeType: string; data: string }>,
  ) =>
    invoke<unknown>('agent_prompt', {
      workspace,
      message,
      images: images?.length ? images : undefined,
      streamingBehavior,
    }),
  abort: (workspace: string) => invoke<unknown>('agent_abort', { workspace }),
  setModel: (workspace: string, provider: string, modelId: string) =>
    invoke<unknown>('agent_set_model', { workspace, provider, modelId }),
  cycleModel: (workspace: string) => invoke<unknown>('agent_cycle_model', { workspace }),
  getAvailableModels: (workspace: string) => invoke<unknown>('agent_get_available_models', { workspace }),
  setThinkingLevel: (workspace: string, level: string) =>
    invoke<unknown>('agent_set_thinking_level', { workspace, level }),
  setMode: (workspace: string, mode: string) => invoke<unknown>('agent_set_mode', { workspace, mode }),
  setApproval: (workspace: string, level: string) =>
    invoke<unknown>('agent_set_approval', { workspace, level }),
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
  getState: (workspace: string) => invoke<unknown>('agent_get_state', { workspace }),
  getMessages: (workspace: string) => invoke<{ messages: AgentMessage[] }>('agent_get_messages', { workspace }),
  newSession: (workspace: string) => invoke<unknown>('agent_new_session', { workspace }),
  switchSession: (workspace: string, sessionPath: string) =>
    invoke<unknown>('agent_switch_session', { workspace, sessionPath }),
  listSessions: (workspace: string) => invoke<SessionInfo[]>('list_pi_sessions', { workspace }),
  listAllSessions: () => invoke<SessionInfo[]>('list_all_sessions'),
  setSessionName: (workspace: string, name: string) =>
    invoke<unknown>('agent_set_session_name', { workspace, name }),
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
  getSessionStats: (workspace: string) =>
    invoke<SessionStats>('agent_get_session_stats', { workspace }),
  getUsageReport: () => invoke<UsageReport>('usage_report'),
  getCommands: (workspace: string) => invoke<unknown>('agent_get_commands', { workspace }),
  createList: (workspace: string) => invoke<ImageItem[]>('create_list', { workspace }),
  createImage: (workspace: string, name: string) =>
    invoke<string>('create_image', { workspace, name }),
  getSettings: () => invoke<Record<string, string>>('get_settings'),
  setSettings: (settings: Record<string, string>) =>
    invoke<void>('set_settings', { settings }),
  getProviderConfig: () => invoke<ProviderConfigPayload>('get_provider_config'),
  setProviderConfig: (modelsJson: string, authJson: string) =>
    invoke<RefreshResult>('set_provider_config', { modelsJson, authJson }),
  refreshModelRegistry: () => invoke<RefreshResult>('refresh_model_registry'),
  fetchProviderModels: (baseUrl: string, apiKey: string, api: string) =>
    invoke<string[]>('fetch_provider_models', { baseUrl, apiKey, api }),
  /** 项目无关地列出运行时解析后的模型（probe-models 子命令）：未打开项目 / 冷启动 / 真对话模式可用。 */
  listModelsGlobal: () => invoke<unknown>('list_models_global'),
  /** Mermaid 渲染失败时的非流式一次性修复：用当前会话模型生成修正后的 mermaid 代码（不进对话历史）。 */
  fixMermaid: (workspace: string, code: string, error: string) =>
    invoke<string>('fix_mermaid_diagram', { workspace, code, error }),
  diagnoseProviderModel: (providerId: string, modelId: string, prompt: string, stream: boolean, onChunk: Channel<string>) =>
    invoke<DiagnoseResult>('diagnose_provider_model', { providerId, modelId, prompt, stream, onChunk }),
  subagentList: (workspace: string) => invoke<SubAgentItem[]>('subagent_list', { workspace }),
  /** 按需拉取单个子代理的完整 JSONL transcript（打开详情面板时调用，不在轮询路径中）。 */
  subagentGetTranscript: (workspace: string, agentId: string) =>
    invoke<string | null>('subagent_get_transcript', { workspace, agentId }),
  subagentCancel: (workspace: string, agentId: string) =>
    invoke<void>('subagent_cancel', { workspace, agentId }),
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
  getGitLogGraph: (workspace: string, limit?: number) =>
    invoke<GitLogEntry[]>('get_git_log_graph', { workspacePath: workspace, limit: limit ?? null }),
};

/**
 * 回传 extension UI 响应（confirm/select/input...）到 pi sidecar。
 * 形状须符合 pi RPC：{ type: "extension_ui_response", id, value|confirmed|cancelled }。
 */
export const extensionUiRespond = (workspace: string, response: Record<string, unknown>) =>
  pi.respondUi(workspace, response);

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  name: string | null;
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
