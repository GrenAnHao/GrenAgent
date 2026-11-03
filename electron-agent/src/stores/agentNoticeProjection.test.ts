import { describe, expect, it } from 'vitest';
import { applyEvent, initialAgentState, messagesFromAgent } from './agentReducer';
import type { AgentMessage } from '../lib/pi';
import { mergeLiveTail } from './sessionMessageSync';

const notice = (overrides: Record<string, unknown> = {}) => ({
  role: 'custom', customType: 'agent-message', display: true,
  content: 'Agent sa-1 sent a message without waking you:\n结果正文',
  timestamp: 1000, details: { from: 'sa-1', wake: false }, ...overrides,
}) as unknown as AgentMessage;

describe('agent event presentation metadata', () => {
  it('keeps sender details and original time in history and live projections', () => {
    const message = notice();
    const history = messagesFromAgent([message]);
    const live = applyEvent(initialAgentState(), { type: 'message_end', message } as never).messages;
    for (const projected of [history[0], live[0]]) {
      expect(projected).toMatchObject({ kind: 'notice', details: { from: 'sa-1' }, sourceTimestamp: 1000 });
    }
  });

  it('shows a known empty terminal notice using its structured identity and reason', () => {
    const message = notice({ customType: 'subagent-settled', content: '', details: { childId: 'sa-2', stopReason: 'error' } });
    for (const messages of [messagesFromAgent([message]), applyEvent(initialAgentState(), { type: 'message_end', message } as never).messages]) {
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ details: { childId: 'sa-2', stopReason: 'error' } });
    }
  });

  it('updates the same event in place and ignores a late start after an end', () => {
    const end = notice({ customType: 'subagent-settled', content: 'final body', details: { childId: 'sa-1', stopReason: 'completed' } });
    const start = notice({ customType: 'subagent-settled', content: 'partial body', details: { childId: 'sa-1' } });
    let state = applyEvent(initialAgentState(), { type: 'message_start', message: start } as never);
    const id = state.messages[0]?.id;
    state = applyEvent(state, { type: 'message_end', message: end } as never);
    state = applyEvent(state, { type: 'message_start', message: start } as never);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id, content: 'final body' });
  });

  it('retains identical repeated messages and distinct tasks, and dedupes end replay', () => {
    const first = notice();
    const second = notice({ timestamp: 1001 });
    let state = initialAgentState();
    for (const message of [first, second, first]) state = applyEvent(state, { type: 'message_end', message } as never);
    expect(state.messages).toHaveLength(2);
    const a = notice({ customType: 'job-done', details: { jobId: 'bash-1', status: 'completed' } });
    const b = notice({ customType: 'job-done', details: { jobId: 'bash-2', status: 'completed' } });
    for (const message of [a, b, a]) state = applyEvent(state, { type: 'message_end', message } as never);
    expect(state.messages).toHaveLength(4);
  });

  it('does not overwrite different communication messages from the same sender within one millisecond', () => {
    let state = initialAgentState();
    for (const message of [notice(), notice({ content: 'Agent sa-1 sent a message without waking you:\n另一条正文' })]) {
      state = applyEvent(state, { type: 'message_start', message } as never);
      state = applyEvent(state, { type: 'message_end', message } as never);
    }
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ content: 'Agent sa-1 sent a message without waking you:\n另一条正文' });
  });

  it('receives waking deliveries in live events once, just like history, without duplicating human input', () => {
    const message = { role: 'user', content: 'Agent sa-8 sent a message: intermediate finding', timestamp: 42 } as unknown as AgentMessage;
    let state = initialAgentState();
    for (const type of ['message_start', 'message_end', 'message_start']) state = applyEvent(state, { type, message } as never);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ kind: 'user', text: 'Agent sa-8 sent a message: intermediate finding', timestamp: 42 });
    const human = { role: 'user', content: 'hello', timestamp: 43 };
    expect(applyEvent(state, { type: 'message_start', message: human } as never).messages).toHaveLength(1);
  });

  it('does not lose a repeated send when a persisted snapshot overlaps only the first live message', () => {
    const [persisted] = messagesFromAgent([notice({ timestamp: 1001 })]);
    const tail = messagesFromAgent([notice({ timestamp: 1000 }), notice({ timestamp: 2000 })]);
    const merged = mergeLiveTail([persisted], tail);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(persisted.id);
  });

  it('does not let malformed metadata or empty unrelated injections create blank blocks', () => {
    expect(messagesFromAgent([notice({ customType: 'extension-context', content: '', details: {} })])).toEqual([]);
    const [projected] = messagesFromAgent([notice({ details: null, timestamp: Number.NaN })]);
    expect(projected.kind === 'notice' && projected.sourceTimestamp).toBeUndefined();
  });
});
