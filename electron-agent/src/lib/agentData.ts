import { invoke } from '../platform/runtime';

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export type AgentJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AgentJob { id: string; kind: string; workspace: string; state: AgentJobState; progress: number; error?: string; createdAt: number; updatedAt: number }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export interface MemoryScope { userId: string; workspace: string; sessionId?: string }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }
export interface CodeGraphStatus { workspace: string; connected: boolean; indexed: boolean; state?: string; files?: number; nodes?: number; edges?: number }
export interface AgentJobCreateInput { kind: string; workspace: string }

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
  },
  wiki: {
    overview: (workspace: string) => invoke<WikiOverview>('agentData_wiki_overview', { workspace }),
  },
  code: {
    status: (workspace: string) => invoke<CodeGraphStatus>('agentData_code_status', { workspace }),
  },
  config: {
    get: (module: string) => invoke<AgentConfig>('agentData_admin_config_get', { module }),
    update: (module: string, value: Record<string, unknown>, version: number) => invoke<AgentConfig>('agentData_admin_config_update', { module, value, version }),
  },
  audit: () => invoke<unknown[]>('agentData_admin_audit_list'),
  diagnostics: () => invoke<Record<string, unknown>>('agentData_admin_diagnostics'),
  export: () => invoke<Record<string, unknown>>('agentData_admin_export'),
  import: (data: Record<string, unknown>) => invoke<void>('agentData_admin_import', { data }),
};
