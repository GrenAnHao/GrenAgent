/**
 * AgentData 运行时的装配：两种宿主（主进程内 inproc、agentdata-host 子进程 child）共用这一份，
 * 保证两种模式下执行器、CodeGraph、系统任务的接法完全相同。只依赖注入的端口，不引入 electron。
 * 见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
 */
import { AgentDataRuntime, type AgentDataMethod, type AgentDataRuntimeOptions } from '../agentData/runtime';
import type { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';
import { CodeGraphJobs } from '../app/codeGraph/codeGraphJobs';
import { SystemWorkerManager } from '../pi/systemWorkerManager';
import type { AgentDataModelPort } from './modelPort';
import { parseRepoWikiJobPayload, type Job } from '../agentData/jobStore';
import type { JobMetadata } from '../agentData/operationsContracts';
import { randomUUID } from 'node:crypto';
import type { KnowledgeKernelRuntimePorts } from '../agentData/knowledgeKernel/runtimeBridge';
export type { AgentDataModelPort } from './modelPort';

/** 注入的 socket 方法里必须回到主进程的那几个（审批 UI、渲染层广播、问 agent-host）。 */
export type AgentDataMainMethods = Record<'turn.start' | 'permission.authorize' | 'mcp.state.publish', AgentDataMethod>
  & Partial<Record<'repoWiki.run' | 'repoWiki.cancel' | 'knowledge.bindEpoch' | 'knowledge.activateEpoch' | 'knowledge.bindModel' | 'knowledge.message' | 'knowledge.abort' | 'knowledge.ackUsage' | 'knowledge.worker' | 'knowledge.changed', AgentDataMethod>>;

export interface AssembleOptions {
  dataPath: string;
  model: AgentDataModelPort;
  codeGraph: Pick<CodeGraphHostClient, 'projects' | 'status' | 'search' | 'call' | 'runSync' | 'cancelSync' | 'close'>;
  resolveSession: (workspace: string, sessionId: string) => Promise<boolean>;
  methods: AgentDataMainMethods;
  listenPath?: string;
  hostToken?: string;
  workspaceTokens?: Record<string, string>;
  knowledgeKernelVersion?: 1;
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
  const activeWiki = new Map<string, Promise<void>>();
  const cancellingWiki = new Set<string>();
  let pausingWiki = false;
  const repoWikiJobs = options.knowledgeKernelVersion !== 1 && options.methods['repoWiki.run'] && options.methods['repoWiki.cancel'] ? {
    run: (id: string, workspace: string, expectedModel?: string, input?: JobMetadata['payload']): Promise<void> => {
      if (pausingWiki) return Promise.resolve();
      const existing = activeWiki.get(id);
      if (existing) return existing;
      const task = (async () => {
        const payload = parseRepoWikiJobPayload(input);
        if (!payload) throw new Error('INVALID_PARAMS: Repo Wiki generation confirmation is missing');
        await admin('admin.jobs.start', { id });
        const job = await admin('admin.jobs.get', { id }) as Job | undefined;
        if (pausingWiki) return;
        if (!job || !['pending', 'running'].includes(job.state)) return;
        if (job.metadata?.cancellationRequested || cancellingWiki.has(id)) {
          await admin('admin.jobs.markCancelled', { id });
          return;
        }
        try {
          const result = await options.methods['repoWiki.run']!({ id, workspace, payload, ...(expectedModel ? { expectedModel } : {}) }) as { cancelled?: boolean } | undefined;
          if (!pausingWiki) await admin(result?.cancelled || cancellingWiki.has(id) ? 'admin.jobs.markCancelled' : 'admin.jobs.complete', { id });
        } catch (error) {
          if (!pausingWiki) await admin(cancellingWiki.has(id) ? 'admin.jobs.markCancelled' : 'admin.jobs.fail', { id, error: error instanceof Error ? error.message : String(error) });
        }
      })().finally(() => { activeWiki.delete(id); cancellingWiki.delete(id); });
      activeWiki.set(id, task);
      return task;
    },
    cancel: async (id: string) => {
      cancellingWiki.add(id);
      try { await options.methods['repoWiki.cancel']!({ id }); }
      catch (error) { cancellingWiki.delete(id); throw error; }
    },
  } : undefined;
  const call = (name: keyof AgentDataMainMethods, params: Record<string, unknown>) => {
    const method = options.methods[name];
    if (!method) return Promise.reject(new Error(`MAIN_METHOD_UNAVAILABLE: ${name}`));
    return Promise.resolve().then(() => method(params));
  };
  const worker = (method: string, input: unknown) => call('knowledge.worker', { method, input });
  const knowledge: Omit<KnowledgeKernelRuntimePorts, 'withModelSlot'> | undefined = options.knowledgeKernelVersion === 1 ? {
    controllerEpoch: randomUUID(),
    project: {
      read: (projectId, domain) => worker('project.read', { projectId, domain }) as any,
      prepare: async (projectId, domain, signal) => {
        if (signal?.aborted) throw abortError(signal);
        const requestId = randomUUID();
        let canceled: Promise<unknown> | undefined, cancelError: unknown;
        const cancel = () => { canceled ??= worker('project.abortPrepare', { requestId }).catch(error => { cancelError = error; }); };
        signal?.addEventListener('abort', cancel, { once: true });
        try { return await worker('project.prepare', { projectId, domain, requestId }) as any; }
        finally { signal?.removeEventListener('abort', cancel); if (canceled) await canceled; if (cancelError) throw cancelError; }
      },
      readReadme: (projectId, sourceSnapshot, signal) => { if (signal?.aborted) throw abortError(signal); return worker('project.readReadme', { projectId, sourceSnapshot }) as any; },
      installFence: (projectId, domain, taskId, fence) => worker('project.installFence', { projectId, domain, taskId, fence }) as any,
      preparePublication: input => worker('project.preparePublication', input) as any,
      commitPublication: (candidateId, claim) => worker('project.commitPublication', { candidateId, claim }) as any,
      reconcile: (projectId, domain, claim) => worker('project.reconcile', { projectId, domain, claim }) as any,
      refreshIndex: projectId => worker('project.refreshIndex', { projectId }) as any,
    },
    bindEpoch: epoch => call('knowledge.bindEpoch', { epoch }) as any,
    activateEpoch: async epoch => { await call('knowledge.activateEpoch', { epoch }); },
    ackUsage: async requestId => { await call('knowledge.ackUsage', { requestId }); },
    bindModel: taskId => call('knowledge.bindModel', { taskId }) as any,
    executeStage: async (request, signal) => {
      if (signal.aborted) throw abortError(signal);
      let aborted: Promise<unknown> | undefined, cancelError: unknown;
      const cancel = () => { aborted ??= worker('stage.abort', { taskId: request.taskId, fence: request.fence }).catch(error => { cancelError = error; }); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await worker('stage.execute', request) as any; }
      finally { signal.removeEventListener('abort', cancel); if (aborted) await aborted; if (cancelError) throw cancelError; }
    },
    abortStage: async (taskId, fence) => { await worker('stage.abort', { taskId, fence }); },
    modelMessage: async (input, signal) => {
      if (signal.aborted) throw abortError(signal);
      let aborted: Promise<unknown> | undefined, cancelError: unknown;
      const cancel = () => { aborted ??= call('knowledge.abort', { requestId: input.requestId }).catch(error => { cancelError = error; }); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await call('knowledge.message', { input }) as any; }
      finally { signal.removeEventListener('abort', cancel); if (aborted) await aborted; if (cancelError) throw cancelError; }
    },
    onChanged: async snapshot => { await call('knowledge.changed', { snapshot }); },
  } : undefined;
  const runtimeOptions: AgentDataRuntimeOptions = {
    dataPath: options.dataPath,
    resolveSession: (project, sessionId) => options.resolveSession(project, sessionId).catch(() => false),
    completeSimple: (input) => options.model.complete(input),
    describeModel: () => options.model.describe(),
    executeServiceTask: (task, hooks) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }, hooks),
    jobRunners: { 'codegraph.sync': codeGraphJobs, ...(repoWikiJobs ? { 'repoWiki.generate': repoWikiJobs } : {}) },
    codeRetrieval: {
      projects: () => options.codeGraph.projects(),
      status: async (workspace) => ({ ...await options.codeGraph.status(workspace) }),
      search: async (workspace, query, limit) => ({ ...await options.codeGraph.search(workspace, query, limit) }),
      call: (workspace, tool, args) => options.codeGraph.call(workspace, tool, args),
    },
    methods: { 'turn.start': options.methods['turn.start'], 'permission.authorize': options.methods['permission.authorize'], 'mcp.state.publish': options.methods['mcp.state.publish'] },
    ...(knowledge ? { knowledge } : {}),
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
        await runtime.closeKnowledge();
        // A normal app shutdown pauses checkpointed Wiki work, preserving its acknowledged request for startup recovery.
        pausingWiki = true;
        await Promise.allSettled([...activeWiki.keys()].map((id) => options.methods['repoWiki.cancel']!({ id, pause: true })));
        await Promise.allSettled([...activeWiki.values(), codeGraphJobs.close()]);
        systemWorker.close();
        runtime.close();
        await runtime.waitClosed();
      })();
      return closing;
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
}
