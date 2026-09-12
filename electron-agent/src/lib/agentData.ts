import { invoke } from '../platform/runtime';
import type { WikiManagementApi, WikiLibraryView, WikiSource, WikiPage, WikiDeletePreview, WikiDeleteResult, WikiIngestPreview, WikiIngestReceipt, WikiImportPreview, WikiReindexResult, WikiVersion } from '../../electron/agentData/wikiContracts';
import type { JobMetadata } from '../../electron/agentData/operationsContracts';
import type { TaskRef, TaskView, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, AuditQuery, AuditPage, AuditExport, DiagnosticReport, WorkbenchOverview } from '../../electron/agentData/operationsContracts';
export type { TaskRef, TaskView, TaskStatus, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, ResourceRef, ResourceNavigation, AuditQuery, AuditView, AuditPage, AuditExport, DiagnosticItem, DiagnosticReport, WorkbenchOverview } from '../../electron/agentData/operationsContracts';
import type { MemoryRecord, ManagedMemoryRecord, MemoryListInput, MemoryPage, MemoryReadInput, MemoryCreateInput, MemoryUpdateInput, MemoryConversation, MemoryConversationDetail } from '../../electron/ipc/contracts';
export type { MemoryRecord, ManagedMemoryRecord, MemoryOwner, MemoryFilter, MemoryLevel, MemoryOrigin, MemoryListInput, MemoryPage, MemoryReadInput, MemoryDraft, MemoryCreateInput, MemoryUpdateInput, MemoryConversation, MemoryConversationDetail, MemoryItem } from '../../electron/ipc/contracts';

export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export type AgentJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AgentJob { id: string; kind: string; workspace: string; state: AgentJobState; progress: number; error?: string; createdAt: number; updatedAt: number; metadata?: JobMetadata }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export interface MemoryScope { userId: string; workspace?: string; projectId?: string; sessionId?: string; includeOtherProjects?: boolean }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }
export interface WikiSearchResult { workspace: string; page: string; title: string; snippet: string; sourcePath: string; chunks: number }
export interface CodeGraphStatus { workspace: string; connected: boolean; indexed: boolean; state?: string; sdkAvailable?: boolean; sdkVersion?: string; message?: string; files?: number; nodes?: number; edges?: number }
export interface CodeGraphProject { workspace: string; indexed: boolean }
export interface CodeSearchResult { file: string; line?: number; symbol?: string; snippet?: string }
export type CodeKind='function'|'method'|'class'|'interface'|'type'|'variable'|'route'|'component';
export type CodeSymbolArgs={symbol:string;file?:string;limit?:number;depth?:number};
export type CodeNodeArgs=({symbol:string;file?:string}|{file:string;symbol?:string}) &
  {includeCode?:boolean;offset?:number;limit?:number;symbolsOnly?:boolean;line?:number;depth?:number};
export interface CodeArgsByTool {
  codegraph_search:{query:string;kind?:CodeKind;limit?:number};
  codegraph_explore:{query:string;maxFiles?:number;limit?:number};
  codegraph_callers:CodeSymbolArgs; codegraph_callees:CodeSymbolArgs;
  codegraph_impact:CodeSymbolArgs; codegraph_node:CodeNodeArgs;
  codegraph_files:{path?:string;pattern?:string;format?:'tree'|'flat'|'grouped';includeMetadata?:boolean;maxDepth?:number};
}
export type CodeTool=keyof CodeArgsByTool;
export type CodeRetrievalRequest={
  [T in CodeTool]:{workspace:string;tool:T;args:CodeArgsByTool[T]}
}[CodeTool];
export interface AgentJobCreateInput { kind: string; workspace: string }
export interface AgentAuditEvent { id: string; action: string; detail: Record<string, unknown>; createdAt: number }
export interface AgentDiagnostics { jobs: { total: number; failed: number }; auditEvents: number }

const wikiManagement: WikiManagementApi = {
  libraries: {
    list: (input = {}) => invoke<WikiLibraryView[]>('agentData_wiki_libraries_list', { ...input }),
    read: (kbId) => invoke<WikiLibraryView>('agentData_wiki_libraries_read', { kbId }),
    create: (input) => invoke<WikiLibraryView>('agentData_wiki_libraries_create', { ...input }),
    update: (kbId, input, expectedRevision) => invoke<WikiLibraryView>('agentData_wiki_libraries_update', { kbId, ...input, expectedRevision }),
    previewDelete: (kbId) => invoke<WikiDeletePreview>('agentData_wiki_libraries_previewDelete', { kbId }),
    remove: (kbId, cancelActive) => invoke<WikiDeleteResult>('agentData_wiki_libraries_remove', { kbId, cancelActive }),
    previewIngest: (kbId, sourceIds, regenerateSourceIds) => invoke<WikiIngestPreview>('agentData_wiki_libraries_previewIngest', { kbId, sourceIds, regenerateSourceIds }),
    ingest: (kbId, sourceIds, regenerateSourceIds, expectedModel) => invoke<WikiIngestReceipt>('agentData_wiki_libraries_ingest', { kbId, sourceIds, regenerateSourceIds, expectedModel }),
    reindex: (kbId) => invoke<WikiReindexResult>('agentData_wiki_libraries_reindex', { kbId }),
  },
  sources: {
    list: (kbId) => invoke<WikiSource[]>('agentData_wiki_sources_list', { kbId }),
    read: (kbId, sourceId, revision) => invoke<{ source: WikiSource; content: string; version?: WikiVersion }>('agentData_wiki_sources_read', { kbId, sourceId, ...(revision === undefined ? {} : { revision }) }),
    previewImport: (kbId, projectWorkspace, relativePath) => invoke<WikiImportPreview>('agentData_wiki_sources_previewImport', { kbId, projectWorkspace, relativePath }),
    create: (kbId, input) => invoke<WikiSource>('agentData_wiki_sources_create', { kbId, ...input }),
    update: (kbId, sourceId, content, expected) => invoke<WikiSource>('agentData_wiki_sources_update', { kbId, sourceId, content, expected }),
    previewDelete: (kbId, sourceId) => invoke<WikiDeletePreview>('agentData_wiki_sources_previewDelete', { kbId, sourceId }),
    remove: (kbId, sourceId, cancelActive) => invoke<WikiDeleteResult>('agentData_wiki_sources_remove', { kbId, sourceId, cancelActive }),
  },
  pages: {
    list: (kbId) => invoke<Array<Omit<WikiPage, 'content'>>>('agentData_wiki_pages_list', { kbId }),
    read: (kbId, pageId) => invoke<WikiPage | undefined>('agentData_wiki_pages_read', { kbId, pageId }),
    create: (kbId, input) => invoke<WikiPage>('agentData_wiki_pages_create', { kbId, ...input }),
    update: (kbId, pageId, input) => invoke<WikiPage>('agentData_wiki_pages_update', { kbId, pageId, ...input }),
    setLocked: (kbId, pageId, locked, expected) => invoke<WikiPage>('agentData_wiki_pages_setLocked', { kbId, pageId, locked, expected }),
    previewDelete: (kbId, pageId) => invoke<WikiDeletePreview>('agentData_wiki_pages_previewDelete', { kbId, pageId }),
    remove: (kbId, pageId, cancelActive) => invoke<WikiDeleteResult>('agentData_wiki_pages_remove', { kbId, pageId, cancelActive }),
  },
};

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
    ...wikiManagement,
    overview: (workspace?: string) => invoke<WikiOverview>('agentData_wiki_overview', workspace === undefined ? {} : { workspace }),
    search: (workspace: string | undefined, query: string, limit = 50) => invoke<WikiSearchResult[]>('agentData_wiki_search', { ...(workspace === undefined ? {} : { workspace }), query, limit }),
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
