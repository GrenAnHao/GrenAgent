import { useMemo, useState, type ReactElement } from 'react';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import type { AgentStoreApi } from '../../src/stores/agent';
import { applyEvent, initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer';
import type { AgentEvent, AgentMessage } from '../../src/lib/pi';
import { groupMessages } from '../../src/features/chat/groupMessages';
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute';
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems';
import { AgentIdentityContext } from '../../src/features/chat/AgentCommunicationCard';
import { SubAgentConversation } from '../../src/features/panels/SubAgentConversation';
import { exposeActions, exposeData, installBridge } from '../stubs';

installBridge({ invoke: async (command: string) => {
  if (command === 'subagent_list') return [];
  throw new Error(`unexpected command: ${command}`);
} });
const HISTORY_BODY = 'API 密钥已经挪到 `.env.local`，现在不用处理，等我下次叫你时再用。';
const LIVE_BODY = '最终结果：三个失败用例都是时区问题，已在 `date.ts` 修好，测试全绿。';
const SENT_BODY = '先核对 **取消路径**，再把结果发给我。\n\n保留全部失败原因。';
const LONG_BODY = `${Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 段：完整保留通信正文与上下文。`).join('\n\n')}\n\n${'LongToken'.repeat(200)}\n\n完整消息的最后一段。`;
const quiet = (from: string, body: string) => `Agent ${from} sent a message without waking you:\n${body}`;
const history = [
  { role: 'custom', customType: 'agent-message', content: quiet('sa-1', HISTORY_BODY), details: { from: 'sa-1' }, display: true, timestamp: 1000 },
  { role: 'custom', customType: 'skill-hint', content: '# 注入\n- 一条普通的上下文注入', display: true },
  { role: 'assistant', content: [{ type: 'text', text: '发送前的判断。' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'send-1', name: 'send_message', arguments: { agent_id: 'sa-2', message: SENT_BODY, wake: false } }] },
  { role: 'toolResult', toolCallId: 'send-1', toolName: 'send_message', content: [{ type: 'text', text: 'message delivered to agent sa-2 without waking it; it will see the message the next time it runs' }], details: { woken: false, delivery: 'appended' } },
  { role: 'assistant', content: [{ type: 'text', text: '发送后的下一步。' }] },
  { role: 'user', content: 'Agent sa-2 sent a message: 正在核对取消路径，这是中间进展。', timestamp: 2000 },
] as unknown as AgentMessage[];
const presentationState = initialAgentState();
const context = {
  workspace: 'ui-harness-agent-message',
  store: {
    getLoadedSessionPath: () => '/agent-message.jsonl',
    useStore: (selector: (value: typeof presentationState) => unknown) => selector(presentationState),
  } as unknown as AgentStoreApi,
  workspaceReady: false, setWorkspaceReady: () => {}, appBooted: true,
};
let act: (name: string, timestamp?: number) => void = () => {};
exposeActions({
  pushLive: (timestamp = 3000) => act('live', timestamp),
  pushWaking: () => act('waking'),
  showLong: () => act('long'),
  showEmpty: () => act('empty'),
  showCodemode: () => act('codemode'),
  showChild: () => act('child'),
  reset: () => act('reset'),
});
exposeData({ historyBody: HISTORY_BODY, liveBody: LIVE_BODY, sentBody: SENT_BODY });

const childTranscript = [
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子代理的中间输出。' }] } },
  { type: 'tool_execution_start', toolCallId: 'child-send', toolName: 'send_message', args: { agent_id: 'parent-1', message: '子代理给父代理的完整报告。', wake: false } },
  { type: 'tool_execution_end', toolCallId: 'child-send', toolName: 'send_message', result: { content: [{ type: 'text', text: 'message delivered to agent parent-1 without waking it' }], details: { woken: false, delivery: 'appended' } } },
  { type: 'message_end', message: { role: 'custom', customType: 'agent-message', content: quiet('parent-1', '父代理回复子代理的完整指令。'), details: { from: 'parent-1' }, display: true, timestamp: 6000 } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子代理的最终输出。' }] } },
].map((event) => JSON.stringify(event)).join('\n');

function Timeline(): ReactElement {
  const [child, setChild] = useState(false);
  const [state, setState] = useState(() => ({ ...initialAgentState(), messages: messagesFromAgent(history) }));
  act = (name, timestamp = 3000) => {
    setChild(name === 'child');
    if (name === 'child') return;
    if (name === 'reset') { setState({ ...initialAgentState(), messages: messagesFromAgent(history) }); return; }
    if (name === 'long' || name === 'empty') {
      const message = { role: 'custom', customType: 'agent-message', content: name === 'long' ? quiet('sa-long', LONG_BODY) : '', details: { from: 'sa-empty' }, display: true, timestamp: 4000 };
      setState({ ...initialAgentState(), messages: messagesFromAgent([message as unknown as AgentMessage]) });
      return;
    }
    if (name === 'codemode') {
      const calls = [
        { id: 'record-send', name: 'send_message', args: JSON.stringify({ agent_id: 'sa-history', message: '嵌套历史消息完整可见', wake: false }), status: 'ok' },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `read-${i}`, name: 'read', args: JSON.stringify({ path: `a${i}.ts` }), status: 'ok' })),
        { id: 'partial-send', name: 'send_message', args: '{"agent_id":"sa-partial","message":"上游截短的内容...', status: 'ok' },
      ];
      const messages = messagesFromAgent([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'code', name: 'codemode', arguments: { code: '// communication and independent reads' } }] },
        { role: 'toolResult', toolCallId: 'code', toolName: 'codemode', content: [{ type: 'text', text: 'Script completed\nWall time 1 seconds\nOutput:\n' }], details: { calls } },
      ] as unknown as AgentMessage[]);
      setState({ ...initialAgentState(), messages });
      return;
    }
    const message = name === 'waking'
      ? { role: 'user', content: 'Agent sa-3 sent a message: 实时唤醒消息正文。', timestamp: 5000 }
      : { role: 'custom', customType: 'agent-message', content: quiet('sa-7', LIVE_BODY), details: { from: 'sa-7' }, display: true, timestamp };
    setState((previous) => applyEvent(applyEvent(previous, { type: 'message_start', message } as unknown as AgentEvent), { type: 'message_end', message } as unknown as AgentEvent));
  };
  const display = useMemo(() => groupMessages(state.messages), [state.messages]);
  const index = useMemo(() => computeSubAgentUnits(display), [display]);
  if (child) return <div id="timeline" style={{ height: 740, width: 'min(720px, 100%)', margin: '0 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <SubAgentConversation task="核对子代理通信身份" result={{ details: { transcript: childTranscript } }} status="done" workspace={context.workspace} agentId="sa-child" />
  </div>;
  return <div id="timeline" style={{ width: 'min(720px, 100%)', margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' }}>
    {display.map((message) => <div key={message.id} style={{ marginBottom: 12 }}>
      {renderMessageBody(message.kind === 'turn' ? { ...message, timestamp: undefined } : message, index.unitsByMessage, new Set())}
    </div>)}
  </div>;
}

export default function AgentMessageScenario(): ReactElement {
  return <AgentStoreContext.Provider value={context}>
    <AgentIdentityContext.Provider value="parent-1">
      <div id="agent-message-scroll" style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}><Timeline /></div>
    </AgentIdentityContext.Provider>
  </AgentStoreContext.Provider>;
}
