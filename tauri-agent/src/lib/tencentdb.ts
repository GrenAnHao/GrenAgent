import { invoke } from '@tauri-apps/api/core';

export type TencentdbMode = 'local' | 'remote';
export type TencentdbConnectionState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface TencentdbConnectionConfig {
  mode: TencentdbMode;
  endpoint: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  lastSuccessAt?: string;
}

export interface TencentdbStatus {
  mode: TencentdbMode;
  endpoint: string;
  state: TencentdbConnectionState;
  credentialConfigured: boolean;
  lastSuccessAt?: string;
}

export interface SaveTencentdbConnection {
  config: TencentdbConnectionConfig;
  gatewayApiKey?: string;
  clearGatewayApiKey?: boolean;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
}

export const tencentdbApi = {
  status: () => invoke<TencentdbStatus>('tencentdb_get_status'),
  save: (input: SaveTencentdbConnection) =>
    invoke<TencentdbStatus>('tencentdb_save_connection', { input }),
  test: () => invoke<TencentdbStatus>('tencentdb_test_connection'),
  startLocal: () => invoke<TencentdbStatus>('tencentdb_start_local'),
  stopLocal: () => invoke<TencentdbStatus>('tencentdb_stop_local'),
};
