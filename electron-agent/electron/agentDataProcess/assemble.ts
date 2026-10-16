/**
 * AgentData 运行时的装配：两种宿主（主进程内 inproc、agentdata-host 子进程 child）共用这一份，
 * 保证两种模式下执行器、CodeGraph、记忆任务的接法完全相同。只依赖注入的端口，不引入 electron。
 * 见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
 */
import { AgentDataRuntime, type AgentDataMethod, type AgentDataRuntimeOptions } from '../agentData/runtime';
import type { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';
import { CodeGraphJobs } from '../app/codeGraph/codeGraphJobs';
import { validateProject } from '../app/validateProject';
import { SystemWorkerManager } from '../pi/systemWorkerManager';

/** 模型短调用：留在主进程（auth.json / OAuth 在那里），child 模式下经反向 RPC 调。 */
export interface AgentDataModelPort {
  describe(): Promise<string>;
  complete(input: { user: string; systemPrompt?: string; maxTokens?: number; signal?: AbortSignal; onUsage?: (report: { model: string; usage: unknown }) => void }): Promise<string>;
}

/** 注入的 socket 方法里必须回到主进程的那几个（审批 UI、渲染层广播、问 agent-host）。 */
export type AgentDataMainMethods = Record<'turn.start' | 'permission.authorize' | 'mcp.state.publish', AgentDataMethod>;

export interface AssembleOptions {
  dataPath: string;
  worksDir: string;
  model: AgentDataModelPort;
  codeGraph: Pick<CodeGraphHostClient, 'projects' | 'status' | 'search' | 'call' | 'runSync' | 'cancelSync' | 'close'>;
  resolveSession: (workspace: string, sessionId: string) => Promise<boolean>;
  methods: AgentDataMainMethods;
  listenPath?: string;
  hostToken?: string;
  workspaceTokens?: Record<string, string>;
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
  // CodeGraphJobs 的回调直接走运行时的进程内入口：child 模式下它和运行时同在子进程里，不再绕一圈 TCP。
  const admin = (method: string, params: Record<string, unknown>) => runtime.requestJobAdmin(method, params);
  const codeGraphJobs = new CodeGraphJobs(options.codeGraph, {
    start: (id) => admin('admin.jobs.start', { id }),
    complete: (id) => admin('admin.jobs.complete', { id }),
    fail: (id, error) => admin('admin.jobs.fail', { id, error }),
    cancelled: (id) => admin('admin.jobs.markCancelled', { id }),
    stage: (id, stage, processed, total) => runtime.recordJobStage(id, stage, processed, total),
  });
  const runtimeOptions: AgentDataRuntimeOptions = {
    dataPath: options.dataPath,
    validateProject: (project) => validateProject(project, options.worksDir),
    resolveSession: (project, sessionId) => options.resolveSession(project, sessionId).catch(() => false),
    completeSimple: (input) => options.model.complete(input),
    executeServiceTask: (task, hooks) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }, hooks),
    jobRunners: { 'codegraph.sync': codeGraphJobs },
    codeRetrieval: {
      projects: () => options.codeGraph.projects(),
      status: async (workspace) => ({ ...await options.codeGraph.status(workspace) }),
      search: async (workspace, query, limit) => ({ ...await options.codeGraph.search(workspace, query, limit) }),
      call: (workspace, tool, args) => options.codeGraph.call(workspace, tool, args),
    },
    methods: options.methods,
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
