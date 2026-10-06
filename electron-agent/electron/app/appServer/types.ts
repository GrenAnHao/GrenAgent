export type ThreadStatus = 'active' | 'archived' | 'deleted';
export type TurnStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type ItemStatus = 'started' | 'streaming' | 'completed' | 'failed';

export interface Thread {
  id: string;
  projectId: string;
  workspace: string;
  title?: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
}

export interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  mode: 'interactive' | 'non-interactive';
  input: string;
  permissionProfile: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  sessionId?: string;
}

export type ItemType =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'error';

export interface Item {
  id: string;
  threadId: string;
  turnId: string;
  type: ItemType;
  status: ItemStatus;
  payload: unknown;
  createdAt: number;
  updatedAt?: number;
}

export interface PermissionProfile {
  filesystem: 'none' | 'workspace-read' | 'workspace-write' | 'unrestricted';
  network: 'none' | 'allowlist' | 'full';
  process: 'none' | 'allowlist' | 'full';
  secrets: 'none' | 'selected' | 'all';
  interaction: 'deny' | 'ask' | 'auto';
}

export type ServiceTaskCapability = 'llm_completion' | 'llm_embedding' | 'network' | 'filesystem_read';

export interface ServiceTaskDefinition {
  kind: string;
  inputSchema: unknown;
  outputSchema: unknown;
  capabilities: ServiceTaskCapability[];
  timeoutMs: number;
  maxAttempts: number;
}

export type ServiceTaskStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

/** 一次模型调用的用量回报。usage 是 pi-ai 的 Usage 原样对象，缺失或形状不对时按 0 记。 */
export interface ServiceTaskUsageReport {
  model?: string;
  usage: unknown;
}

/** TaskQueue 交给执行器的回调：每次模型调用（含失败的那次）都回报一次用量。 */
export interface ServiceTaskHooks {
  onUsage?: (report: ServiceTaskUsageReport) => void;
}

export interface ServiceTask {
  id: string;
  kind: string;
  sourceProjectId?: string;
  sourceSessionId?: string;
  status: ServiceTaskStatus;
  input: unknown;
  output?: unknown;
  attempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
