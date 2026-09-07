import { randomUUID } from 'node:crypto';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../agentData/memoryStore';
import type { ManagedMemoryRecord, MemoryConversation, MemoryConversationDetail, MemoryCreateInput, MemoryDraft, MemoryListInput, MemoryPage, MemoryReadInput, MemoryUpdateInput } from '../agentData/memoryContracts';
import { RpcError } from '../agentData/protocol';

import type { ServiceTask } from './appServer/types';

export interface MemorySearchScope extends MemoryScope { projectId: string; query: string; limit?: number }
export interface MemoryCaptureInput extends MemoryScope { projectId: string; source: string; transcript: string; fingerprint: string; extract?: boolean }
export interface MemoryCaptureResult { changed: boolean; delta: string; fingerprint: string; taskId?: string }
export interface MemoryTaskQueue {
  enqueue(input: { id: string; kind: string; input: unknown; sourceProjectId?: string; sourceSessionId?: string; system?: boolean }): Promise<ServiceTask>;
  get?(id: string): ServiceTask | undefined;
  findPending?(kind: string, matches: (task: ServiceTask) => boolean): ServiceTask | undefined;
}
export interface MemoryServiceOptions { store: MemoryStore; queue: MemoryTaskQueue; validateProject?: (projectId: string) => Promise<string> }
interface PendingCapture { scope: MemoryScope; source: string; fingerprint: string; delta: string }

export class MemoryService {
  private readonly pending = new Map<string, PendingCapture>();
  private readonly finishing = new Set<string>();
  constructor(private readonly options: MemoryServiceOptions) {}

  search(scope: MemorySearchScope): Promise<MemoryRecord[]> {
    return Promise.resolve(this.options.store.search(scope, scope.query, scope.limit));
  }

  async list(input: MemoryListInput): Promise<MemoryPage<ManagedMemoryRecord>> {
    return this.options.store.list(input);
  }

  async read(input: MemoryReadInput): Promise<ManagedMemoryRecord> {
    return this.options.store.read(input);
  }

  async listConversations(input: MemoryListInput): Promise<MemoryPage<MemoryConversation>> {
    return this.options.store.listConversations(input);
  }

  async readConversation(input: MemoryReadInput): Promise<MemoryConversationDetail> {
    return this.options.store.readConversation(input);
  }

  async create(input: MemoryCreateInput): Promise<ManagedMemoryRecord> {
    return this.options.store.create({ ...input, draft: await this.validateOwner(input.draft) });
  }

  async update(input: MemoryUpdateInput): Promise<ManagedMemoryRecord> {
    const current = this.options.store.read(input);
    const owner = input.draft?.owner;
    // Historical owners may no longer exist. Only a new project binding needs
    // filesystem validation; the store checks revision again after this await.
    const draft = owner?.scope === 'project' && (current.scope !== 'project' || current.sourceProjectId !== owner.projectId)
      ? await this.validateOwner(input.draft) : input.draft;
    return this.options.store.update({ ...input, draft });
  }

  private async validateOwner(draft: MemoryDraft): Promise<MemoryDraft> {
    if (draft?.owner?.scope !== 'project') return draft;
    if (!this.options.validateProject || typeof draft.owner.projectId !== 'string' || !draft.owner.projectId.trim()) throw new RpcError('INVALID_PARAMS', 'invalid memory project');
    try {
      const projectId = await this.options.validateProject(draft.owner.projectId);
      if (typeof projectId !== 'string' || !projectId.trim()) throw new Error();
      return { ...draft, owner: { scope: 'project', projectId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safeMessages = ['PROJECT_REQUIRED', 'PROJECT_NOT_DIRECTORY', 'TEMPORARY_PROJECT_NOT_ALLOWED', 'project directory not available'];
      throw new RpcError('INVALID_PARAMS', safeMessages.includes(message) ? message : 'invalid memory project');
    }
  }

  async capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult> {
    const captured = this.options.store.capture(input, input.source, input.transcript, input.fingerprint);
    if (!captured.changed || !captured.delta) return captured;
    const active = [...this.pending].find(([, value]) => sameSource(value.scope, value.source, input));
    if (input.extract === false) {
      this.options.store.commitCapture(input, input.source, input.fingerprint);
      return captured;
    }
    if (active) return { ...captured, taskId: active[0] };
    const queued = this.options.queue.findPending?.('memory_extract', (task) => {
      const value = this.captureFromTask(task.id, task);
      return !this.finishing.has(task.id) && value !== undefined && sameSource(value.scope, value.source, input);
    });
    if (queued) {
      this.pending.set(queued.id, this.captureFromTask(queued.id, queued)!);
      return { ...captured, taskId: queued.id };
    }
    const taskId = randomUUID();
    const scope = { ...input, scope: 'project' as const };
    this.pending.set(taskId, { scope, source: input.source, fingerprint: input.fingerprint, delta: captured.delta });
    try {
      void this.options.queue.enqueue({
        id: taskId,
        kind: 'memory_extract',
        input: { delta: captured.delta, source: input.source, fingerprint: input.fingerprint, userId: input.userId, projectId: input.projectId, workspace: input.workspace, sessionId: input.sessionId },
        sourceProjectId: input.projectId,
        sourceSessionId: input.sessionId,
        system: true,
      }).then((task) => {
        // Queues with a terminal callback may already have settled this task.
        if (this.pending.has(taskId)) this.taskSettled(task);
      }).catch(() => { if (this.pending.has(taskId)) this.finishCapture(taskId); });
    } catch (error) {
      this.pending.delete(taskId);
      throw error;
    }
    return { ...captured, taskId };
  }

  completeExtraction(taskId: string, output: unknown): MemoryRecord[] {
    const capture = this.pending.get(taskId) ?? this.captureFromTask(taskId);
    if (!capture) throw new Error('memory capture task not found');
    const extraction = validateExtraction(output);
    const writes: MemoryRecord[] = [];
    const globalScope = { ...capture.scope, scope: 'global' as const };
    if (extraction.l1 !== undefined) {
      const content = JSON.stringify(extraction.l1);
      if (content !== '{}' && content !== '[]') writes.push(this.options.store.upsert(capture.scope, { level: 1, content, source: capture.source }));
    }
    if (extraction.l2) writes.push(this.options.store.upsert(globalScope, { level: 2, content: extraction.l2, source: capture.source }));
    if (extraction.l3) writes.push(this.options.store.upsert(globalScope, { level: 3, content: extraction.l3, source: capture.source }));
    this.options.store.commitCapture(capture.scope, capture.source, capture.fingerprint, capture.delta);
    this.finishCapture(taskId);

    return writes;
  }

  taskSettled(task: ServiceTask): void {
    if (task.kind === 'memory_extract' && (task.status === 'failed' || task.status === 'cancelled')) this.finishCapture(task.id, task);
  }

  private finishCapture(taskId: string, task?: ServiceTask): void {
    const capture = this.pending.get(taskId) ?? this.captureFromTask(taskId, task);
    this.pending.delete(taskId);
    if (!capture) return;
    const next = this.options.store.pendingCapture(capture.scope, capture.source);
    // Only newer input earns another task. Repeated failures with no new turn
    // remain pending for an explicit retry instead of creating an infinite loop.
    if (next && next.fingerprint !== capture.fingerprint) {
      // completeExtraction runs before TaskQueue persists "completed". Exclude
      // that still-running task while finding/creating the successor.
      this.finishing.add(taskId);
      void this.capture({ ...capture.scope, projectId: capture.scope.projectId ?? capture.scope.workspace, source: capture.source, ...next })
        .catch(() => {}).finally(() => { this.finishing.delete(taskId); });
    }
  }

  private captureFromTask(taskId: string, task = this.options.queue.get?.(taskId)): PendingCapture | undefined {
    const input = task?.input as Record<string, unknown> | undefined;
    if (!task || task.kind !== 'memory_extract' || !input || typeof input.delta !== 'string') return undefined;
    if (typeof task.sourceProjectId !== 'string' || typeof input.source !== 'string') return undefined;
    return { scope: { userId: typeof input.userId === 'string' ? input.userId : 'local', projectId: task.sourceProjectId, workspace: typeof input.workspace === 'string' ? input.workspace : task.sourceProjectId, sessionId: typeof task.sourceSessionId === 'string' ? task.sourceSessionId : undefined }, source: input.source, fingerprint: typeof input.fingerprint === 'string' ? input.fingerprint : '', delta: input.delta };
  }
}

function validateExtraction(value: unknown): { l1?: unknown; l2?: string; l3?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory extraction output is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['l1', 'l2', 'l3'].includes(key))) throw new Error('memory extraction output is invalid');
  if ('l1' in record && record.l1 !== undefined && (typeof record.l1 !== 'object' || record.l1 === null)) throw new Error('memory extraction output is invalid');
  if ('l2' in record && record.l2 !== undefined && typeof record.l2 !== 'string') throw new Error('memory extraction output is invalid');
  if ('l3' in record && record.l3 !== undefined && typeof record.l3 !== 'string') throw new Error('memory extraction output is invalid');
  const result = { l1: record.l1, l2: typeof record.l2 === 'string' ? record.l2.trim() : undefined, l3: typeof record.l3 === 'string' ? record.l3.trim() : undefined };
  return result;
}

function sameSource(scope: MemoryScope, source: string, input: MemoryCaptureInput): boolean {
  return scope.userId === input.userId && scope.workspace === input.workspace && scope.sessionId === input.sessionId &&
    (scope.projectId ?? scope.workspace) === input.projectId && source === input.source;
}
