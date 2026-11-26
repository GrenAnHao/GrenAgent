import { useMemo, useState } from 'react';
import { RULE_INJECTION_ENTRY, ruleInjectionMessage } from '@extensions/context-rules/injectionNotice';
import { ChatMessageItems } from '../../src/features/chat/ChatMessageItems';
import { groupMessages } from '../../src/features/chat/groupMessages';
import { applyEvent, initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer';
import { mergeLiveTail } from '../../src/stores/sessionMessageSync';
import { exposeActions, installBridge } from '../stubs';

installBridge({});

const data = { rules: [
  { id: 'language', title: '输出用中文', scope: 'global' },
  { id: 'code-style', title: '沿用项目代码风格', scope: 'project' },
] };
const entry = (id: string) => ({
  type: 'custom', customType: RULE_INJECTION_ENTRY, id, timestamp: '2026-11-18T08:00:00.000Z', data,
});
const response = (text: string) => ({ role: 'assistant', timestamp: 100, content: [{ type: 'text', text }] });
const history = [ruleInjectionMessage(entry('earlier'))!, response('已完成上一轮。')];
const started = () => ({ ...initialAgentState(), messages: messagesFromAgent(history) });
const noRules = { ...entry('empty'), data: { rules: [] } };

export default function RuleInjectionScenario() {
  const [state, setState] = useState(started);
  exposeActions({
    live: () => setState((previous) => [entry('current'), entry('current'), noRules].reduce(
      (next, item) => applyEvent(next, { type: 'entry_appended', entry: item }), previous,
    )),
    reload: () => {
      const snapshot = messagesFromAgent([...history, ruleInjectionMessage(entry('current'))!]);
      setState((previous) => ({ ...initialAgentState(), messages: mergeLiveTail(snapshot, previous.messages) }));
    },
  });
  const display = useMemo(() => groupMessages(state.messages), [state.messages]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: 'min(680px, 100%)', margin: 'auto', background: 'var(--gren-content-bg)' }}>
      <ChatMessageItems messages={display} unitsByMessage={new Map()} answeredQuestions={new Set()} />
    </div>
  );
}
