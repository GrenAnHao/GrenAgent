import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { KNOWLEDGE_FRAME_MAX_BYTES, type KnowledgeMessageInput, type KnowledgeModelBinding } from '../../shared/knowledgeKernelContracts';

/** Adapt a full-message request to the event contract expected by the SDK Agent. */
export function createKnowledgeStreamFn(request: (...args: Parameters<StreamFn>) => Promise<AssistantMessage>): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const message = await request(model, context, options);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } else if (message.stopReason === 'pending') {
          throw new Error('Invalid pending assistant response');
        } else {
          stream.push({ type: 'done', reason: message.stopReason, message });
        }
      } catch (error) {
        const aborted = options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
        const message: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
      }
    })();
    return stream;
  };
}

export interface KnowledgeUsageReport { requestId: string; taskId: string; controllerEpoch: string; usage?: AssistantMessage['usage']; unknown: boolean }

/** Main-process owner of provider calls and unacknowledged terminal usage. */
export class KnowledgeMessageBroker {
  private epoch?: string;
  private active = false;
  private bindingEpoch = false;
  private readonly bindings = new Map<string, { taskId: string; epoch: string; binding: KnowledgeModelBinding }>();
  private readonly inflight = new Map<string, { abort: AbortController; settled: Promise<void> }>();
  private readonly reports = new Map<string, KnowledgeUsageReport>();
  private readonly seenRequests = new Set<string>();

  constructor(private readonly port: {
    bind(taskId: string): Promise<KnowledgeModelBinding>;
    request(binding: KnowledgeModelBinding, transcript: KnowledgeMessageInput['transcript'], options: KnowledgeMessageInput['options'] & { signal: AbortSignal }): Promise<AssistantMessage>;
    drainWorkers?: (epoch: string) => Promise<void>;
    drainTimeoutMs?: number;
  }) {}

  async bindEpoch(epoch: string): Promise<KnowledgeUsageReport[]> {
    if (this.bindingEpoch) throw new Error('EPOCH_BIND_IN_PROGRESS');
    this.bindingEpoch = true;
    this.active = false;
    const oldEpoch = this.epoch;
    for (const entry of this.inflight.values()) entry.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = Promise.all([...this.inflight.values()].map(entry => entry.settled).concat(oldEpoch && oldEpoch !== epoch && this.port.drainWorkers ? [this.port.drainWorkers(oldEpoch)] : []));
      await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OLD_EXECUTOR_NOT_DRAINED')), this.port.drainTimeoutMs ?? 30000); })]);
      this.bindings.clear();
      this.epoch = epoch;
      return [...this.reports.values()];
    } finally { if (timer) clearTimeout(timer); this.bindingEpoch = false; }
  }

  activateEpoch(epoch: string): void {
    if (this.epoch !== epoch) throw new Error('STALE_EPOCH');
    this.active = true;
  }

  async bind(taskId: string): Promise<KnowledgeModelBinding> {
    if (!this.active || !this.epoch) throw new Error('EPOCH_NOT_ACTIVE');
    const epoch = this.epoch;
    const binding = await this.port.bind(taskId);
    if (!this.active || this.epoch !== epoch) throw new Error('STALE_EPOCH');
    if (!taskId.startsWith('admission:')) this.bindings.set(binding.bindingId, { taskId, epoch, binding });
    return binding;
  }

  async request(input: KnowledgeMessageInput, signal?: AbortSignal): Promise<AssistantMessage> {
    if (Buffer.byteLength(JSON.stringify(input)) > KNOWLEDGE_FRAME_MAX_BYTES) throw new Error('FRAME_TOO_LARGE');
    const entry = this.bindings.get(input.bindingId);
    if (!this.active || input.controllerEpoch !== this.epoch || input.fence.controllerEpoch !== this.epoch || entry?.epoch !== this.epoch || entry.taskId !== input.taskId) throw new Error('STALE_EPOCH');
    if (this.seenRequests.has(input.requestId)) throw new Error('DUPLICATE_REQUEST');
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    this.seenRequests.add(input.requestId);
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.inflight.set(input.requestId, { abort, settled });
    try {
      const message = await this.port.request(entry.binding, input.transcript, { ...input.options, signal: abort.signal });
      this.reports.set(input.requestId, { requestId: input.requestId, taskId: input.taskId, controllerEpoch: input.controllerEpoch, usage: message.usage, unknown: message.stopReason === 'error' || message.stopReason === 'aborted' || !message.usage || message.usage.totalTokens === 0 });
      if (Buffer.byteLength(JSON.stringify(message)) > KNOWLEDGE_FRAME_MAX_BYTES) throw new Error('FRAME_TOO_LARGE');
      return message;
    } catch (error) {
      if (!this.reports.has(input.requestId)) this.reports.set(input.requestId, { requestId: input.requestId, taskId: input.taskId, controllerEpoch: input.controllerEpoch, unknown: true });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(input.requestId);
      settle();
    }
  }

  ackUsage(requestId: string): boolean { return this.reports.delete(requestId); }
  abortRequest(requestId: string): boolean { const request = this.inflight.get(requestId); if (!request) return false; request.abort.abort(); return true; }
}
