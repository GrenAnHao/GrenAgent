import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '../lib/pi';
import { sessionSignature } from '../lib/sessionMessageCache';
import { applyEvent, initialAgentState, type AgentState, type ChatMessage } from './agentReducer';
import { snapshotMessages } from './sessionSnapshot';
import { latestTodosFromMessages } from '../features/chat/input/latestTodos';

const details = (status: string, text = '验证并交付') => ({ todos: [{ id: 1, text, status }], nextId: 2 });
const card = (id: string, status: string): ChatMessage => ({ kind: 'tool', id, toolCallId: id, toolName: 'todo', args: {}, status: 'done', result: { details: details(status) } });
const result = (id: string, status: string): AgentMessage => ({ role: 'toolResult', toolName: 'todo', toolCallId: id, content: [{ type: 'text', text: status }], details: details(status) } as AgentMessage);
const stop = { role: 'assistant', content: [{ type: 'text', text: '交付完成' }], stopReason: 'stop', timestamp: 100 } as AgentMessage;
const statuses = (messages: ChatMessage[]) => latestTodosFromMessages(messages)?.map((todo) => todo.status);

describe('todo result consistency', () => {
  it('执行结果不依赖 start 帧存在', () => {
    const state = applyEvent(initialAgentState(), { type: 'tool_execution_end', toolCallId: 'missing', toolName: 'todo', isError: false, result: { details: details('completed') } } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
  });

  it('只有持久化结果消息到达时也能恢复清单', () => {
    const state = applyEvent(initialAgentState(), { type: 'message_end', message: result('only-message', 'completed') } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
  });

  it('回合完整结果补回缺失的最终 todo，放在最终正文之前', () => {
    const final = { kind: 'assistant', id: 'final', text: '交付完成', thinking: '', streaming: false, timestamp: 100 } as ChatMessage;
    const before = { ...initialAgentState(), messages: [card('previous', 'in_progress'), final] };
    const state = applyEvent(before, { type: 'agent_end', messages: [result('last-write', 'completed'), stop] } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
    expect(state.messages.map((m) => m.kind === 'tool' ? m.toolCallId : m.id)).toEqual(['previous', 'last-write', 'final']);
  });

  it('终态之后迟到的进度帧不回退已完成结果', () => {
    const state = applyEvent({ ...initialAgentState(), messages: [card('stable', 'completed')] }, {
      type: 'tool_execution_update', toolCallId: 'stable', toolName: 'todo', partialResult: { details: details('pending') },
    } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
  });

  it('旧调用迟到时不覆盖位置更靠后的新清单', () => {
    const state = applyEvent({ ...initialAgentState(), messages: [card('old', 'pending'), card('new', 'completed')] }, {
      type: 'tool_execution_end', toolCallId: 'old', toolName: 'todo', isError: false, result: { details: details('in_progress') },
    } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
  });

  it('较长 UI 历史不能遮住后端最终成功或清空结果', () => {
    const history: ChatMessage[] = [card('previous', 'in_progress'), { kind: 'notice', id: 'extra', customType: 'trace', content: '保留完整历史' }, { kind: 'assistant', id: 'final', text: '交付完成', thinking: '', streaming: false, timestamp: 100 }];
    const aligned = snapshotMessages([result('last-write', 'completed'), stop], history);
    expect(aligned.processed.some((m) => m.kind === 'notice')).toBe(true);
    expect(statuses(aligned.sanitized)).toEqual(['completed']);
    const cleared = snapshotMessages([{ ...result('clear', 'completed'), details: { todos: [], nextId: 1 } } as AgentMessage, stop], history);
    expect(statuses(cleared.sanitized)).toEqual([]);
  });

  it('agent_settled 在缺少 agent_end 时也使用最终消息重建收尾', () => {
    let state: AgentState = { ...initialAgentState(), runActive: true, messages: [card('tail', 'in_progress')] };
    state = applyEvent(state, { type: 'message_end', message: stop } as AgentEvent);
    state = applyEvent(state, { type: 'agent_settled' } as AgentEvent);
    expect(state.assistantStop).toBe('stop');
    expect(state.todoListFinished).toBe(true);
  });

  it('失败的 todo 批次不清除上一成功清单的完成标记', () => {
    const state = applyEvent({ ...initialAgentState(), todoListFinished: true, messages: [card('kept', 'completed')] }, {
      type: 'agent_end', messages: [{ role: 'toolResult', toolName: 'todo', toolCallId: 'failed', details: { todos: [], error: 'invalid' } }, { role: 'assistant', stopReason: 'error' }],
    } as AgentEvent);
    expect(state.todoListFinished).toBe(true);
    expect(statuses(state.messages)).toEqual(['completed']);
  });

  it('完整结果修正遗漏 start 加乱序回执造成的清单顺序', () => {
    const final = { kind: 'assistant', id: 'final', text: '交付完成', thinking: '', streaming: false, timestamp: 100 } as ChatMessage;
    const state = applyEvent({ ...initialAgentState(), messages: [card('new', 'completed'), card('old', 'in_progress'), final] }, {
      type: 'agent_end', messages: [result('old', 'in_progress'), result('new', 'completed'), stop],
    } as AgentEvent);
    expect(statuses(state.messages)).toEqual(['completed']);
    expect(state.messages.filter((m) => m.kind === 'tool').map((m) => m.toolCallId)).toEqual(['old', 'new']);
  });

  it('同消息数和末条正文时，todo 内容变化仍能让缓存失效', () => {
    const final = { kind: 'assistant', id: 'final', text: '相同正文', thinking: '', streaming: false } as ChatMessage;
    expect(sessionSignature([card('same', 'completed'), final])).not.toBe(sessionSignature([card('same', 'in_progress'), final]));
  });
});
