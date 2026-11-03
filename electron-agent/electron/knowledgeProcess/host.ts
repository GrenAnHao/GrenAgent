import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WorkspaceService } from '../../vendor/repo-wiki/packages/service/src/service';
import { KNOWLEDGE_PHASES, knowledgeExecutionKey, type StageExecutionRequest } from '../../shared/knowledgeKernelContracts';
import { KnowledgeProjectPort } from './projectPort';
import { runKnowledgeStage } from './stageRuntime';

type Reverse = (kind: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
const fenceKey = (value: any) => JSON.stringify([value?.ledgerId, value?.controllerEpoch, value?.ownerId, value?.generation]);
export class KnowledgeWorkerHost {
  private readonly projects: KnowledgeProjectPort;
  private readonly stages = new Map<string, { taskId: string; fence: string; controller: AbortController; promise: Promise<unknown> }>();
  private readonly canceledStages = new Set<string>();
  private readonly preparations = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private readonly canceledPreparations = new Set<string>();
  constructor(private readonly service: WorkspaceService, private readonly reverse: Reverse) { this.projects = new KnowledgeProjectPort(service.engine); }
  async invoke(method: string, input: any): Promise<unknown> {
    if (!input || typeof input !== 'object') throw new Error('INVALID_KNOWLEDGE_REQUEST');
    if (['project.read', 'project.prepare', 'project.installFence', 'project.reconcile'].includes(method) && (typeof input.projectId !== 'string' || !['wiki', 'cards'].includes(input.domain))) throw new Error('INVALID_KNOWLEDGE_SCOPE');
    switch (method) {
      case 'host.updateRoots': this.service.updateHostRoots(input.roots); return { updated: true };
      case 'project.read': return this.projects.read(input.projectId, input.domain);
      case 'project.readReadme': if (typeof input.projectId !== 'string' || !input.sourceSnapshot) throw new Error('INVALID_KNOWLEDGE_SCOPE'); return this.projects.readReadme(input.projectId, input.sourceSnapshot);
      case 'project.prepare': {
        const requestId = input.requestId === undefined ? randomUUID() : input.requestId;
        if (typeof requestId !== 'string' || !requestId || this.preparations.has(requestId)) throw new Error('INVALID_KNOWLEDGE_REQUEST');
        if (this.canceledPreparations.delete(requestId)) throw new Error('aborted');
        const controller = new AbortController();
        const promise = this.projects.prepare(input.projectId, input.domain, controller.signal);
        const entry = { controller, promise }; this.preparations.set(requestId, entry);
        try { return await promise; } finally { if (this.preparations.get(requestId) === entry) this.preparations.delete(requestId); }
      }
      case 'project.abortPrepare': {
        const entry = this.preparations.get(input.requestId);
        if (!entry) { if (typeof input.requestId === 'string') this.canceledPreparations.add(input.requestId); return { aborted: false }; }
        entry.controller.abort(); await Promise.allSettled([entry.promise]); return { aborted: true };
      }
      case 'project.installFence': return this.projects.installFence(input.projectId, input.domain, input.taskId, input.fence);
      case 'project.preparePublication': return this.projects.preparePublication(input);
      case 'project.commitPublication': return this.projects.commitPublication(input.candidateId, input.claim);
      case 'project.reconcile': return this.projects.reconcile(input.projectId, input.domain, input.claim);
      case 'project.refreshIndex': return this.projects.refreshIndex(input.projectId);
      case 'stage.execute': return this.execute(input);
      case 'stage.abort': {
        const fence = fenceKey(input.fence);
        const stages = [...this.stages.values()].filter(stage => stage.taskId === input.taskId);
        if (stages.some(stage => stage.fence !== fence)) throw new Error('STALE_FENCE');
        if (typeof input.taskId === 'string' && input.fence) this.canceledStages.add(JSON.stringify([input.taskId, fence]));
        for (const stage of stages) stage.controller.abort();
        await Promise.allSettled(stages.map(stage => stage.promise));
        return { aborted: stages.length > 0 };
      }
      default: throw new Error('UNKNOWN_KNOWLEDGE_METHOD');
    }
  }
  private async execute(request: StageExecutionRequest): Promise<unknown> {
    const fence = request?.fence;
    if (typeof request?.taskId !== 'string' || !request.taskId || !fence || ![fence.ledgerId, fence.controllerEpoch, fence.ownerId].every(value => typeof value === 'string' && value.length > 0) || !Number.isSafeInteger(fence.generation) || fence.generation < 1 || !request.key || !['wiki', 'cards'].includes(request.key.domain) || !KNOWLEDGE_PHASES.includes(request.phase) || typeof request.itemId !== 'string' || !request.itemId || !Number.isSafeInteger(request.attempt) || request.attempt < 1) throw new Error('INVALID_KNOWLEDGE_SCOPE');
    const key = knowledgeExecutionKey(request);
    if (this.canceledStages.has(JSON.stringify([request.taskId, fenceKey(fence)]))) throw new Error('aborted');
    if (this.stages.has(key)) throw new Error('INVALID_KNOWLEDGE_SCOPE');
    if ([...this.stages.values()].some(stage => stage.taskId === request.taskId && stage.fence !== fenceKey(fence))) throw new Error('STALE_FENCE');
    const meta = this.projects.read(request.key.projectId, request.key.domain);
    const stageInput = request.input as { root?: string } | undefined;
    if (Object.entries(meta.key).some(([key, value]) => (request.key as any)[key] !== value) || !stageInput?.root || realpathSync(stageInput.root) !== realpathSync(meta.root)) throw new Error('INVALID_KNOWLEDGE_SCOPE');
    const controller = new AbortController();
    const scope = { taskId: request.taskId, fence: request.fence, phase: request.phase, itemId: request.itemId, attempt: request.attempt };
    const promise = runKnowledgeStage(request, {
      requestModel: (modelInput, signal) => this.reverse('model', { ...scope, ...modelInput }, signal) as any,
      reserve: async entry => { await this.reverse('reserve', { ...scope, ...entry }, controller.signal); },
      finish: async (requestId, actual) => { await this.reverse('finish', { ...scope, requestId, actual }, controller.signal); },
      markDispatched: async requestId => { await this.reverse('markDispatched', { ...scope, requestId }, controller.signal); },
      release: async requestId => { await this.reverse('release', { ...scope, requestId }, controller.signal); },
    }, controller.signal);
    const entry = { taskId: request.taskId, fence: fenceKey(request.fence), controller, promise };
    this.stages.set(key, entry);
    try { return await promise; } finally { if (this.stages.get(key) === entry) this.stages.delete(key); }
  }
  async close(): Promise<void> {
    const running = [...this.stages.values()];
    const scans = [...this.preparations.values()];
    for (const stage of running) stage.controller.abort();
    for (const scan of scans) scan.controller.abort();
    await Promise.allSettled([...running.map(stage => stage.promise), ...scans.map(scan => scan.promise)]);
  }
}
