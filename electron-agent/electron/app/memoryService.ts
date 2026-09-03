import { randomUUID } from 'node:crypto';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../agentData/memoryStore';
import type { EventBus } from './appServer/eventBus';
import type { ServiceTask } from './appServer/types';

export interface MemorySearchScope extends MemoryScope { projectId: string; query: string; limit?: number }
export interface MemoryCaptureInput extends MemoryScope { projectId: string; source: string; transcript: string; fingerprint: string }
export interface MemoryCaptureResult { changed: boolean; delta: string; fingerprint: string; taskId?: string }
export interface MemoryTaskQueue {
  enqueue(input: { id: string; kind: string; input: unknown; sourceProjectId?: string; sourceSessionId?: string; system?: boolean }): Promise<ServiceTask>;
  get?(id: string): ServiceTask | undefined;
}
interface MemoryServiceOptions { store: MemoryStore; queue: MemoryTaskQueue; eventBus?: Pick<EventBus, 'publish'> }
interface PendingCapture { scope: MemoryScope; source: string; fingerprint: string; delta: string }

export class MemoryService {
  private readonly pending = new Map<string, PendingCapture>();
  constructor(private readonly options: MemoryServiceOptions) {}

  search(scope: MemorySearchScope): Promise<MemoryRecord[]> {
    return Promise.resolve(this.options.store.search(scope, scope.query, scope.limit));
  }

  async capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult> {
    const captured = this.options.store.capture(input, input.source, input.transcript, input.fingerprint);
    if (!captured.changed || !captured.delta) return captured;
    const taskId = randomUUID();
    const scope = { ...input, scope: 'project' as const };
    this.pending.set(taskId, { scope, source: input.source, fingerprint: input.fingerprint, delta: captured.delta });
    void this.options.queue.enqueue({
      id: taskId,
      kind: 'memory_extract',
      input: { delta: captured.delta, source: input.source, fingerprint: input.fingerprint, userId: input.userId, projectId: input.projectId, workspace: input.workspace, sessionId: input.sessionId },
      sourceProjectId: input.projectId,
      sourceSessionId: input.sessionId,
      system: true,
    }).catch(() => {});
    return { ...captured, taskId };
  }

  completeExtraction(taskId: string, output: unknown): MemoryRecord[] {
    const capture = this.pending.get(taskId) ?? this.captureFromTask(taskId);
    if (!capture) throw new Error('memory capture task not found');
    const extraction = validateExtraction(output);
    const writes: MemoryRecord[] = [];
    if (extraction.l1 !== undefined) writes.push(this.options.store.upsert(capture.scope, { level: 1, content: JSON.stringify(extraction.l1), source: capture.source }));
    if (extraction.l2) writes.push(this.options.store.upsert(capture.scope, { level: 2, content: extraction.l2, source: capture.source }));
    if (extraction.l3) writes.push(this.options.store.upsert(capture.scope, { level: 3, content: extraction.l3, source: capture.source }));
    this.options.store.commitCapture(capture.scope, capture.source, capture.fingerprint);
    this.pending.delete(taskId);
    if (writes.length) this.options.eventBus?.publish({ id: randomUUID(), type: 'memory.updated', timestamp: Date.now(), projectId: capture.scope.projectId, data: { taskId, records: writes } });
    return writes;
  }

  private captureFromTask(taskId: string): PendingCapture | undefined {
    const task = this.options.queue.get?.(taskId);
    const input = task?.input as Record<string, unknown> | undefined;
    if (!task || task.kind !== 'memory_extract' || !input || typeof input.delta !== 'string') return undefined;
    if (typeof task.sourceProjectId !== 'string' || typeof input.source !== 'string') return undefined;
    return { scope: { userId: typeof input.userId === 'string' ? input.userId : 'local', projectId: task.sourceProjectId, workspace: typeof input.workspace === 'string' ? input.workspace : task.sourceProjectId, sessionId: typeof task.sourceSessionId === 'string' ? task.sourceSessionId : undefined }, source: input.source, fingerprint: typeof input.fingerprint === 'string' ? input.fingerprint : '', delta: input.delta };
  }
}

function validateExtraction(value: unknown): { l1?: unknown; l2?: string; l3?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory extraction output is invalid');
  const record = value as Record<string, unknown>;
  if ('l1' in record && record.l1 !== undefined && (typeof record.l1 !== 'object' || record.l1 === null)) throw new Error('memory extraction output is invalid');
  if ('l2' in record && record.l2 !== undefined && typeof record.l2 !== 'string') throw new Error('memory extraction output is invalid');
  if ('l3' in record && record.l3 !== undefined && typeof record.l3 !== 'string') throw new Error('memory extraction output is invalid');
  const result = { l1: record.l1, l2: typeof record.l2 === 'string' ? record.l2.trim() : undefined, l3: typeof record.l3 === 'string' ? record.l3.trim() : undefined };
  if (result.l1 === undefined && !result.l2 && !result.l3) throw new Error('memory extraction output is invalid');
  return result;
}
