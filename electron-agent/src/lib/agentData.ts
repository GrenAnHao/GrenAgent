import { invoke } from '../platform/runtime';

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export type AgentJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AgentJob { id: string; kind: string; workspace: string; state: AgentJobState; progress: number; error?: string; createdAt: number; updatedAt: number }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export interface MemoryScope { userId: string; workspace?: string; projectId?: string; sessionId?: string; includeOtherProjects?: boolean }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }
export interface MemoryRecord { id: string; level: 0 | 1 | 2 | 3; content: string; source?: string; sourceProjectId?: string; scope?: 'global' | 'project'; createdAt: number; updatedAt: number }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }
export interface WikiSearchResult { page: string; title: string; snippet: string; sourcePath: string; chunks: number }
export interface CodeGraphStatus { workspace: string; connected: boolean; indexed: boolean; state?: string; files?: number; nodes?: number; edges?: number }
export interface CodeSearchResult { file: string; line?: number; symbol?: string; snippet?: string }
export interface AgentJobCreateInput { kind: string; workspace: string }
export interface AgentAuditEvent { id: string; action: string; detail: Record<string, unknown>; createdAt: number }
export interface AgentDiagnostics { jobs: { total: number; failed: number }; auditEvents: number }

export const agentDataApi = {
  start: () => invoke<{ version: number }>('agentData_start'),
  status: () => invoke<AgentDataStatus>('agentData_status'),
  stop: () => invoke<void>('agentData_stop'),
  jobs: {
    list: () => invoke<AgentJob[]>('agentData_admin_jobs_list'),
    get: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_get', { id }),
    cancel: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_cancel', { id }),
    create: (input: AgentJobCreateInput) => invoke<AgentJob>('agentData_jobs_create', input),
  },
  memory: {
    overview: (scope: MemoryScope) => invoke<MemoryOverview>('agentData_memory_overview', scope),
    search: (scope: MemoryScope, query: string, limit = 50) => invoke<MemoryRecord[]>('agentData_memory_search', { ...scope, query, limit }),
    delete: (scope: { userId: string; workspace: string }, id: string) => invoke<void>('agentData_memory_delete', { ...scope, id }),
  },
  wiki: {
    overview: (workspace: string) => invoke<WikiOverview>('agentData_wiki_overview', { workspace }),
    search: (workspace: string, query: string, limit = 50) => invoke<WikiSearchResult[]>('agentData_wiki_search', { workspace, query, limit }),
  },
  code: {
    status: (workspace: string) => invoke<CodeGraphStatus>('agentData_code_status', { workspace }),
    search: (workspace: string, query: string, limit = 20) => invoke<{ workspace: string; available: boolean; results: CodeSearchResult[]; message?: string }>('agentData_code_search', { workspace, query, limit }),
  },
  config: {
    get: (module: string) => invoke<AgentConfig>('agentData_admin_config_get', { module }),
    update: (module: string, value: Record<string, unknown>, version: number) => invoke<AgentConfig>('agentData_admin_config_update', { module, value, version }),
  },
  audit: () => invoke<AgentAuditEvent[]>('agentData_admin_audit_list'),
  diagnostics: () => invoke<AgentDiagnostics>('agentData_admin_diagnostics'),
  export: () => invoke<Record<string, unknown>>('agentData_admin_export'),
  import: (data: Record<string, unknown>) => invoke<void>('agentData_admin_import', { data }),
};
