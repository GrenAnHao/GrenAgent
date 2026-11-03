import { describe, expect, it, vi } from 'vitest';
import { dispatchKnowledgeModelRequest } from './modelRequests';
import { create, fixture } from './testFixture';

describe('knowledge request reservations', () => {
  it('reserves only after the shared slot is acquired and finishes before acknowledging', async () => {
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const calls: string[] = [];
    const request: any = { requestId: 'model', taskId: 'task', fence: {}, phase: 'generate', itemId: 'page', attempt: 1, options: { maxTokens: 10 } };
    const run = dispatchKnowledgeModelRequest(request, { tokenReservation: 100, withSlot: async work => { await gate; return work(); }, reserve: async i => { calls.push(`reserve:${i.kind}`); }, finish: async (id) => { calls.push(`finish:${id}`); }, dispatch: async () => { calls.push('dispatch'); return { usage: { input: 2, output: 3, totalTokens: 5 } } as any; }, ack: async () => { calls.push('ack'); } });
    await Promise.resolve(); expect(calls).toEqual([]);
    unlock(); await run;
    expect(calls.slice(0, 3)).toEqual(['reserve:model', 'reserve:time', 'dispatch']);
    expect(calls.indexOf('finish:model')).toBeLessThan(calls.indexOf('ack'));
  });

  it('persists provider reservations before dispatch and settles actual usage', async () => {
    const { storage, store } = fixture();
    try {
      const task = create(store), fence = store.claim('scope', task.id, 'owner', 0);
      store.beginAttempt(task.id, 'generate', 'page', fence, 'input');
      const input: any = { requestId: 'model', taskId: task.id, fence, phase: 'generate', itemId: 'page', attempt: 1, options: { maxTokens: 10 } };
      await dispatchKnowledgeModelRequest(input, {
        tokenReservation: 100, withSlot: async work => work(),
        reserve: async entry => { store.reserveExecutionBudget({ ...entry, taskId: task.id, phase: 'generate', itemId: 'page', attempt: 1, fence }); },
        finish: async (id, usage) => { store.finishExecutionBudget(id, usage); },
        markDispatched: async id => { store.markExecutionDispatched(id); }, release: async id => { store.releaseExecutionBudget(id); },
        dispatch: async () => { expect(store.getExecutionRequest('model')?.state).toBe('dispatched'); expect(store.usage(task.id).activeTimeMs).toBe(5000); return { stopReason: 'stop', usage: { input: 2, output: 3, totalTokens: 5 } } as any; }, ack: async () => {},
      });
      expect(store.usage(task.id)).toMatchObject({ modelRequests: 1, totalTokens: 5, activeTimeMs: 5000 });
    } finally { storage.close(); }
  });

  it('keeps an aborted dispatched provider in its slot until it really settles', async () => {
    let complete!: () => void;
    const provider = new Promise<void>(resolve => { complete = resolve; });
    const abort = new AbortController();
    let finished = false, sawAbort = false, dispatched = false;
    const running = dispatchKnowledgeModelRequest({ requestId: 'r', options: { maxTokens: 1 } } as any, {
      tokenReservation: 10, withSlot: async work => work(), reserve: async () => {}, finish: async () => {}, ack: async () => {},
      dispatch: async (_input, signal) => { dispatched = true; signal.addEventListener('abort', () => { sawAbort = true; }); await provider; return { stopReason: 'aborted', usage: { input: 0, output: 0, totalTokens: 0 } } as any; },
    }, abort.signal).finally(() => { finished = true; });
    await vi.waitFor(() => expect(dispatched).toBe(true)); abort.abort();
    expect(sawAbort).toBe(true); expect(finished).toBe(false);
    complete(); await running;
    expect(finished).toBe(true);
  });
});
