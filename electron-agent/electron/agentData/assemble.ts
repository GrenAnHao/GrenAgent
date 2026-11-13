/**
 * 主进程内装配 AgentData 运行时与索引任务执行器。只依赖注入的端口，不引入 electron。
 * 见 docs/architecture.md 的「代码索引」。
 */
import { AgentDataRuntime, type AgentDataMethod, type AgentDataRuntimeOptions } from './runtime';
import type { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';
import { CodeGraphJobs } from '../app/codeGraph/codeGraphJobs';
import type { IndexTaskStore } from '../app/codeGraph/indexTaskStore';
import { SystemWorkerManager } from '../pi/systemWorkerManager';
import type { AgentDataModelPort } from './modelPort';
export type { AgentDataModelPort } from './modelPort';

/** 注入的 socket 方法里必须回到主进程的那几个（审批 UI、渲染层广播、问 agent-host）。 */
export type AgentDataMainMethods = Record<'turn.start' | 'permission.authorize' | 'mcp.state.publish', AgentDataMethod>;

export interface AssembleOptions {
  dataPath: string;
  model: AgentDataModelPort;
  codeGraph: Pick<CodeGraphHostClient, 'projects' | 'status' | 'search' | 'call' | 'runSync' | 'cancelSync' | 'close'>;
  resolveSession: (workspace: string, sessionId: string) => Promise<boolean>;
  methods: AgentDataMainMethods;
  listenPath?: string;
  hostToken?: string;
  workspaceTokens?: Record<string, string>;
  /** codegraph 自己的索引任务记录；传入后 CodeGraphJobs 不再写 agent_jobs。 */
  indexTasks?: IndexTaskStore;
}

export interface AssembledAgentData {
  runtime: AgentDataRuntime;
  /** 关停顺序：先停 CodeGraph 同步（它的结束回调要写库）和模型任务，再关运行时。 */
  close(): Promise<void>;
}

export function assembleAgentData(options: AssembleOptions): AssembledAgentData {
  let runtime!: AgentDataRuntime;
  const systemWorker = new SystemWorkerManager({
    describeModel: () => options.model.describe(),
    complete: (input) => options.model.complete(input),
  });
  const admin = (method: string, params: Record<string, unknown>) => runtime.requestJobAdmin(method, params);
  // 传入 indexTasks 时索引任务直接落 codegraph 自己的库，不再经过 agent_jobs。
  const indexTasks = options.indexTasks;
  const codeGraphJobs = new CodeGraphJobs(options.codeGraph, indexTasks ? {
    start: async (id) => indexTasks.start(id),
    complete: async (id) => indexTasks.complete(id),
    fail: async (id, error) => indexTasks.fail(id, error),
    cancelled: async (id) => indexTasks.cancel(id),
    stage: (id, stage, processed, total) => { indexTasks.stage(id, stage, processed !== undefined && total !== undefined ? { processed, total } : undefined); },
  } : {
    start: (id) => admin('admin.jobs.start', { id }),
    complete: (id) => admin('admin.jobs.complete', { id }),
    fail: (id, error) => admin('admin.jobs.fail', { id, error }),
    cancelled: (id) => admin('admin.jobs.markCancelled', { id }),
    stage: () => {}, // 索引任务由 indexTasks 库记录；共享库回写已停用。
  });
  const runtimeOptions: AgentDataRuntimeOptions = {
    dataPath: options.dataPath,
    resolveSession: (project, sessionId) => options.resolveSession(project, sessionId).catch(() => false),
    executeServiceTask: (task, hooks) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }, hooks),
    jobRunners: { 'codegraph.sync': codeGraphJobs },
    codeRetrieval: {
      projects: () => options.codeGraph.projects(),
      status: async (workspace) => ({ ...await options.codeGraph.status(workspace) }),
      search: async (workspace, query, limit) => ({ ...await options.codeGraph.search(workspace, query, limit) }),
      call: (workspace, tool, args) => options.codeGraph.call(workspace, tool, args),
    },
    methods: { 'turn.start': options.methods['turn.start'], 'permission.authorize': options.methods['permission.authorize'], 'mcp.state.publish': options.methods['mcp.state.publish'] },
    // 不转发给 runtime 的话，admin.jobs.create 会因 options.indexTasks 缺失走退役分支，手动同步直接报错。
    ...(indexTasks ? { indexTasks } : {}),
    ...(options.listenPath ? { listenPath: options.listenPath } : {}),
    ...(options.hostToken ? { hostToken: options.hostToken } : {}),
    ...(options.workspaceTokens ? { workspaceTokens: options.workspaceTokens } : {}),
  };
  runtime = new AgentDataRuntime(runtimeOptions);
  let closing: Promise<void> | undefined;
  return {
    runtime,
    close: () => {
      closing ??= (async () => {
        await Promise.allSettled([codeGraphJobs.close()]);
        systemWorker.close();
        runtime.close();
        await runtime.waitClosed();
      })();
      return closing;
    },
  };
}
