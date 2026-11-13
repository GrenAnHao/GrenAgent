import { invoke } from '../platform/runtime';
export type { TaskRef, TaskView, TaskStatus, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, ResourceRef, ResourceNavigation } from '../../electron/agentData/operationsContracts';
export interface AgentDataStatus { state: 'ready' | 'closed'; version: number }
export type AgentJobState = 'pending' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export interface AgentJob { id: string; kind: string; workspace: string; state: AgentJobState; progress: number; error?: string; createdAt: number; updatedAt: number; metadata?: JobMetadata }
export interface AgentConfig { version: number; value: Record<string, unknown> }
export interface CodeGraphStatus { workspace: string; connected: boolean; indexed: boolean; state?: string; sdkAvailable?: boolean; sdkVersion?: string; message?: string; files?: number; nodes?: number; edges?: number; lastIndexedAt?: number | null; phase?: CodeGraphSyncPhase; mode?: 'incremental' | 'full'; trigger?: 'manual' | 'branch_switch' | 'watch' | 'activate' | 'poll' | 'startup' | 'retry'; progress?: { stage: string; processed?: number; total?: number }; lastSuccessAt?: number; lastError?: { message: string; at: number; code?: string }; consecutiveFailures?: number; nextRetryAt?: number; pendingChanges?: number; generation?: number; watcher?: { active: boolean; degraded: boolean; reason?: string }; servingStale?: boolean; autoSync?: boolean }
/** codegraph-host 调度器的阶段：增量同步（syncing）期间仍可查询，全量重建（rebuilding）期间 state 是 indexing。 */
export type CodeGraphSyncPhase = 'idle' | 'queued' | 'syncing' | 'rebuilding' | 'backoff' | 'failed';
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
  codegraph_files:{path?:string;pattern?:string;format?:'tree'|'flat'|'grouped';includeMetadata?:boolean;maxDepth?:number;limit?:number;offset?:number};
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
  code: {
    call: (input: CodeRetrievalRequest) => invoke<unknown>('agentData_code_call', { ...input }),
    status: (workspace: string) => invoke<CodeGraphStatus>('agentData_code_status', { workspace }),
    search: (workspace: string, query: string, limit = 20) => invoke<{ workspace: string; available: boolean; results: CodeSearchResult[]; message?: string }>('agentData_code_search', { workspace, query, limit }),
    projects: () => invoke<CodeGraphProject[]>('agentData_code_projects'),
  },
  /** 仅用于发起手动 codegraph.sync：经 agentData_jobs_create 落到 codegraph 自己的 index-tasks 库。 */
  jobs: {
    create: (input: AgentJobCreateInput) => invoke<AgentJob>('agentData_jobs_create', { ...input }),
  },
};
