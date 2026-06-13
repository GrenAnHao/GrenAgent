import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionStats } from './sessionStats';
export type { SessionStats } from './sessionStats';

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

export interface KbStats {
  chunks: number;
  sources: number;
  model: string | null;
}
export interface KbSource {
  source: string;
  chunks: number;
}
export interface KbChunk {
  id: string;
  text: string;
}
export interface MemStats {
  project: number;
  global: number;
}
export interface MemItem {
  id: string;
  text: string;
  category: string | null;
  createdAt: number;
  scope: 'project' | 'global';
}
export interface ReviewNote {
  id: string;
  file: string;
  line: number | null;
  severity: string;
  message: string;
  createdAt: number;
}
export interface ImageItem {
  name: string;
  bytes: number;
  modifiedMs: number;
}

export const pi = {
  openWorkspace: (workspace: string) =>
    invoke<OpenWorkspaceResult>('open_workspace', { workspace }),
  closeWorkspace: (workspace: string) => invoke<void>('close_workspace', { workspace }),
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
  respondUi: (workspace: string, response: Record<string, unknown>) =>
    invoke<void>('extension_ui_respond', { workspace, response }),
  getSessionStats: (workspace: string) =>
    invoke<SessionStats>('agent_get_session_stats', { workspace }),
  getCommands: (workspace: string) => invoke<unknown>('agent_get_commands', { workspace }),
  kbStats: (workspace: string) => invoke<KbStats>('kb_stats', { workspace }),
  kbSources: (workspace: string) => invoke<KbSource[]>('kb_sources', { workspace }),
  kbChunks: (workspace: string, source: string) =>
    invoke<KbChunk[]>('kb_chunks', { workspace, source }),
  memStats: (workspace: string) => invoke<MemStats>('mem_stats', { workspace }),
  memList: (workspace: string) => invoke<MemItem[]>('mem_list', { workspace }),
  rvList: (workspace: string) => invoke<ReviewNote[]>('rv_list', { workspace }),
  createList: (workspace: string) => invoke<ImageItem[]>('create_list', { workspace }),
  createImage: (workspace: string, name: string) =>
    invoke<string>('create_image', { workspace, name }),
};

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
