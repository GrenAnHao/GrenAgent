import { describe, expect, it } from 'vitest';
import { findAskUserCallOwner, findPendingAskUser, isDeadAssistantTurn } from './pendingAskUser';

const ask = (id: string, question: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'ask_user', arguments: { questions: [{ question, options: [{ label: '甲' }, { label: '乙' }] }] } }],
});
const result = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'ask_user', content: [{ type: 'text', text: 'done' }] });

describe('findPendingAskUser', () => {
  it('returns null when the only ask_user has a tool result', () => {
    expect(findPendingAskUser([ask('a', '第一题'), result('a')])).toBeNull();
  });

  it('returns the last unanswered ask_user and ignores an earlier one', () => {
    const pending = findPendingAskUser([ask('a', '旧题'), ask('b', '新题')]);
    expect(pending?.toolCallId).toBe('b');
    expect(pending?.args).toMatchObject({ questions: [{ question: '新题' }] });
  });

  it('returns null when there is no ask_user', () => {
    expect(findPendingAskUser([{ role: 'user', content: 'hi' }])).toBeNull();
  });

  it('keeps the card pending when another tool of the same turn already answered', () => {
    const turn = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'sh', name: 'bash', arguments: {} },
        { type: 'toolCall', id: 'a', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } },
      ],
    };
    const pending = findPendingAskUser([turn, { role: 'toolResult', toolCallId: 'sh', content: [] }]);
    expect(pending?.toolCallId).toBe('a');
  });

  it('drops the card once a user message follows the call', () => {
    expect(findPendingAskUser([ask('a', '第一题'), { role: 'user', content: 'hi' }])).toBeNull();
  });

  it('drops the card once a later assistant turn follows the call', () => {
    const errored = { role: 'assistant', content: [], stopReason: 'error' };
    expect(findPendingAskUser([ask('a', '第一题'), errored])).toBeNull();
  });
});

describe('findAskUserCallOwner', () => {
  it('finds the assistant message that issued the call', () => {
    const aborted = { ...ask('a', '第一题'), stopReason: 'aborted' };
    const owner = findAskUserCallOwner([{ role: 'user', content: 'hi' }, aborted], 'a');
    expect(owner?.message).toBe(aborted);
    expect(owner?.call.args).toMatchObject({ questions: [{ question: '第一题' }] });
  });

  it('returns null for an unknown tool call id', () => {
    expect(findAskUserCallOwner([ask('a', '第一题')], 'b')).toBeNull();
  });
});

describe('isDeadAssistantTurn', () => {
  it('treats aborted and errored turns as dead', () => {
    expect(isDeadAssistantTurn({ role: 'assistant', stopReason: 'aborted' })).toBe(true);
    expect(isDeadAssistantTurn({ role: 'assistant', stopReason: 'error' })).toBe(true);
  });

  it('treats a normal tool-use turn as alive', () => {
    expect(isDeadAssistantTurn({ role: 'assistant', stopReason: 'toolUse' })).toBe(false);
    expect(isDeadAssistantTurn({ role: 'assistant' })).toBe(false);
  });
});
