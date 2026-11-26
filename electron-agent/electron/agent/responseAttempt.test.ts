import { describe, expect, it } from 'vitest';
import { createResponseAttemptBinder } from './responseAttempt.js';
import { toRendererEvent } from './streamingEvent.js';
import { createToolcallDeltaCoalescer } from './toolcallDeltaCoalescer.js';

describe('SDK response attempt identity', () => {
  it('captures source message identity before json-event removes snapshots', () => {
    const bind = createResponseAttemptBinder();
    const old = { role: 'assistant', timestamp: 1000, content: [] };
    const current = { role: 'assistant', timestamp: 1001, content: [] };
    bind({ type: 'agent_start' });
    bind({ type: 'message_start', message: old });
    expect(bind({ type: 'auto_retry_start', attempt: 1 })).toEqual({ runId: 1, attempt: 1 });
    bind({ type: 'message_start', message: current });
    const fresh = { type: 'message_update', message: current, assistantMessageEvent: { type: 'thinking_delta', delta: 'new', partial: current } };
    expect(toRendererEvent(fresh as never)).not.toHaveProperty('message');
    expect(bind(fresh)).toEqual({ runId: 1, attempt: 1 });
    expect(bind({ ...fresh, message: old })).toEqual({ runId: 1, attempt: 0 });
    expect(bind({ ...fresh, message: { role: 'assistant', content: [] } })).toBeUndefined();
  });

  it('does not coalesce deltas from different attempts even when their content index matches', () => {
    const emitted: Record<string, unknown>[] = [];
    const merge = createToolcallDeltaCoalescer(event => emitted.push(event), 1000);
    const delta = (attempt: number, text: string) => ({ type: 'message_update', responseAttempt: { runId: 1, attempt },
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: text } });
    merge.push(delta(0, 'old'));
    merge.push(delta(1, 'new'));
    merge.flush();
    expect(emitted).toHaveLength(2);
    expect((emitted[0].assistantMessageEvent as { delta: string }).delta).toBe('old');
    expect((emitted[1].assistantMessageEvent as { delta: string }).delta).toBe('new');
  });
});
