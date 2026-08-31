import { invoke } from '../platform/runtime';

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export const agentDataApi = {
  start: () => invoke<{ version: number }>('agentData_start'),
  status: () => invoke<AgentDataStatus>('agentData_status'),
  stop: () => invoke<void>('agentData_stop'),
};
