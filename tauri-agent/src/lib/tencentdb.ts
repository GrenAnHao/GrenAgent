import { invoke } from '@tauri-apps/api/core';

export type TencentdbMode = 'local' | 'remote';
export type TencentdbConnectionState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface TencentdbConnectionConfig {
  mode: TencentdbMode;
  endpoint: string;
  knowledgeEndpoint?: string;
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
  knowledgeEndpoint?: string;
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

export type TencentdbMigrationState =
  | 'scanned'
  | 'preview'
  | 'executing'
  | 'verifying'
  | 'migrated'
  | 'verified'
  | 'archived'
  | 'manual'
  | 'failed';

export type TencentdbMigrationSourceKind = 'memory_sqlite' | 'session_jsonl' | 'skill' | 'wiki' | 'code_graph';

export type TencentdbManualResolutionKind = 'external_completed' | 'explicit_waived';

export interface TencentdbManualResolution {
  kind: TencentdbManualResolutionKind;
  note: string;
  resolvedAt: string;
}

export interface TencentdbMigrationItem {
  sourceId: string;
  sourceKind: TencentdbMigrationSourceKind;
  sourcePath: string;
  state: TencentdbMigrationState;
  itemCount: number;
  byteCount: number;
  migratedCount: number;
  targetId?: string | null;
  error?: string | null;
  retryable: boolean;
  metadata: Record<string, string>;
  manualResolution?: TencentdbManualResolution | null;
}

export interface TencentdbVerificationReport {
  gatewayHealthy: boolean;
  knowledgeHealthy: boolean;
  knowledgeReady: boolean;
  countsMatch: boolean;
  sampleQuery: boolean;
  piRecall: boolean;
  passed: boolean;
  errors: string[];
  checkedAt: string;
}

export interface TencentdbMigrationBatch {
  sourceId: string;
  targetId?: string | null;
  count: number;
  errors: string[];
  retryable: boolean;
}

export interface TencentdbMigrationReport {
  runId: string;
  workspace: string;
  state: TencentdbMigrationState;
  items: TencentdbMigrationItem[];
  totalCount: number;
  manualCount: number;
  updatedAt: string;
}

export interface TencentdbMigrationRun {
  report: TencentdbMigrationReport;
  /** Added after the initial migration run format; old JSON may omit it. */
  batches?: TencentdbMigrationBatch[];
  /** Optional server-side echo; the wizard also persists this locally. */
  selectedIds?: string[] | null;
  verification?: TencentdbVerificationReport | null;
  archivedAt?: string | null;
}

export const tencentdbApi = {
  config: () => invoke<TencentdbConnectionConfig>('tencentdb_get_config'),
  status: () => invoke<TencentdbStatus>('tencentdb_get_status'),
  save: (input: SaveTencentdbConnection) =>
    invoke<TencentdbStatus>('tencentdb_save_connection', { input }),
  test: () => invoke<TencentdbStatus>('tencentdb_test_connection'),
  startLocal: () => invoke<TencentdbStatus>('tencentdb_start_local'),
  stopLocal: () => invoke<TencentdbStatus>('tencentdb_stop_local'),
  migrationStatus: (workspace?: string) =>
    invoke<TencentdbMigrationRun | null>('tencentdb_migration_status', { workspace: workspace ?? null }),
  migrationScan: (workspace?: string) => invoke<TencentdbMigrationRun>('tencentdb_migration_scan', { workspace: workspace ?? null }),
  migrationPreview: (workspace?: string) =>
    invoke<TencentdbMigrationRun>('tencentdb_migration_preview', { workspace: workspace ?? null }),
  migrationExecute: (workspace?: string, selectedIds?: string[]) =>
    invoke<TencentdbMigrationRun>('tencentdb_migration_execute', {
      workspace: workspace ?? null,
      selectedIds: selectedIds ?? null,
    }),
  migrationVerify: (workspace?: string) =>
    invoke<TencentdbMigrationRun>('tencentdb_migration_verify', { workspace: workspace ?? null }),
  migrationArchive: (workspace?: string) =>
    invoke<TencentdbMigrationRun>('tencentdb_migration_archive', { workspace: workspace ?? null }),
  migrationResolveManual: (
    workspace: string | undefined,
    runId: string,
    sourceId: string,
    kind: TencentdbManualResolutionKind,
    note: string,
  ) => invoke<TencentdbMigrationRun>('tencentdb_migration_resolve_manual', {
    workspace: workspace ?? null,
    runId,
    sourceId,
    kind,
    note,
  }),
};
