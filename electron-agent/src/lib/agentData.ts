import { invoke } from '../platform/runtime';
import type { JobMetadata } from '../../electron/agentData/operationsContracts';
import type { TaskRef, TaskView, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, AuditQuery, AuditPage, AuditExport, DiagnosticReport, WorkbenchOverview } from '../../electron/agentData/operationsContracts';
export type { TaskRef, TaskView, TaskStatus, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, ResourceRef, ResourceNavigation, AuditQuery, AuditView, AuditPage, AuditExport, DiagnosticItem, DiagnosticReport, WorkbenchOverview } from '../../electron/agentData/operationsContracts';
import type { MemoryRecord, ManagedMemoryRecord, MemoryListInput, MemoryPage, MemoryReadInput, MemoryCreateInput, MemoryUpdateInput, MemoryConversation, MemoryConversationDetail } from '../../electron/ipc/contracts';
export type { MemoryRecord, ManagedMemoryRecord, MemoryOwner, MemoryFilter, MemoryLevel, MemoryOrigin, MemoryListInput, MemoryPage, MemoryReadInput, MemoryDraft, MemoryCreateInput, MemoryUpdateInput, MemoryConversation, MemoryConversationDetail, MemoryItem } from '../../electron/ipc/contracts';
import type { IngestResult, WikiAssetDetail, WikiRawSource, WikiSearchHit, WikiSearchResponse } from '../../electron/agentData/wikiEngine/service';
export type { IngestResult, WikiAssetDetail, WikiRawSource, WikiSearchHit, WikiSearchResponse };

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }
export type AgentJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AgentJob { id: string; kind: string; workspace: string; state: AgentJobState; progress: number; error?: string; createdAt: number; updatedAt: number; metadata?: JobMetadata }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export interface MemoryScope { userId: string; workspace?: string; projectId?: string; sessionId?: string; includeOtherProjects?: boolean }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }
export interface CodeGraphStatus { workspace: string; connected: boolean; indexed: boolean; state?: string; sdkAvailable?: boolean; sdkVersion?: string; message?: string; files?: number; nodes?: number; edges?: number; lastIndexedAt?: number | null }
export interface CodeGraphProject { workspace: string; indexed: boolean }
export interface CodeSearchResult { file: string; line?: number; symbol?: string; snippet?: string }
export type CodeKind = 'file'|'module'|'class'|'struct'|'interface'|'trait'|'protocol'|'function'|'method'|'property'|'field'|'variable'|'constant'|'enum'|'enum_member'|'type_alias'|'namespace'|'parameter'|'import'|'export'|'route'|'component'|'union'|'type';
export type CodeSymbolArgs={symbol:string;file?:string;limit?:number;depth?:number;line?:number};
export type CodeNodeArgs=({symbol:string;file?:string}|{file:string;symbol?:string}) &
  {includeCode?:boolean;offset?:number;limit?:number;symbolsOnly?:boolean;line?:number;depth?:number;includeMetrics?:boolean};
export interface CodeArgsByTool {
  codegraph_search:{query?:string;kind?:CodeKind;kinds?:CodeKind[];languages?:string[];includePatterns?:string[];excludePatterns?:string[];limit?:number;offset?:number;caseSensitive?:boolean;mode?:string;excludePrefix?:boolean;words?:string[]};
  codegraph_explore:{query:string;maxFiles?:number;limit?:number;searchLimit?:number;traversalDepth?:number;maxNodes?:number;minScore?:number;edgeKinds?:string[];nodeKinds?:CodeKind[];seedNames?:string[]};
  codegraph_callers:CodeSymbolArgs; codegraph_callees:CodeSymbolArgs;
  codegraph_impact:CodeSymbolArgs; codegraph_node:CodeNodeArgs;
  codegraph_files:{path?:string;pattern?:string;format?:'tree'|'flat'|'grouped';includeMetadata?:boolean;maxDepth?:number};
  codegraph_status:Record<string, never>;
  codegraph_usages:CodeSymbolArgs;
  codegraph_path:{from:string;to:string;fromFile?:string;toFile?:string;edgeKinds?:string[];limit?:number};
  codegraph_hierarchy:CodeSymbolArgs;
  codegraph_call_graph:CodeSymbolArgs;
  codegraph_deps:{file:string;direction?:'dependencies'|'dependents'|'both'};
  codegraph_cycles:{limit?:number};
  codegraph_dead_code:{kinds?:CodeKind[];limit?:number};
  codegraph_metrics:CodeSymbolArgs;
  codegraph_routes:{limit?:number};
  codegraph_traverse:{symbol?:string;file?:string;maxDepth?:number;depth?:number;edgeKinds?:string[];nodeKinds?:CodeKind[];direction?:'outgoing'|'incoming'|'both';limit?:number;includeStart?:boolean};
  codegraph_context:{query?:string;title?:string;description?:string;maxNodes?:number;maxCodeBlocks?:number;maxCodeBlockSize?:number;includeCode?:boolean;format?:'markdown'|'json';searchLimit?:number;traversalDepth?:number;minScore?:number;limit?:number};
  codegraph_changed:Record<string, never>;
}
export type CodeTool=keyof CodeArgsByTool;
export type CodeRetrievalRequest={
  [T in CodeTool]:{workspace:string;tool:T;args:CodeArgsByTool[T]}
}[CodeTool];
export interface AgentJobCreateInput { kind: string; workspace: string }
export interface AgentAuditEvent { id: string; action: string; detail: Record<string, unknown>; createdAt: number }
export interface AgentDiagnostics { jobs: { total: number; failed: number }; auditEvents: number }

export const agentDataApi = {
  tasks: {
    list: (input: TaskListInput = {}) => invoke<TaskPage>('agentData_tasks_list', { ...input }),
    read: (ref: TaskRef) => invoke<TaskDetail | undefined>('agentData_tasks_read', { ...ref }),
    previewRetry: (ref: TaskRef) => invoke<TaskRetryPreview>('agentData_tasks_previewRetry', { ...ref }),
    retry: (ref: TaskRef, options: TaskRetryOptions = {}) => invoke<TaskView>('agentData_tasks_retry', { ...ref, ...options }),
  },
  audits: {
    query: (input: AuditQuery = {}) => invoke<AuditPage>('agentData_audit_query', { ...input }),
    export: (input: AuditQuery = {}) => invoke<AuditExport>('agentData_audit_export', { ...input }),
  },
  checks: {
    check: () => invoke<DiagnosticReport>('agentData_diagnostics_check', {}),
    open: (id: string) => invoke<void>('agentData_diagnostics_open', { id }),
  },
  overview: (input: { userId: string }) => invoke<WorkbenchOverview>('agentData_overview', { ...input }),
  start: () => invoke<{ version: number }>('agentData_start'),
  status: () => invoke<AgentDataStatus>('agentData_status'),
  stop: () => invoke<void>('agentData_stop'),
  jobs: {
    list: () => invoke<AgentJob[]>('agentData_admin_jobs_list'),
    get: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_get', { id }),
    cancel: (id: string) => invoke<AgentJob | undefined>('agentData_admin_jobs_cancel', { id }),
    remove: (id: string) => invoke<{ deleted: boolean }>('agentData_admin_jobs_remove', { id }),
    clear: (ids: string[]) => invoke<{ deletedIds: string[] }>('agentData_admin_jobs_clear', { ids }),
    create: (input: AgentJobCreateInput) => invoke<AgentJob>('agentData_jobs_create', input),
  },
  memory: {
    list: (input: MemoryListInput) => invoke<MemoryPage<ManagedMemoryRecord>>('agentData_memory_list', { ...input }),
    read: (input: MemoryReadInput) => invoke<ManagedMemoryRecord>('agentData_memory_read', { ...input }),
    create: (input: MemoryCreateInput) => invoke<ManagedMemoryRecord>('agentData_memory_create', { ...input }),
    update: (input: MemoryUpdateInput) => invoke<ManagedMemoryRecord>('agentData_memory_update', { ...input }),
    conversations: {
      list: (input: MemoryListInput) => invoke<MemoryPage<MemoryConversation>>('agentData_memory_conversations_list', { ...input }),
      read: (input: MemoryReadInput) => invoke<MemoryConversationDetail>('agentData_memory_conversations_read', { ...input }),
    },
    overview: (scope: MemoryScope) => invoke<MemoryOverview>('agentData_memory_overview', scope),
    search: (scope: MemoryScope, query: string, limit = 50) => invoke<MemoryRecord[]>('agentData_memory_search', { ...scope, query, limit }),
    delete: (scope: { userId: string; workspace?: string }, id: string) => invoke<void>('agentData_memory_delete', { ...scope, id }),
  },
  wiki: {
    create: (input: { name: string; wikiId?: string }) => invoke<WikiAssetDetail>('agentData_wiki_create', { ...input }),
    read: (wikiId: string) => invoke<WikiAssetDetail>('agentData_wiki_read', { wikiId }),
    list: () => invoke<WikiAssetDetail[]>('agentData_wiki_list'),
    update: (wikiId: string, patch: { name?: string; summary?: string | null }) => invoke<WikiAssetDetail>('agentData_wiki_update', { wikiId, ...patch }),
    remove: (wikiId: string) => invoke<null>('agentData_wiki_remove', { wikiId }),
    resetDraft: (wikiId: string) => invoke<null>('agentData_wiki_resetDraft', { wikiId }),
    ingest: (wikiId: string) => invoke<IngestResult>('agentData_wiki_ingest', { wikiId }),
    rawWrite: (wikiId: string, filename: string, content: string) => invoke<null>('agentData_wiki_rawWrite', { wikiId, filename, content }),
    rawRemove: (wikiId: string, filename: string) => invoke<null>('agentData_wiki_rawRemove', { wikiId, filename }),
    rawList: (wikiId: string) => invoke<WikiRawSource[]>('agentData_wiki_rawList', { wikiId }),
    rawRead: (wikiId: string, filename: string) => invoke<string>('agentData_wiki_rawRead', { wikiId, filename }),
    writeTemplate: (wikiId: string, name: 'purpose' | 'schema', content: string) => invoke<null>('agentData_wiki_writeTemplate', { wikiId, name, content }),
    pageWrite: (wikiId: string, ref: string, content: string) => invoke<{ lockedInjected: boolean }>('agentData_wiki_pageWrite', { wikiId, ref, content }),
    pageRemove: (wikiId: string, ref: string) => invoke<null>('agentData_wiki_pageRemove', { wikiId, ref }),
    pageList: (wikiId: string) => invoke<Array<{ id: string; title: string; type: string; relPath: string }>>('agentData_wiki_pageList', { wikiId }),
    pageRead: (wikiId: string, ref: string) => invoke<string>('agentData_wiki_pageRead', { wikiId, ref }),
    search: (wikiId: string, query: string, options: { limit?: number; hop?: number; decay?: number; minScore?: number } = {}) => invoke<WikiSearchResponse>('agentData_wiki_search', { wikiId, query, ...options }),
    graph: (wikiId: string) => invoke<Array<{ source_id: string; target_id: string }>>('agentData_wiki_graph', { wikiId }),
    overview: async (): Promise<WikiOverview> => {
      const items = await invoke<WikiAssetDetail[]>('agentData_wiki_list');
      let pages = 0;
      let latestUpdatedAt: number | null = null;
      for (const item of items) {
        pages += item.pageCount ?? 0;
        const stamp = Date.parse(item.updatedAt);
        if (Number.isFinite(stamp) && (latestUpdatedAt === null || stamp > latestUpdatedAt)) latestUpdatedAt = stamp;
      }
      return { pages, latestUpdatedAt };
    },
  },
  code: {
    call: (input: CodeRetrievalRequest) => invoke<unknown>('agentData_code_call', { ...input }),
    status: (workspace: string) => invoke<CodeGraphStatus>('agentData_code_status', { workspace }),
    search: (workspace: string, query: string, limit = 20) => invoke<{ workspace: string; available: boolean; results: CodeSearchResult[]; message?: string }>('agentData_code_search', { workspace, query, limit }),
    projects: () => invoke<CodeGraphProject[]>('agentData_code_projects'),
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
