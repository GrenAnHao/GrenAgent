import { describe, expect, it } from 'vitest';
import { findPendingAskUser } from './pendingAskUser';

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
});
