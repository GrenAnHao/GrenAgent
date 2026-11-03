import { randomUUID } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { knowledgeBudgetTokens, type KnowledgeMessageInput, type KnowledgeUsage } from '../../../shared/knowledgeKernelContracts';

export interface KnowledgeModelDispatchPorts {
  tokenReservation: number;
  timeoutMs?: number;
  withSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  reserve(input: { requestId: string; kind: 'model' | 'time'; reserved: KnowledgeUsage }): Promise<void>;
  finish(requestId: string, actual: KnowledgeUsage): Promise<void>;
  markDispatched?(requestId: string): Promise<void>;
  release?(requestId: string): Promise<void>;
  dispatch(input: KnowledgeMessageInput, signal: AbortSignal): Promise<AssistantMessage>;
  ack(requestId: string): Promise<void>;
}

/** Reservation and provider execution belong inside the same existing Wiki slot. */
export function dispatchKnowledgeModelRequest(input: KnowledgeMessageInput, ports: KnowledgeModelDispatchPorts, signal?: AbortSignal): Promise<AssistantMessage> {
  return ports.withSlot(async () => {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let lease: { id: string } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> = Promise.resolve();
    let renewalError: unknown;
    let dispatched = false;
    const reserveLease = async () => {
      const id = randomUUID();
      await ports.reserve({ requestId: id, kind: 'time', reserved: { activeTimeMs: 5000 } });
      lease = { id };
    };
    const finishLease = async () => {
      const current = lease; lease = undefined;
      if (current) await ports.finish(current.id, { activeTimeMs: 5000 });
    };
    const schedule = () => {
      timer = setTimeout(() => {
        pending = (async () => { await finishLease(); await reserveLease(); schedule(); })().catch(error => { renewalError = error; abort.abort(error); });
      }, 4500);
    };
    try {
      await ports.reserve({ requestId: input.requestId, kind: 'model', reserved: { totalTokens: ports.tokenReservation } });
      await reserveLease();
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      await ports.markDispatched?.(input.requestId);
      dispatched = true;
      schedule();
      deadline = setTimeout(() => abort.abort(new Error('MODEL_TIMEOUT')), ports.timeoutMs ?? 120000);
      const message = await ports.dispatch(input, abort.signal);
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      await pending;
      await finishLease();
      if (renewalError) throw renewalError;
      if (!message.usage || message.usage.totalTokens === 0 || message.stopReason === 'error' || message.stopReason === 'aborted') {
        // A partial/unknown response cannot refund a reservation as zero usage.
        await ports.finish(input.requestId, { totalTokens: ports.tokenReservation, unknown: true });
      } else {
        await ports.finish(input.requestId, { inputTokens: message.usage.input, outputTokens: message.usage.output, totalTokens: knowledgeBudgetTokens(message.usage) });
      }
      await ports.ack(input.requestId);
      return message;
    } finally {
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      await pending;
      if (timer) clearTimeout(timer);
      await finishLease();
      if (!dispatched) await ports.release?.(input.requestId);
      signal?.removeEventListener('abort', onAbort);
    }
  }, signal);
}
