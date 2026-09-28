export type TaskRef = { source: 'user' | 'system'; id: string };
export type TaskStatus = 'pending' | 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type ResourceRef = { type: 'wiki' | 'project' | 'memory'; id: string };
export interface JobMetadata {
  target?: ResourceRef;
  payload?: { kbId: string; sourceIds: string[] } | { workspace: string };
  retryOf?: string; resourceName?: string; cancellationRequested?: boolean; cancellationError?: string;
  stage?: string; processed?: number; total?: number;
}
export interface TaskView {
  ref: TaskRef; key: string; kind: string; label: string; status: TaskStatus;
  workspace?: string; resource?: ResourceRef; resourceName?: string;
  progress?: number; stage?: string; cancellationRequested: boolean;
  processed?: number; total?: number; attempts?: number; retryOf?: string; error?: string;
  createdAt: number; updatedAt: number;
  capabilities: { cancel: boolean; retry: boolean; remove: boolean };
}
export interface TaskPage { items: TaskView[]; nextCursor?: string; activeCount?: number }
export interface TaskListInput {
  source?: TaskRef['source']; group?: 'active' | 'history'; workspace?: string;
  query?: string; cursor?: string; limit?: number;
}
export interface TaskDetail extends TaskView {
  inputSummary?: Record<string, unknown>; outputSummary?: Record<string, unknown>;
  events: Array<{ id: string; action: string; message: string; createdAt: number }>;
}
export interface TaskRetryPreview {
  ref: TaskRef; resource?: ResourceRef; label: string; callsModel: boolean;
  sourceIds?: string[]; targetCount?: number; model?: string;
}
export interface TaskRetryOptions { expectedModel?: string }
export interface AuditQuery {
  action?: string; resource?: ResourceRef; from?: number; to?: number; cursor?: string; limit?: number;
}
export interface AuditView {
  id: string; action: string; summary: string; resource?: ResourceRef; resourceName?: string;
  detail: Record<string, unknown>; createdAt: number;
}
export interface AuditPage { items: AuditView[]; nextCursor?: string }
export interface AuditExport { items: AuditView[]; limit: number; truncated: boolean }
export interface DiagnosticItem {
  id: string; resource?: ResourceRef; state: 'ok' | 'action_required' | 'unchecked';
  checkedAt: number; message: string; action?: 'open_file' | 'configure_codegraph'; path?: string;
}
export interface DiagnosticReport { items: DiagnosticItem[]; checkedAt: number }
export type ResourceNavigation =
  | { view: 'overview' }
  | { view: 'memory'; id?: string; mode?: 'read' | 'create' }
  | { view: 'wiki'; kbId?: string; pageId?: string; mode?: 'read' | 'create' }
  | { view: 'code'; workspace?: string; file?: string; line?: number }
  | { view: 'jobs'; task?: TaskRef }
  | { view: 'audit'; resource?: ResourceRef };
export interface WorkbenchOverview {
  libraries?: { total: number; pendingSources: number; pages: number };
  recentPages: Array<{ kbId: string; pageId: string; title: string; libraryName: string; updatedAt: number }>;
  recentMemories: Array<{ id: string; content: string; level: number; updatedAt: number; scope?: 'global' | 'project'; sourceProjectId?: string }>;
  activeTasks?: number; failedTasks?: number;
  diagnostics?: { actionRequired: number; unchecked: number };
  errors: Array<{ domain: 'wiki' | 'memory' | 'tasks' | 'diagnostics'; message: string }>;
}
