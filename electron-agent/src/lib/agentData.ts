import { invoke } from '../platform/runtime';

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export interface AgentJob { id: string; kind: string; workspace: string; state: string; progress: number; error?: string; createdAt: number; updatedAt: number }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export const agentDataApi = {
  start: () => invoke<{ version: number }>('agentData_start'),
  status: () => invoke<AgentDataStatus>('agentData_status'),
  stop: () => invoke<void>('agentData_stop'),
  jobs: {
    list: () => invoke<AgentJob[]>('agentData_admin_jobs_list'),
    get: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_get', { id }),
    cancel: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_cancel', { id }),
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
