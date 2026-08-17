import { invoke } from '@tauri-apps/api/core';

export type TencentdbMode = 'local' | 'remote';
export type TencentdbConnectionState = 'stopped' | 'starting' | 'ready' | 'failed' | 'restart_required';
export type TencentdbCoreRoute =
  | '/v3/conversation/query'
  | '/v3/conversation/search'
  | '/v3/conversation/delete'
  | '/v3/conversation/count'
  | '/v3/atomic/query'
  | '/v3/atomic/search'
  | '/v3/atomic/update'
  | '/v3/atomic/delete'
  | '/v3/atomic/count'
  | '/v3/scenario/ls'
  | '/v3/scenario/read'
  | '/v3/scenario/write'
  | '/v3/scenario/rm'
  | '/v3/scenario/count'
  | '/v3/core/read'
  | '/v3/core/write'
  | '/v3/core/count'
  | '/v3/chat-memory/clear'
  | '/v3/skill/create'
  | '/v3/skill/update'
  | '/v3/skill/patch'
  | '/v3/skill/delete'
  | '/v3/skill/get'
  | '/v3/skill/list'
  | '/v3/skill/search'
  | '/v3/skill/versions'
  | '/v3/skill/files/write'
  | '/v3/skill/files/remove'
  | '/v3/skill/files/read'
  | '/v3/skill/listing'
  | '/v3/meta/asset/list-accessible'
  | '/v3/meta/agent-fixed-asset/set'
  | '/v3/meta/agent-fixed-asset/list'
  | '/v3/meta/agent-fixed-asset/list-with-detail';

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
  userCredentialConfigured: boolean;
  lastSuccessAt?: string;
  restartRequired?: boolean;
}

export interface TencentdbPanelOpen {
  url: string;
}

export interface WorkspaceKnowledgeAssets {
  codeGraphId?: string;
  wikiId?: string;
  repoUrl?: string;
  branch?: string;
  error?: string;
  updatedAt?: string;
}

export type TencentdbKnowledgeStatus = 'draft' | 'pending' | 'processing' | 'ready' | 'failed';

export interface TencentdbWiki {
  wiki_id: string;
  team_id?: string;
  name: string;
  summary?: string | null;
  status: TencentdbKnowledgeStatus;
  sync_error?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
}

export interface TencentdbCodeGraph {
  code_graph_id: string;
  team_id?: string;
  repo_name: string;
  repo_url?: string;
  branch?: string;
  summary?: string | null;
  status: Exclude<TencentdbKnowledgeStatus, 'draft'>;
  sync_error?: string | null;
  stats?: { files?: number; nodes?: number; edges?: number } | null;
  last_sync_at?: string | null;
}

export interface TencentdbKnowledgeAssets {
  codeGraphs: TencentdbCodeGraph[];
  wikis: TencentdbWiki[];
  workspace?: WorkspaceKnowledgeAssets;
}

export interface TencentdbWikiPage {
  id: string;
  title: string;
  type: string;
  path: string;
  description?: string;
  locked?: boolean;
}

export interface TencentdbWikiPageContent {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface TencentdbWikiSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export interface TencentdbWikiSearchResponse {
  results: TencentdbWikiSearchResult[];
  count: number;
}

export interface TencentdbCodeGraphQueryResponse {
  text: string;
  isError: boolean;
}

export type TencentdbCodeGraphSearchResponse = TencentdbCodeGraphQueryResponse;

export interface TencentdbCodeGraphNodeOptions {
  includeCode?: boolean;
  file?: string;
  line?: number;
}

export type TencentdbCodeGraphFilesFormat = 'tree' | 'flat' | 'grouped';

export interface TencentdbCodeGraphFilesOptions {
  path?: string;
  pattern?: string;
  format?: TencentdbCodeGraphFilesFormat;
  includeMetadata?: boolean;
  maxDepth?: number;
}

export interface TencentdbBatchDeleteResult {
  deleted_ids: string[];
  failed?: Array<{ id: string; reason: string }>;
}

export type TencentdbAssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';
export type TencentdbInjectionMode = 'direct' | 'summary' | 'tool' | 'reference';

export interface TencentdbAsset {
  asset_id: string;
  asset_type: TencentdbAssetType;
  name: string;
  description?: string | null;
  status?: string;
}

export interface TencentdbAssetList {
  items: TencentdbAsset[];
  total: number;
}

export interface TencentdbFixedAsset {
  asset_id: string;
  asset_type: TencentdbAssetType;
  name: string;
  description?: string | null;
  injection_mode: TencentdbInjectionMode;
  priority: number;
}

export interface TencentdbFixedAssetList {
  agent: { agent_id: string };
  items: TencentdbFixedAsset[];
  total: number;
}

export interface TencentdbSkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  status: 'active' | 'archived';
  updated_at_ms?: number;
}

export interface TencentdbSkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface TencentdbSkillDetail extends TencentdbSkillSummary {
  content?: string;
  manifest?: TencentdbSkillManifestEntry[];
}

export interface SaveTencentdbConnection {
  config: TencentdbConnectionConfig;
  gatewayApiKey?: string;
  clearGatewayApiKey?: boolean;
  userApiKey?: string;
  clearUserApiKey?: boolean;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
}

export const coreRequest = <T>(
  route: TencentdbCoreRoute,
  body: Record<string, unknown> = {},
) => invoke<T>('tencentdb_core_request', { input: { route, body } });

export const tencentdbApi = {
  config: () => invoke<TencentdbConnectionConfig>('tencentdb_get_config'),
  status: () => invoke<TencentdbStatus>('tencentdb_get_status'),
  save: (input: SaveTencentdbConnection) =>
    invoke<TencentdbStatus>('tencentdb_save_connection', { input }),
  test: () => invoke<TencentdbStatus>('tencentdb_test_connection'),
  openPanel: () => invoke<TencentdbPanelOpen>('tencentdb_open_panel'),
  reloadSkills: () => invoke<void>('tencentdb_reload_skills'),
  coreRequest,
  listKnowledgeAssets: (workspace?: string) =>
    invoke<TencentdbKnowledgeAssets>('tencentdb_list_knowledge_assets', { workspace }),
  getWiki: (assetId: string) =>
    invoke<TencentdbWiki>('tencentdb_get_wiki', { input: { assetId } }),
  searchWiki: (assetId: string, query: string, limit = 20) =>
    invoke<TencentdbWikiSearchResponse>('tencentdb_search_wiki', {
      input: { assetId, query, limit },
    }),
  listWikiPages: (assetId: string) =>
    invoke<{ items: TencentdbWikiPage[] }>('tencentdb_list_wiki_pages', { input: { assetId } }),
  readWikiPages: (assetId: string, refs: string[]) =>
    invoke<{ items: TencentdbWikiPageContent[] }>('tencentdb_read_wiki_pages', {
      input: { assetId, refs },
    }),
  deleteWiki: (assetId: string, workspace?: string) =>
    invoke<TencentdbBatchDeleteResult>('tencentdb_delete_wiki', {
      input: { assetId, workspace },
    }),
  getCodeGraph: (assetId: string) =>
    invoke<TencentdbCodeGraph>('tencentdb_get_code_graph', { input: { assetId } }),
  searchCodeGraph: (assetId: string, query: string, limit = 20) =>
    invoke<TencentdbCodeGraphSearchResponse>('tencentdb_search_code_graph', {
      input: { assetId, query, limit },
    }),
  exploreCodeGraph: (assetId: string, query: string, maxFiles = 12) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_explore_code_graph', {
      input: { assetId, query, maxFiles },
    }),
  getCodeGraphCallers: (assetId: string, symbol: string, limit = 20) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_get_code_graph_callers', {
      input: { assetId, symbol, limit },
    }),
  getCodeGraphCallees: (assetId: string, symbol: string, limit = 20) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_get_code_graph_callees', {
      input: { assetId, symbol, limit },
    }),
  analyzeCodeGraphImpact: (assetId: string, symbol: string, depth = 2) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_analyze_code_graph_impact', {
      input: { assetId, symbol, depth },
    }),
  getCodeGraphNode: (
    assetId: string,
    symbol: string,
    options: TencentdbCodeGraphNodeOptions = {},
  ) => invoke<TencentdbCodeGraphQueryResponse>('tencentdb_get_code_graph_node', {
    input: { assetId, symbol, ...options },
  }),
  getCodeGraphStatus: (assetId: string) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_get_code_graph_status', {
      input: { assetId },
    }),
  listCodeGraphFiles: (assetId: string, options: TencentdbCodeGraphFilesOptions = {}) =>
    invoke<TencentdbCodeGraphQueryResponse>('tencentdb_list_code_graph_files', {
      input: { assetId, ...options },
    }),
  deleteCodeGraph: (assetId: string, workspace?: string) =>
    invoke<TencentdbBatchDeleteResult>('tencentdb_delete_code_graph', {
      input: { assetId, workspace },
    }),
  provisionWorkspaceAssets: (workspace: string) =>
    invoke<WorkspaceKnowledgeAssets>('tencentdb_provision_workspace_assets', { input: { workspace } }),
  syncCodeGraph: (assetId: string) =>
    invoke<Record<string, unknown>>('tencentdb_sync_code_graph', { input: { assetId } }),
  syncWiki: (assetId: string) =>
    invoke<Record<string, unknown>>('tencentdb_sync_wiki', { input: { assetId } }),
  importWikiFiles: (wikiId: string) =>
    invoke<{ uploaded: number; sync: Record<string, unknown> } | null>('tencentdb_import_wiki_files', {
      input: { wikiId },
    }),
};
