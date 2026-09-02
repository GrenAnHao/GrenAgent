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

export type AppEventType =
  | 'thread.created'
  | 'thread.updated'
  | 'turn.queued'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'item.created'
  | 'item.updated'
  | 'item.delta'
  | 'permission.requested'
  | 'permission.resolved'
  | 'task.queued'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'plugin.state_changed'
  | 'mcp.state_changed'
  | 'memory.updated';

export interface AppEvent {
  id: string;
  type: AppEventType;
  sequence: number;
  timestamp: number;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  data: unknown;
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
