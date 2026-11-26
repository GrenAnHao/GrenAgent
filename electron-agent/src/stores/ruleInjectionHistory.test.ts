import { expect, it } from 'vitest';
import { RULE_INJECTION_ENTRY, ruleInjectionMessage } from '@extensions/context-rules/injectionNotice';
import { messagesFromAgent, type ChatMessage } from './agentReducer';
import { snapshotMessages } from './sessionSnapshot';

const receipt = (id: string) => ruleInjectionMessage({
  type: 'custom', customType: RULE_INJECTION_ENTRY, id, timestamp: '2026-11-18T08:00:00.000Z',
  data: { rules: [{ id: 'style', title: '项目风格', scope: 'project' }] },
})!;

it('restores the current branch receipt in order even with a longer UI history', () => {
  const user = { role: 'user', content: 'fixture request', timestamp: 1 };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'fixture reply' }], timestamp: 2 };
  const local: ChatMessage[] = [
    { kind: 'compaction', id: 'ui-only-divider' },
    ...messagesFromAgent([user, receipt('old-branch'), assistant]),
  ];
  const snapshot = snapshotMessages([user, receipt('current'), assistant], local, { backendLeaf: 'assistant' }).processed;
  expect(snapshot.map((message) => message.kind)).toEqual(['compaction', 'user', 'notice', 'assistant']);
  expect(snapshot[2].id).toBe(`${RULE_INJECTION_ENTRY}:current`);
});
