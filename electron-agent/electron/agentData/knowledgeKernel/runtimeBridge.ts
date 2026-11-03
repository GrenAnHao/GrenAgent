import { knowledgeExecutionKey } from '../../../shared/knowledgeKernelContracts';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExecutionFence, KnowledgeMessageInput, KnowledgeModelBinding, KnowledgeUsage, RepoWikiKnowledgeSnapshot, StageExecutionRequest, StageExecutionResult } from '../../../shared/knowledgeKernelContracts';
import { TRANSCRIPT_BYTES_PER_TOKEN } from '../../../shared/knowledgeKernelContracts';
import type { KnowledgeUsageReport } from '../../agent/knowledgeModelTurn';
import { KnowledgeBuildStore } from './store';
import { KnowledgeKernelCoordinator, type AsyncKnowledgeProjectPort } from './coordinator';
import { dispatchKnowledgeModelRequest } from './modelRequests';

export interface KnowledgeKernelRuntimePorts {
  controllerEpoch: string;
  project: AsyncKnowledgeProjectPort;
  bindModel(taskId: string): Promise<KnowledgeModelBinding>;
  executeStage(request: StageExecutionRequest, signal: AbortSignal): Promise<StageExecutionResult>;
  abortStage(taskId: string, fence: ExecutionFence): Promise<void>;
  withModelSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  modelMessage(input: KnowledgeMessageInput, signal: AbortSignal): Promise<AssistantMessage>;
  bindEpoch(epoch: string): Promise<KnowledgeUsageReport[]>;
  activateEpoch(epoch: string): Promise<void>;
  ackUsage(requestId: string): Promise<void>;
  onChanged?(snapshot: RepoWikiKnowledgeSnapshot): void | Promise<void>;
}

/** AgentData owns this bridge and its database; provider and project I/O stay in their owners. */
export function createKnowledgeKernelRuntime(db: DatabaseSync, ports: KnowledgeKernelRuntimePorts) {
  const store = new KnowledgeBuildStore(db, { controllerEpoch: ports.controllerEpoch });
  const bindings = new Map<string, KnowledgeModelBinding>();
  const requests = new Map<string, { taskId: string; executionKey: string; controller: AbortController; done: Promise<unknown> }>();
  const canceledRequests = new Set<string>();
  let closing = false;
  const drainModels = async (taskId: string) => {
    while (true) {
      const active = [...requests.values()].filter(entry => entry.taskId === taskId);
      if (!active.length) return;
      await Promise.allSettled(active.map(entry => entry.done));
    }
  };
  const drainExecutionModels = async (key: string) => {
    while (true) { const active = [...requests.values()].filter(entry => entry.executionKey === key); if (!active.length) return; await Promise.allSettled(active.map(entry => entry.done)); }
  };
  const coordinator = new KnowledgeKernelCoordinator({ store, project: ports.project, pipelineConfigHash: 'knowledge-kernel-qoder-v2', executeStage: async (request, signal) => {
    const job = store.getTask(request.taskId), metadata = job?.metadata?.repoWiki;
    if (!metadata || metadata.sourceSnapshotId !== request.sourceSnapshotId || JSON.stringify(metadata.fence) !== JSON.stringify(request.fence) || JSON.stringify(metadata.key) !== JSON.stringify(request.key)) throw new Error('SOURCE_MANIFEST_MISMATCH');
    const snapshot = store.readSourceSnapshot(request.sourceSnapshotId) as { files?: Record<string, { hash?: unknown }> };
    const expected = Object.entries(snapshot.files ?? {}).map(([path, file]) => [path, file.hash]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    const manifest = (request.input as { manifest?: Array<{ path: string; hash: string }> } | undefined)?.manifest;
    if (!Array.isArray(manifest) || manifest.length !== expected.length || JSON.stringify(manifest.map(item => [item.path, item.hash]).sort(([a], [b]) => a.localeCompare(b))) !== JSON.stringify(expected)) throw new Error('SOURCE_MANIFEST_MISMATCH');
    try { return await ports.executeStage(request, signal); }
    finally { await drainExecutionModels(knowledgeExecutionKey(request)); }
  }, abortStage: ports.abortStage, drainModels, onChanged: ports.onChanged,
    bindModel: async taskId => { const binding = await ports.bindModel(taskId); if (!taskId.startsWith('admission:')) bindings.set(taskId, binding); return binding; } });

  const ready = (async () => {
    const reports = await ports.bindEpoch(ports.controllerEpoch);
    if (closing) return;
    store.reconcileUsageReports(reports);
    for (const id of new Set(reports.map(report => report.requestId))) await ports.ackUsage(id);
    if (closing) return;
    await ports.activateEpoch(ports.controllerEpoch);
  })();

  const scope = (input: any, requestId?: string) => {
    store.assertExecutionScope(input, requestId);
    return requestId ? store.getExecutionRequest(requestId) : undefined;
  };
  const reserve = (input: any, entry: { requestId: string; kind: 'model' | 'tool' | 'time'; reserved: KnowledgeUsage }) => {
    scope(input);
    return store.reserveExecutionBudget({ ...entry, taskId: input.taskId, phase: input.phase, itemId: input.itemId, attempt: input.attempt, fence: input.fence });
  };
  // Provider settlement can arrive after cancellation has released the lease.
  // Its captured request identity must still match the durable reservation.
  const modelRecord = (input: any, id: string) => {
    const record = store.getExecutionRequest(id);
    if (!record || record.taskId !== input.taskId || record.phase !== input.phase || record.itemId !== input.itemId || record.attempt !== input.attempt || JSON.stringify(record.fence) !== JSON.stringify(input.fence) || record.fence.controllerEpoch !== ports.controllerEpoch) throw new Error('REQUEST_SCOPE_MISMATCH');
    return record;
  };
  const worker = async (kind: string, input: any) => {
    scope(input);
    if (kind === 'reserve') {
      if (!['tool', 'time'].includes(input.kind)) throw new Error('INVALID_RESERVATION');
      return reserve(input, { requestId: input.requestId, kind: input.kind, reserved: input.reserved });
    }
    if (kind === 'finish' || kind === 'markDispatched' || kind === 'release') {
      const record = scope(input, input.requestId)!;
      if (record.kind === 'model') throw new Error('INVALID_REQUEST_SCOPE');
      if (kind === 'markDispatched') return store.markExecutionDispatched(input.requestId);
      if (kind === 'release') return store.releaseExecutionBudget(input.requestId);
      if (record.kind === 'time' && input.actual?.activeTimeMs !== record.reserved.activeTimeMs) throw new Error('INVALID_USAGE');
      for (const [key, value] of Object.entries(input.actual ?? {})) if (key !== 'unknown' && (typeof value !== 'number' || value < 0 || value > Number((record.reserved as any)[key] ?? 0))) throw new Error('INVALID_USAGE');
      return store.finishExecutionBudget(input.requestId, input.actual);
    }
    if (kind !== 'model') throw new Error('UNKNOWN_KNOWLEDGE_WORKER_REQUEST');
    if (canceledRequests.delete(input.requestId)) throw new Error('aborted');
    const modelInput: KnowledgeMessageInput = { ...input, options: { ...input.options } };
    const binding = bindings.get(input.taskId);
    if (!binding || binding.bindingId !== input.bindingId || input.controllerEpoch !== ports.controllerEpoch) throw new Error('MODEL_CHANGED');
    if (requests.has(input.requestId)) throw new Error('DUPLICATE_REQUEST');
    const controller = new AbortController();
    let tokenReservation = 0;
    const run = dispatchKnowledgeModelRequest(modelInput, {
      get tokenReservation() { return tokenReservation; },
      timeoutMs: store.budgetRemaining(input.taskId, input.phase, input.itemId).unit.modelTimeoutMs,
      withSlot: (work, signal) => ports.withModelSlot(async () => {
        scope(input);
        const remaining = store.budgetRemaining(input.taskId, input.phase, input.itemId);
        const limit = Math.min(remaining.unit.maxTotalTokens, remaining.run.maxTotalTokens);
        // Bytes are not tokens: counting each byte as a token reserved ~10x the real input and
        // exhausted the unit budget after three turns.
        const estimatedInput = Math.min(binding.model.contextWindow, Math.ceil(Buffer.byteLength(JSON.stringify(input.transcript), 'utf8') / TRANSCRIPT_BYTES_PER_TOKEN) + 1024);
        const maxTokens = Math.min(input.options.maxTokens, binding.model.maxTokens, remaining.unit.maxOutputTokens, limit - estimatedInput, binding.model.contextWindow - estimatedInput);
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('BUDGET_EXHAUSTED');
        modelInput.options.maxTokens = maxTokens; tokenReservation = estimatedInput + maxTokens;
        return work();
      }, signal),
      reserve: async entry => { reserve(input, entry); },
      finish: async (id, actual) => { modelRecord(input, id); store.finishExecutionBudget(id, actual); },
      markDispatched: async id => { scope(input, id); store.markExecutionDispatched(id); },
      release: async id => { if (store.getExecutionRequest(id)) { modelRecord(input, id); store.releaseExecutionBudget(id); } },
      dispatch: (message, signal) => ports.modelMessage(message, signal),
      ack: async id => { modelRecord(input, id); await ports.ackUsage(id); },
    }, controller.signal);
    requests.set(input.requestId, { taskId: input.taskId, executionKey: knowledgeExecutionKey(input), controller, done: run });
    try { return await run; } finally { requests.delete(input.requestId); }
  };
  const request = async (name: string, params: Record<string, any> = {}): Promise<unknown> => {
    if (name === 'admin.knowledge.abort') {
      const current = requests.get(params.requestId);
      if (current) current.controller.abort(); else if (typeof params.requestId === 'string') canceledRequests.add(params.requestId);
      return { aborted: true };
    }
    await ready;
    if (closing && name !== 'admin.knowledge.worker') throw new Error('COORDINATOR_CLOSED');
    switch (name) {
      case 'admin.knowledge.prepare': return coordinator.prepare(params.projectId, params.domain);
      case 'admin.knowledge.check': return coordinator.check(params.projectId, params.domain);
      case 'admin.knowledge.start': return coordinator.start(params as any);
      case 'admin.knowledge.action': return coordinator.act(params as any);
      case 'admin.knowledge.snapshot': return coordinator.snapshot(params.projectId, params.domain, params.taskId);
      case 'admin.knowledge.drafts': return coordinator.drafts(params.taskId);
      case 'admin.knowledge.worker': return worker(params.kind, params.input);
      default: throw new Error('UNKNOWN_KNOWLEDGE_REQUEST');
    }
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    await coordinator.close();
    for (const entry of requests.values()) entry.controller.abort();
    await Promise.allSettled([...requests.values()].map(entry => entry.done));
  };
  return { coordinator, ready, request, close };
}
