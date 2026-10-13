import { describe, it, expect, vi } from 'vitest';
import {
  initialAgentState,
  applyEvent,
  nextRunStartedAt,
  pinRunClock,
  addUserMessage,
  dropUnpersistedUserTail,
  rollbackUnansweredSend,
  messagesFromAgent,
  messagesFromTranscript,
  interruptPendingToolCards,
  excludedFromAgent,
  materializeToolDrafts,
  LARGE_ARGS_CHARS,
  type AgentState,
  type ChatMessage,
} from './agentReducer';
import { parsePartialArgs } from '../lib/streamingJson';
import type { AgentEvent } from '../lib/pi';
import { groupMessages } from '../features/chat/groupMessages';
import { buildTurnRows } from '../features/chat/turnRows';

function text(msg: ChatMessage): string {
  return msg.kind === 'assistant' || msg.kind === 'user' ? msg.text : '';
}

describe('applyEvent', () => {
  it('starts streaming assistant message on message_start', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.isStreaming).toBe(true);
    s = applyEvent(s, {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    } as AgentEvent);
    expect(s.messages.at(-1)?.kind).toBe('assistant');
  });

  it('replaces streaming text from message_update snapshots (not append)', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
    } as AgentEvent);
    expect(text(s.messages.at(-1)!)).toBe('Hello world'); // 替换语义：不是 'HelloHello world'
  });

  it('tracks compaction status via compaction_start / compaction_end', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'compaction_start', reason: 'auto' } as AgentEvent);
    expect(s.compacting).toBe(true);
    s = applyEvent(s, { type: 'compaction_end', reason: 'auto', aborted: false, willRetry: false } as AgentEvent);
    expect(s.compacting).toBe(false);
    expect(s.messages.at(-1)).toMatchObject({ kind: 'compaction' });
  });

  it('surfaces a failed compaction (aborted, no retry, with message) as lastError', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'compaction_start', reason: 'auto' } as AgentEvent);
    s = applyEvent(s, {
      type: 'compaction_end',
      reason: 'auto',
      aborted: true,
      willRetry: false,
      errorMessage: 'boom',
    } as AgentEvent);
    expect(s.compacting).toBe(false);
    expect(s.lastError).toBe('boom');
    expect(s.messages.some((message) => message.kind === 'compaction')).toBe(false);
  });

  it('does not mark compaction done when overflow recovery fails without abort', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt.',
    } as AgentEvent);
    expect(s.compacting).toBe(false);
    expect(s.lastError).toContain('overflow');
    expect(s.messages.some((message) => message.kind === 'compaction')).toBe(false);
  });

  it('does not surface an error when compaction will auto-retry', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'compaction_start', reason: 'auto' } as AgentEvent);
    s = applyEvent(s, {
      type: 'compaction_end',
      reason: 'auto',
      aborted: true,
      willRetry: true,
      errorMessage: 'transient',
    } as AgentEvent);
    expect(s.compacting).toBe(false);
    expect(s.lastError).toBeUndefined();
  });

  it('clears an abort error when compaction starts', () => {
    let s: AgentState = { ...initialAgentState(), lastError: 'Request was aborted' };
    s = applyEvent(s, { type: 'compaction_start', reason: 'manual' } as AgentEvent);
    expect(s.compacting).toBe(true);
    expect(s.lastError).toBeUndefined();
  });

  it('keeps a real error when compaction starts', () => {
    let s: AgentState = { ...initialAgentState(), lastError: 'context length exceeded' };
    s = applyEvent(s, { type: 'compaction_start', reason: 'manual' } as AgentEvent);
    expect(s.lastError).toBe('context length exceeded');
  });

  it('clears compacting on agent_end (defensive)', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'compaction_start', reason: 'auto' } as AgentEvent);
    s = applyEvent(s, { type: 'agent_end' } as AgentEvent);
    expect(s.compacting).toBe(false);
  });

  it('clears waitingUiPrompt on agent_end', () => {
    let s: AgentState = { ...initialAgentState(), waitingUiPrompt: { kind: 'select', title: '请求批准' } };
    s = applyEvent(s, { type: 'agent_end' } as AgentEvent);
    expect(s.waitingUiPrompt).toBeUndefined();
  });

  it('remembers a finished todo list until a later todo write, not the next run', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'tool_execution_start',
      toolCallId: 'todo-1',
      toolName: 'todo',
      args: {},
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'tool_execution_end',
      toolCallId: 'todo-1',
      toolName: 'todo',
      isError: false,
      result: { details: { todos: [{ id: 1, text: '注册', status: 'completed' }], nextId: 2 } },
    } as AgentEvent);
    expect(s.todoListFinished).toBe(false);
    s = applyEvent(s, {
      type: 'agent_end',
      messages: [
        { role: 'toolResult', toolName: 'todo', details: { todos: [{ id: 1, text: '注册', status: 'completed' }], nextId: 2 } },
        { role: 'assistant', stopReason: 'stop', content: 'done' },
      ],
    } as AgentEvent);
    expect(s.todoListFinished).toBe(true);
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop', content: '下一轮没有改清单' }],
    } as AgentEvent);
    expect(s.todoListFinished).toBe(true);
  });

  it('records a normal stop and clears it when the next run starts', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop', content: 'done' }],
    } as AgentEvent);
    expect(s.assistantStop).toBe('stop');
    expect(s.runActive).toBe(true);
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.assistantStop).toBeUndefined();
  });

  it('does not treat abort as a normal stop', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'aborted', content: '' }],
    } as AgentEvent);
    expect(s.assistantStop).toBe('aborted');
  });

  it('finalizes on agent_end and clears streaming', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(s.isStreaming).toBe(false);
  });

  it('keeps runStartedAt from the first agent_start through retries and past settled', () => {
    let s = applyEvent(initialAgentState(), { type: 'agent_start' } as AgentEvent);
    const started = s.runStartedAt;
    expect(started).toEqual(expect.any(Number));
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(s.runStartedAt).toBe(started);
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.runStartedAt).toBe(started);
    s = applyEvent(s, { type: 'agent_settled' } as AgentEvent);
    expect(s.runStartedAt).toBe(started);
    expect(s.runActive).toBe(false);
  });

  describe('正在处理的计时起点', () => {
    const user = (text: string) => ({ type: 'message_start', message: { role: 'user', content: text, timestamp: 1 } }) as unknown as AgentEvent;
    const custom = (customType: string) =>
      ({ type: 'message_start', message: { role: 'custom', customType, content: 'x', display: false, timestamp: 1 } }) as unknown as AgentEvent;
    const system = { type: 'message_start', message: { role: 'system', content: '', timestamp: 1 } } as unknown as AgentEvent;
    const assistant = { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } } as unknown as AgentEvent;
    const settledRun = (startedAt: number): AgentState => ({
      ...initialAgentState(),
      runStartedAt: startedAt,
      runActive: false,
      isStreaming: false,
    });

    it('子代理回报 / 压缩续跑这类自定义消息开的回合接着上一轮计时', () => {
      let s = applyEvent(settledRun(1000), { type: 'agent_start' } as AgentEvent);
      expect(s.runOpening).toBe(true);
      s = applyEvent(s, system);
      expect(s.runOpening).toBe(true);
      s = applyEvent(s, custom('subagent-settled'));
      expect(s.runStartedAt).toBe(1000);
      expect(s.runOpening).toBe(false);
    });

    it('没有消息、直接续写助手的回合也沿用', () => {
      let s = applyEvent(settledRun(1000), { type: 'agent_start' } as AgentEvent);
      s = applyEvent(s, assistant);
      expect(s.runStartedAt).toBe(1000);
      expect(s.runOpening).toBe(false);
    });

    it('界面没钉过的用户消息开新回合：从现在重新起算', () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      try {
        let s = applyEvent(settledRun(1000), { type: 'agent_start' } as AgentEvent);
        s = applyEvent(s, user('别处发来的新请求'));
        expect(s.runStartedAt).toBe(50_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('跟进被推迟到上一轮 settled 之后：界面钉过，接着上一轮计时', () => {
      let s: AgentState = { ...initialAgentState(), runStartedAt: 1000, runActive: true };
      s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
      s = { ...s, ...pinRunClock(s) };
      expect(s.runStartedAt).toBe(1000);
      s = applyEvent(s, { type: 'agent_settled' } as AgentEvent);
      s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
      s = applyEvent(s, user('跟进'));
      expect(s.runStartedAt).toBe(1000);
      expect(s.runOriginPinned).toBe(false);
    });

    it('空闲时发送：用发送那一刻做起点，不被稍晚到达的用户消息往后推', () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      try {
        let s: AgentState = { ...settledRun(1000) };
        s = { ...s, ...pinRunClock(s) };
        expect(s.runStartedAt).toBe(20_000);
        vi.setSystemTime(23_000);
        s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
        s = applyEvent(s, user('新问题'));
        expect(s.runStartedAt).toBe(20_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('界面钉过的自定义消息回合（计划执行）用钉的起点', () => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      try {
        let s: AgentState = { ...settledRun(1000) };
        s = { ...s, ...pinRunClock(s) };
        s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
        s = applyEvent(s, custom('plan-build'));
        expect(s.runStartedAt).toBe(30_000);
        expect(s.runOriginPinned).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('回合中途的引导不动起点，只用掉钉定', () => {
      let s = applyEvent(settledRun(1000), { type: 'agent_start' } as AgentEvent);
      s = applyEvent(s, custom('subagent-settled'));
      s = { ...s, ...pinRunClock(s) };
      expect(s.runStartedAt).toBe(1000);
      s = applyEvent(s, user('引导'));
      expect(s.runStartedAt).toBe(1000);
      expect(s.runOriginPinned).toBe(false);
    });

    it('重试带来的 agent_start 不当成新回合', () => {
      let s = applyEvent(settledRun(1000), { type: 'agent_start' } as AgentEvent);
      s = applyEvent(s, custom('auto-compact-resume'));
      s = applyEvent(s, { type: 'agent_end', willRetry: true, messages: [] } as AgentEvent);
      s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
      expect(s.runOpening).toBe(false);
      s = applyEvent(s, user('引导'));
      expect(s.runStartedAt).toBe(1000);
    });
  });

  it('nextRunStartedAt starts a fresh clock unless this run is still going', () => {
    expect(nextRunStartedAt({ runStartedAt: 50 })).toBeGreaterThan(50);
    expect(nextRunStartedAt({ runActive: true, runStartedAt: 50 })).toBe(50);
    expect(nextRunStartedAt({ isStreaming: true, runStartedAt: 50 })).toBe(50);
  });

  it('keeps runActive from agent_start until agent_settled, not agent_end', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.runActive).toBe(true);
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(s.runActive).toBe(true);
    expect(s.isStreaming).toBe(false);
    s = applyEvent(s, { type: 'agent_settled' } as AgentEvent);
    expect(s.runActive).toBe(false);
    expect(s.isStreaming).toBe(false);
  });

  it('agent_end clears only the streaming assistant and preserves identity of settled messages', () => {
    let s = initialAgentState();
    // 先落一条已完成（非 streaming）assistant
    s = applyEvent(s, { type: 'message_end', message: { role: 'assistant', content: 'earlier' } } as AgentEvent);
    const settled = s.messages[0];
    expect(settled.kind === 'assistant' && settled.streaming).toBe(false);
    // 再开一条 streaming assistant
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: 'live...' } } as AgentEvent);
    const streamingMsg = s.messages[1];
    expect(streamingMsg.kind === 'assistant' && streamingMsg.streaming).toBe(true);
    // agent_end：只该 streaming 条被克隆改 false，已完成条保持引用不变
    s = applyEvent(s, { type: 'agent_end' } as AgentEvent);
    expect(s.messages[0]).toBe(settled); // 引用不变 → 未被克隆
    const last = s.messages[1];
    expect(last.kind === 'assistant' && last.streaming).toBe(false);
    expect(s.isStreaming).toBe(false);
  });

  it('tracks tool calls by toolCallId', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [] }, isError: false,
    } as AgentEvent);
    const tool = s.messages.find((m) => m.kind === 'tool' && m.toolCallId === 'c1');
    expect(tool && tool.kind === 'tool' ? tool.status : '').toBe('done');
  });

  it('nests a child tool call under the parent tool card', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'tool_execution_start',
      toolCallId: 'parent',
      toolName: 'codemode',
      args: {},
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'tool_execution_start',
      toolCallId: 'parent/1',
      parentToolCallId: 'parent',
      toolName: 'mcp__a__x',
      args: {},
    } as AgentEvent);
    const child = s.messages.find((m) => m.kind === 'tool' && m.toolCallId === 'parent/1');
    expect(child && child.kind === 'tool' ? child.parentToolCallId : undefined).toBe('parent');

    const turn = groupMessages(s.messages).find((m) => m.kind === 'turn');
    const segments = turn && turn.kind === 'turn' ? turn.segments : [];
    const rows = buildTurnRows(segments);
    const topLevelTools = rows.filter(
      (row) => row.kind === 'segment' && row.segment.kind === 'tool',
    );
    expect(topLevelTools).toHaveLength(1);
    const parentRow = topLevelTools[0];
    if (!parentRow || parentRow.kind !== 'segment' || parentRow.segment.kind !== 'tool') {
      throw new Error('expected parent tool row');
    }
    expect(parentRow.segment.toolCallId).toBe('parent');
    expect(parentRow.segment.children?.map((item) => item.toolCallId)).toEqual(['parent/1']);
  });

  it('times execution from tool_execution_start and freezes the duration on end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    try {
      let s = initialAgentState();
      s = applyEvent(s, {
        type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 3' },
      } as AgentEvent);
      const running = s.messages.find((m) => m.kind === 'tool' && m.toolCallId === 'c1');
      expect(running?.kind === 'tool' ? running.startedAt : undefined).toBe(Date.now());
      expect(running?.kind === 'tool' ? running.durationMs : 0).toBeUndefined();

      vi.advanceTimersByTime(3_200);
      s = applyEvent(s, {
        type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [] }, isError: false,
      } as AgentEvent);
      const done = s.messages.find((m) => m.kind === 'tool' && m.toolCallId === 'c1');
      expect(done?.kind === 'tool' ? done.durationMs : undefined).toBe(3_200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('addUserMessage appends a user message', () => {
    let s = initialAgentState();
    s = addUserMessage(s, 'hi there');
    const last = s.messages.at(-1)!;
    expect(last.kind).toBe('user');
    expect(text(last)).toBe('hi there');
  });

  it('dropUnpersistedUserTail removes only an unaccepted tail with the same text', () => {
    const sent = addUserMessage(initialAgentState(), 'hello');
    expect(dropUnpersistedUserTail(sent.messages, 'hello')).toEqual([]);
    expect(dropUnpersistedUserTail(sent.messages, 'other')).toBeNull();
    const kept = {
      ...sent,
      messages: sent.messages.map((message) =>
        message.kind === 'user' ? { ...message, entryId: 'e1' } : message,
      ),
    };
    expect(dropUnpersistedUserTail(kept.messages, 'hello')).toBeNull();
    const withReply = addUserMessage(initialAgentState(), 'hello');
    withReply.messages.push({
      kind: 'assistant',
      id: 'a1',
      text: 'ok',
      thinking: '',
      streaming: false,
    });
    expect(dropUnpersistedUserTail(withReply.messages, 'hello')).toBeNull();
  });

  it('rollbackUnansweredSend puts an unanswered send back and ignores a real reply', () => {
    const sent = addUserMessage(initialAgentState(), 'hello');
    expect(rollbackUnansweredSend(sent.messages, 'hello')).toEqual({ messages: [] });
    const kept = {
      ...sent,
      messages: sent.messages.map((message) =>
        message.kind === 'user' ? { ...message, entryId: 'e1' } : message,
      ),
    };
    expect(rollbackUnansweredSend(kept.messages, 'hello')).toEqual({ messages: [], entryId: 'e1' });
    const placeholder = addUserMessage(initialAgentState(), 'hello');
    placeholder.messages.push({ kind: 'assistant', id: 'a0', text: '', thinking: '', streaming: true });
    expect(rollbackUnansweredSend(placeholder.messages, 'hello')?.messages).toEqual([]);
    const withReply = addUserMessage(initialAgentState(), 'hello');
    withReply.messages.push({ kind: 'assistant', id: 'a1', text: 'ok', thinking: '', streaming: false });
    expect(rollbackUnansweredSend(withReply.messages, 'hello')).toBeNull();
  });

  it('message_end drops the empty assistant bubble for tool-only messages but keeps the tool card', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }] },
    } as AgentEvent);
    // 流式即建卡：一条 assistant 空泡 + 一张 running 工具卡片
    expect(s.messages.filter((m) => m.kind === 'tool')).toHaveLength(1);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }] },
    } as AgentEvent);
    // 空 assistant 泡被移除，但工具卡片保留（仍 running，等待 tool_execution_*）
    expect(s.messages).toHaveLength(1);
    const only = s.messages[0];
    expect(only.kind).toBe('tool');
    if (only.kind === 'tool') {
      expect(only.toolCallId).toBe('c1');
      expect(only.status).toBe('running');
    }
  });

  it('shows a running tool card while toolCall args stream in (before tool_execution_start)', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);

    const w1 = () => s.messages.find((m) => m.kind === 'tool' && m.toolCallId === 'w1');
    const contentOf = (m: ChatMessage | undefined): string =>
      m && m.kind === 'tool' ? ((m.args as { content?: string }).content ?? '') : '';
    const statusOf = (m: ChatMessage | undefined): string => (m && m.kind === 'tool' ? m.status : '');

    // 模型开始生成 Write 调用，content 仍在逐 token 流入（参数未写完）
    s = applyEvent(s, {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts', content: 'export ' } }],
      },
      assistantMessageEvent: { type: 'text_delta', delta: '' },
    } as AgentEvent);
    expect(statusOf(w1())).toBe('running');
    expect(contentOf(w1())).toBe('export ');

    // 参数继续增长：同一张卡片刷新，不新增第二张
    s = applyEvent(s, {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts', content: 'export const x = 1;' } }],
      },
      assistantMessageEvent: { type: 'text_delta', delta: '' },
    } as AgentEvent);
    expect(s.messages.filter((m) => m.kind === 'tool' && m.toolCallId === 'w1')).toHaveLength(1);
    expect(contentOf(w1())).toBe('export const x = 1;');

    // 真正开始执行：复用同卡（仍只有一张），用执行时的完整参数覆盖
    s = applyEvent(s, {
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'a.ts', content: 'export const x = 1;' },
    } as AgentEvent);
    expect(s.messages.filter((m) => m.kind === 'tool' && m.toolCallId === 'w1')).toHaveLength(1);

    // 执行结束 → done
    s = applyEvent(s, {
      type: 'tool_execution_end',
      toolCallId: 'w1',
      toolName: 'write',
      result: { content: [] },
      isError: false,
    } as AgentEvent);
    expect(statusOf(w1())).toBe('done');
  });

  it('messagesFromTranscript shows a running tool card while a tool call is still streaming', () => {
    // 子代理对话与主对话共用同一 reducer：运行中回放（transcript 尾部尚无 tool_execution_end）
    // 也应在参数流式阶段就呈现 running 卡片。
    const transcript = [
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      JSON.stringify({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts', content: 'partial' } }],
        },
        assistantMessageEvent: { type: 'text_delta', delta: '' },
      }),
    ].join('\n');
    const msgs = messagesFromTranscript(transcript);
    const tool = msgs.find((m) => m.kind === 'tool');
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') {
      expect(tool.toolName).toBe('write');
      expect(tool.status).toBe('running');
    }
  });

  it('message_end surfaces assistant errorMessage as lastError when content is empty', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '403 Your request was blocked.',
      },
    } as AgentEvent);
    expect(s.messages).toHaveLength(0);
    expect(s.lastError).toBe('403 Your request was blocked.');
  });

  it('reuses streaming assistant on duplicate message_start', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    expect(s.messages).toHaveLength(1);
  });

  it('messagesFromAgent maps user and assistant history', () => {
    const msgs = messagesFromAgent([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].kind).toBe('user');
    expect(text(msgs[0])).toBe('hello');
    expect(msgs[1].kind).toBe('assistant');
    expect(text(msgs[1])).toBe('hi');
  });

  it('messagesFromAgent restores tools from toolResult and toolCall args', () => {
    const msgs = messagesFromAgent([
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I will list files' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt' }],
        details: { exitCode: 0 },
        isError: false,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done listing.' }],
      },
    ] as never);
    expect(msgs).toHaveLength(4);
    expect(msgs[2].kind).toBe('tool');
    if (msgs[2].kind === 'tool') {
      expect(msgs[2].toolCallId).toBe('c1');
      expect(msgs[2].toolName).toBe('bash');
      expect(msgs[2].args).toEqual({ command: 'ls' });
      expect(msgs[2].status).toBe('done');
      expect(msgs[2].result).toMatchObject({
        content: [{ type: 'text', text: 'file.txt' }],
        details: { exitCode: 0 },
      });
    }
    expect(msgs[1].kind === 'assistant' ? msgs[1].thinking : '').toBe('I will list files');
    expect(text(msgs[3]!)).toBe('Done listing.');
  });

  it('messagesFromAgent skips assistant bubbles that only contain tool calls', () => {
    const msgs = messagesFromAgent([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'grep', arguments: { q: 'x' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'grep',
        content: [{ type: 'text', text: 'match' }],
        isError: false,
      },
    ] as never);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('tool');
  });

  it('messagesFromAgent keeps an unanswered ask_user as a running tool row', () => {
    const msgs = messagesFromAgent([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } }],
      },
    ] as never);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'tool', toolCallId: 'q1', toolName: 'ask_user', status: 'running' });
  });

  it('messagesFromAgent does not keep ask_user after its tool result arrives', () => {
    const msgs = messagesFromAgent([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [] } }],
      },
      { role: 'toolResult', toolCallId: 'q1', toolName: 'ask_user', content: [{ type: 'text', text: '[我的选择]\n1. 选哪个：甲' }], isError: false },
    ] as never);
    expect(msgs.filter((m) => m.kind === 'tool' && m.status === 'running')).toHaveLength(0);
    expect(msgs.some((m) => m.kind === 'tool' && m.status === 'done')).toBe(true);
  });

  // 工具正在跑时切进会话：快照里只有调用、没有结果。以前只靠 toolResult 建卡，这张卡一直缺席，
  // 画面停在思考和「正在处理」上，看起来像卡死。
  it('messagesFromAgent restores a still-running tool call from the last assistant as a running card', () => {
    const msgs = messagesFromAgent([
      { role: 'user', content: 'run checks' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'All tests pass now.' },
          { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm run ui:check', timeout: 1600 } },
        ],
      },
    ] as never);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(msgs[2]).toMatchObject({ toolCallId: 'b1', toolName: 'bash', status: 'running', argsComplete: true, result: undefined });
    expect((msgs[2] as { args: unknown }).args).toEqual({ command: 'npm run ui:check', timeout: 1600 });
  });

  it('live updates after the snapshot land on the restored running card', () => {
    let s: AgentState = {
      ...initialAgentState(),
      isStreaming: true,
      messages: messagesFromAgent([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'sleep 60' } }] },
      ] as never),
    };
    s = applyEvent(s, {
      type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: { command: 'sleep 60' },
      partialResult: { content: [], details: { foregroundJob: { jobId: 'bash-1', jobStartedAt: 1 } } },
    } as never);
    s = applyEvent(s, {
      type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false,
    } as never);
    const cards = s.messages.filter((m) => m.kind === 'tool');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCallId: 'b1', status: 'done' });
  });

  it('messagesFromAgent only restores pending calls of the last assistant, finished ones keep their result', () => {
    const msgs = messagesFromAgent([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'bash', arguments: {} }] },
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a' } },
          { type: 'toolCall', id: 'r2', name: 'read', arguments: { path: 'b' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'a' }], isError: false },
    ] as never);
    const tools = msgs.filter((m) => m.kind === 'tool');
    expect(tools.map((m) => [m.toolCallId, m.status])).toEqual([['r1', 'done'], ['r2', 'running']]);
  });

  it('interruptPendingToolCards settles restored running cards but leaves ask_user waiting', () => {
    const msgs = messagesFromAgent([
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'x' } },
          { type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [] } },
        ],
      },
    ] as never);
    const settled = interruptPendingToolCards(msgs);
    expect(settled.find((m) => m.kind === 'tool' && m.toolCallId === 'b1')).toMatchObject({ status: 'error', interrupted: true });
    expect(settled.find((m) => m.kind === 'tool' && m.toolCallId === 'q1')).toMatchObject({ status: 'running' });
    const done = messagesFromAgent([{ role: 'user', content: 'hi' }] as never);
    expect(interruptPendingToolCards(done)).toBe(done);
  });

  it('accumulates thinking from thinking_delta and keeps it after message_end', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me ' },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'think.' },
    } as AgentEvent);
    const mid = s.messages.at(-1)!;
    expect(mid.kind === 'assistant' ? mid.thinking : '').toBe('Let me think.');
    // 终态消息只含 text、不含 thinking 块：流式累积的思考不应被清空
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    } as AgentEvent);
    const last = s.messages.at(-1)!;
    expect(last.kind === 'assistant' ? last.thinking : '').toBe('Let me think.');
    expect(text(last)).toBe('Hi');
    expect(last.kind === 'assistant' && last.streaming).toBe(false);
  });

  it('message_update 无 message 快照时按 delta 累积 thinking 与 text（pi 流式事件不带 message）', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    // pi 真实的流式增量事件只带 assistantMessageEvent、不带 message 快照（实测 2532/2532 条
    // message_update 均无 message 字段）。直接读 ev.message 会抛 TypeError：修复前会中断整个
    // flush 批次（观感「卡在第一个字」），被 try/catch 兜住后又完全无法累积（观感「结果直出」）。
    // 这里锁住「无快照也必须能逐 token 累积」这一行为。
    for (const delta of ['The', ' user', ' asks.']) {
      s = applyEvent(s, {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta },
      } as AgentEvent);
    }
    const thinkingMsg = s.messages.at(-1)!;
    expect(thinkingMsg.kind === 'assistant' ? thinkingMsg.thinking : '').toBe('The user asks.');

    // 正文同样需要 text_delta 累积：快照缺失时 text 恒为空，否则正文也会「直出」
    for (const delta of ['答案', '内容']) {
      s = applyEvent(s, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta },
      } as AgentEvent);
    }
    expect(text(s.messages.at(-1)!)).toBe('答案内容');
  });

  it('message_end does not append a second copy of an already finished assistant', () => {
    let s = initialAgentState();
    s = {
      ...s,
      messages: [{
        kind: 'assistant',
        id: 'a1',
        text: 'Step 4 — run both test targets',
        thinking: '先看测试',
        streaming: false,
      }, {
        kind: 'tool',
        id: 't1',
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'cargo test' },
        status: 'running',
      }],
    };
    s = applyEvent(s, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看测试' },
          { type: 'text', text: 'Step 4 — run both test targets' },
        ],
      },
    } as AgentEvent);
    expect(s.messages.filter((m) => m.kind === 'assistant')).toHaveLength(1);
    expect(s.messages.at(-1)?.kind).toBe('tool');
  });

  it('message_end finalizes streaming assistant text', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    } as AgentEvent);
    const last = s.messages.at(-1)!;
    expect(last.kind).toBe('assistant');
    expect(text(last)).toBe('done');
    expect(last.kind === 'assistant' && last.streaming).toBe(false);
  });

  it('message_end with empty content keeps text accumulated from text_delta', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'c=5' },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'assistant', content: [] },
    } as AgentEvent);
    const last = s.messages.at(-1)!;
    expect(text(last)).toBe('c=5');
    expect(last.kind === 'assistant' && last.streaming).toBe(false);
  });
});

describe('custom injection messages -> notice', () => {
  it('applyEvent turns a display custom message into a single notice (deduped)', () => {
    const msg = { role: 'custom', customType: 'extension-context', content: '# Context\n\nsnippet', display: true } as const;
    let state = initialAgentState();
    state = applyEvent(state, { type: 'message_start', message: msg } as never);
    state = applyEvent(state, { type: 'message_end', message: msg } as never);
    const notices = state.messages.filter((m) => m.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', customType: 'extension-context', content: '# Context\n\nsnippet' });
  });

  it('agent-message: the same message (start + end) shows once, but two sends with the same text both show', () => {
    const at = (timestamp: number) =>
      ({ role: 'custom', customType: 'agent-message', content: 'Agent sa-1 sent a message without waking you:\nstill testing', display: true, timestamp }) as const;
    let state = initialAgentState();
    for (const msg of [at(1), at(2)]) {
      state = applyEvent(state, { type: 'message_start', message: msg } as never);
      state = applyEvent(state, { type: 'message_end', message: msg } as never);
    }
    const notices = state.messages.filter((m) => m.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices.map((m) => m.kind === 'notice' && m.sourceTimestamp)).toEqual([1, 2]);
  });

  it('ignores custom messages without display:true', () => {
    const msg = { role: 'custom', customType: 'extension-context', content: 'x', display: false } as const;
    const state = applyEvent(initialAgentState(), { type: 'message_start', message: msg } as never);
    expect(state.messages.filter((m) => m.kind === 'notice')).toHaveLength(0);
  });

  it('messagesFromAgent restores notices from history', () => {
    const out = messagesFromAgent([
      { role: 'custom', customType: 'extension-context', content: '# Context', display: true } as never,
      { role: 'user', content: 'hi' } as never,
    ]);
    expect(out[0]).toMatchObject({ kind: 'notice', customType: 'extension-context', content: '# Context' });
    expect(out[1]).toMatchObject({ kind: 'user', text: 'hi' });
  });
});

describe('messagesFromTranscript (子代理 JSONL 还原)', () => {
  it('parses a json-mode stream (skipping header) into assistant + tool messages with stable ids', () => {
    const transcript = [
      JSON.stringify({ id: 'sess', version: 1 }), // session header: no `type`, ignored
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] },
      }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'x1', toolName: 'bash', args: { cmd: 'ls' } }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'x1', toolName: 'bash', result: { ok: true }, isError: false }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const msgs = messagesFromTranscript(transcript);
    const assistant = msgs.find((m) => m.kind === 'assistant');
    const tool = msgs.find((m) => m.kind === 'tool');
    expect(assistant && assistant.kind === 'assistant' ? assistant.text : '').toBe('sub answer');
    expect(tool && tool.kind === 'tool' ? tool.status : '').toBe('done');
    expect(msgs.every((m, i) => m.id === `sa-${i}`)).toBe(true);
  });

  it('ignores blank lines and malformed json', () => {
    const transcript = ['', 'not json', JSON.stringify({ type: 'agent_start' }), '  '].join('\n');
    expect(messagesFromTranscript(transcript)).toEqual([]);
  });

  it('replays json-mode text_delta when message_end snapshot is empty', () => {
    const transcript = [
      JSON.stringify({ type: 'session', version: 3 }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'RESULT:c=5' },
      }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');
    const msgs = messagesFromTranscript(transcript);
    const assistant = msgs.find((m) => m.kind === 'assistant');
    expect(assistant && assistant.kind === 'assistant' ? assistant.text : '').toBe('RESULT:c=5');
    expect(assistant && assistant.kind === 'assistant' ? assistant.streaming : true).toBe(false);
  });
});

describe('messagesFromAgent 提取 timestamp', () => {
  it('user 消息带 message.timestamp 时回填到 ChatMessage.timestamp', () => {
    const msgs = messagesFromAgent([
      { role: 'user', content: 'hi', timestamp: 1730000000000 } as never,
    ]);
    expect(msgs[0].kind === 'user' ? msgs[0].timestamp : undefined).toBe(1730000000000);
  });
});

function toolCards(state: AgentState) {
  return state.messages.filter((m) => m.kind === 'tool');
}

function toolUpdate(ame: Record<string, unknown>): AgentEvent {
  return { type: 'message_update', assistantMessageEvent: ame } as AgentEvent;
}

describe('toolcall streaming', () => {
  it('toolcall_start 建卡：argsComplete false、running、真实 toolCallId', () => {
    const s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'call_1', toolName: 'write',
    }));
    expect(toolCards(s)).toHaveLength(1);
    expect(toolCards(s)[0]).toMatchObject({
      kind: 'tool', toolCallId: 'call_1', toolName: 'write', status: 'running', argsComplete: false, args: {},
    });
  });

  it('无 toolName 的 start 不建卡，带 toolName 的 delta 到来后建卡', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({ type: 'toolcall_start', contentIndex: 0, id: 'call_1' }));
    expect(toolCards(s)).toHaveLength(0);
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '{"path":', id: 'call_1', toolName: 'write',
    }));
    expect(toolCards(s)).toHaveLength(1);
    expect(toolCards(s)[0]).toMatchObject({ toolName: 'write', toolCallId: 'call_1', argsComplete: false });
  });

  it('无 id 的 start 用 pending，随后改绑且卡片 id 不变', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, toolName: 'edit',
    }));
    const card = toolCards(s)[0];
    expect(card?.kind).toBe('tool');
    if (card?.kind !== 'tool') return;
    expect(card.toolCallId).toBe(`pending:${card.id}`);
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a.ts"', id: 'call_9', toolName: 'edit',
    }));
    const rebound = toolCards(s)[0];
    expect(rebound).toMatchObject({ id: card.id, toolCallId: 'call_9' });
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'call_9', name: 'edit', arguments: { path: 'a.ts', edits: [] } },
    }));
    expect(toolCards(s)[0]).toMatchObject({ id: card.id, toolCallId: 'call_9', argsComplete: true });
    expect(s.toolDrafts).toBeUndefined();
  });

  it('多次 delta 只拼接草稿，materialize 前 args 不变', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    s = applyEvent(s, toolUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a.ts",' }));
    s = applyEvent(s, toolUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: '"content":"半' }));
    expect(s.toolDrafts?.[0]?.json).toBe('{"path":"a.ts","content":"半');
    expect(toolCards(s)[0]).toMatchObject({ args: {} });
    const { state, deferred } = materializeToolDrafts(s, 10_000, parsePartialArgs);
    expect(deferred).toBe(false);
    expect(toolCards(state)[0]).toMatchObject({ args: { path: 'a.ts', content: '半' } });
    expect(toolCards(state)).toHaveLength(1);
  });

  it('spawn_agent 未闭合的 tasks 和 task 不写进卡片', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'call_p', toolName: 'spawn_agent',
    }));
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"tasks":["review server", "review desk',
    }));
    const partial = materializeToolDrafts(s, 10_000, parsePartialArgs);
    const partialArgs = toolCards(partial.state)[0];
    expect(partialArgs?.kind === 'tool' ? partialArgs.args : {}).toEqual({ tasks: ['review server'] });

    let single = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'call_s', toolName: 'spawn_agent',
    }));
    single = applyEvent(single, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '{"task":"审查',
    }));
    const growing = materializeToolDrafts(single, 10_000, parsePartialArgs);
    const growingCard = toolCards(growing.state)[0];
    expect(growingCard?.kind === 'tool' ? growingCard.args : { task: 'kept' }).toEqual({});

    single = applyEvent(single, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '服务端"}',
    }));
    const closed = materializeToolDrafts(single, 10_000, parsePartialArgs);
    expect(toolCards(closed.state)[0]).toMatchObject({ args: { task: '审查服务端' } });
  });

  it('spawn_agent 的 title 等字符串闭合后才写进卡片', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'call_title', toolName: 'spawn_agent',
    }));
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '{"title":"审服',
    }));
    const growing = materializeToolDrafts(s, 10_000, parsePartialArgs);
    const growingCard = toolCards(growing.state)[0];
    expect(growingCard?.kind === 'tool' ? growingCard.args : { title: 'kept' }).toEqual({});

    s = applyEvent(s, toolUpdate({
      type: 'toolcall_delta', contentIndex: 0, delta: '务端","task":"请完整审查"}',
    }));
    const closed = materializeToolDrafts(s, 10_000, parsePartialArgs);
    expect(toolCards(closed.state)[0]).toMatchObject({ args: { title: '审服务端', task: '请完整审查' } });
  });

  it('大草稿在 150ms 内推迟解析', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    const card = toolCards(s)[0];
    if (card?.kind !== 'tool' || !s.toolDrafts?.[0]) return;
    s = {
      ...s,
      toolDrafts: {
        0: { ...s.toolDrafts[0], json: 'x'.repeat(LARGE_ARGS_CHARS + 8), dirty: true, parsedAt: 1_000, cardId: card.id },
      },
    };
    const { state, deferred } = materializeToolDrafts(s, 1_100, () => ({ huge: true }));
    expect(deferred).toBe(true);
    expect(toolCards(state)[0]).toMatchObject({ args: {} });
  });

  it('toolcall_end 写入完整参数，随后执行复用同一张卡', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    s = applyEvent(s, toolUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a.ts","content":"x"}' }));
    const before = s.messages.length;
    const cardId = toolCards(s)[0] && toolCards(s)[0].kind === 'tool' ? toolCards(s)[0].id : '';
    s = applyEvent(s, toolUpdate({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts', content: 'full' } },
    }));
    expect(toolCards(s)[0]).toMatchObject({
      id: cardId, toolCallId: 'w1', argsComplete: true, args: { path: 'a.ts', content: 'full' }, status: 'running',
    });
    expect(s.toolDrafts).toBeUndefined();
    s = applyEvent(s, {
      type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'a.ts', content: 'full' },
    } as AgentEvent);
    expect(s.messages).toHaveLength(before);
    expect(toolCards(s)[0]).toMatchObject({ id: cardId, argsComplete: true });
    s = applyEvent(s, {
      type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false,
    } as AgentEvent);
    expect(toolCards(s)[0]).toMatchObject({ id: cardId, status: 'done', result: { content: [{ type: 'text', text: 'ok' }] } });
  });

  it('message_end aborted 把卡片标成错误，不新建 running 卡', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    s = applyEvent(s, {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts' } }],
      },
    } as AgentEvent);
    expect(toolCards(s)).toHaveLength(1);
    expect(toolCards(s)[0]).toMatchObject({ status: 'error', argsComplete: true });
    expect(JSON.stringify((toolCards(s)[0] as { result?: unknown }).result)).toContain('已中断');
    expect(toolCards(s).some((m) => m.kind === 'tool' && m.status === 'running')).toBe(false);
  });

  it('message_end error 使用 errorMessage，且不弹给主动中断', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    s = applyEvent(s, {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '403 blocked',
        content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: {} }],
      },
    } as AgentEvent);
    expect(toolCards(s)[0]).toMatchObject({ status: 'error' });
    expect(JSON.stringify((toolCards(s)[0] as { result?: unknown }).result)).toContain('403 blocked');
    expect(s.lastError).toBe('403 blocked');

    let aborted = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w2', toolName: 'write',
    }));
    aborted = { ...aborted, aborting: true };
    aborted = applyEvent(aborted, {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'request aborted',
        content: [{ type: 'toolCall', id: 'w2', name: 'write', arguments: {} }],
      },
    } as AgentEvent);
    expect(aborted.lastError).toBeUndefined();
    expect(toolCards(aborted)[0]).toMatchObject({ status: 'error' });
  });

  it('中止后补写的结果消息把「已中断」换成真实结果', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_end', contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pwd' } },
    }));
    s = applyEvent(s, {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pwd' } }],
      },
    } as AgentEvent);
    expect(toolCards(s)[0]).toMatchObject({ status: 'error', interrupted: true });
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'C:\\work' }], isError: false },
    } as AgentEvent);
    expect(toolCards(s)).toHaveLength(1);
    expect(toolCards(s)[0]).toMatchObject({ status: 'done', result: { content: [{ type: 'text', text: 'C:\\work' }] } });
    expect((toolCards(s)[0] as { interrupted?: boolean }).interrupted).toBeUndefined();
  });

  it('工具结果消息收掉仍在转的卡片，不改 tool_execution_end 已定格的卡片', () => {
    let s = applyEvent(initialAgentState(), {
      type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'a.ts' },
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'body' }], isError: true },
    } as AgentEvent);
    expect(toolCards(s)[0]).toMatchObject({ status: 'error', result: { content: [{ type: 'text', text: 'body' }] } });

    s = applyEvent(s, {
      type: 'tool_execution_start', toolCallId: 'r2', toolName: 'codemode', args: {},
    } as AgentEvent);
    const structured = { content: [{ type: 'text', text: 'ok' }], details: { calls: [] }, structuredContent: { x: 1 } };
    s = applyEvent(s, {
      type: 'tool_execution_end', toolCallId: 'r2', toolName: 'codemode', result: structured, isError: false,
    } as AgentEvent);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'r2', toolName: 'codemode', content: [{ type: 'text', text: 'ok' }], isError: false },
    } as AgentEvent);
    expect((toolCards(s)[1] as { result?: unknown }).result).toBe(structured);
  });

  it('agent_end 兜底收尾未完成的参数卡', () => {
    let s = applyEvent(initialAgentState(), toolUpdate({
      type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write',
    }));
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(s.toolDrafts).toBeUndefined();
    expect(toolCards(s)[0]).toMatchObject({ status: 'error', argsComplete: true });
    expect(JSON.stringify((toolCards(s)[0] as { result?: unknown }).result)).toContain('已中断');
  });

  it('只有 message_end 的提供商仍建完整参数卡', () => {
    const s = applyEvent(initialAgentState(), {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'a.ts', content: 'done' } }],
      },
    } as AgentEvent);
    expect(toolCards(s)).toHaveLength(1);
    expect(toolCards(s)[0]).toMatchObject({
      toolCallId: 'w1', status: 'running', argsComplete: true, args: { path: 'a.ts', content: 'done' },
    });
  });

  it('messagesFromTranscript 把 toolcall 事件还原成完整参数卡', () => {
    const transcript = [
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 't1', toolName: 'write' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"a.ts","content":"part' } }),
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 1,
          toolCall: { type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts', content: 'done' } },
        },
      }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts', content: 'done' } }] },
      }),
    ].join('\n');
    const tool = messagesFromTranscript(transcript).find((m) => m.kind === 'tool');
    expect(tool).toMatchObject({ toolName: 'write', toolCallId: 't1', args: { path: 'a.ts', content: 'done' }, argsComplete: true });
  });
});

describe('引导状态', () => {
  it('发送引导先记为已收下、尚未注入', () => {
    const state = addUserMessage(initialAgentState(), '改用 chrome', undefined, true);
    expect(state.messages[0]).toMatchObject({ steering: true, steerState: 'written', text: '改用 chrome' });
  });

  it('注入当前回合后标成已引导', () => {
    let state = addUserMessage(initialAgentState(), '改用 chrome', undefined, true);
    state = applyEvent(state, {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: '改用 chrome' }] },
    } as AgentEvent);
    expect(state.messages[0]).toMatchObject({ steerState: 'consumed' });
  });

  it('正文对不上且只有一条未确认引导时，仍标成已引导', () => {
    let state = addUserMessage(initialAgentState(), '/skill:x 改一下', undefined, true);
    state = applyEvent(state, {
      type: 'message_start',
      message: { role: 'user', content: '展开后的引导' },
    } as AgentEvent);
    expect(state.messages[0]).toMatchObject({ steerState: 'consumed' });
  });

  it('这一轮结束前没注入的引导改成独立再跑', () => {
    let state = addUserMessage(initialAgentState(), '改用 chrome', undefined, true);
    state = applyEvent(state, { type: 'agent_end', messages: [], willRetry: true } as AgentEvent);
    expect(state.messages[0]).toMatchObject({ steerState: 'written' });
    state = applyEvent(state, { type: 'agent_settled' } as AgentEvent);
    expect(state.messages[0]).toMatchObject({ steerState: 'requeued' });
  });

  it('已经注入的引导在回合结束时保持已引导', () => {
    let state = addUserMessage(initialAgentState(), '改用 chrome', undefined, true);
    state = applyEvent(state, {
      type: 'message_start',
      message: { role: 'user', content: '改用 chrome' },
    } as AgentEvent);
    state = applyEvent(state, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(state.messages[0]).toMatchObject({ steerState: 'consumed' });
  });
});

describe('pi 自动重试', () => {
  const failed = (errorMessage: string) =>
    ({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
    }) as AgentEvent;
  const ok = {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '好了' }], stopReason: 'stop' },
  } as AgentEvent;
  const retryStart = (attempt: number) =>
    ({ type: 'auto_retry_start', attempt, maxAttempts: 3, delayMs: 2000, errorMessage: '502 Bad Gateway' }) as AgentEvent;

  function failingRun(): AgentState {
    let s = addUserMessage(initialAgentState(), '你好');
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, failed('502 Bad Gateway'));
    return applyEvent(s, { type: 'agent_end', willRetry: true, messages: [] } as AgentEvent);
  }

  it('agent_end 带 willRetry 时这一轮仍在进行，报错收进重试条', () => {
    const s = failingRun();
    expect(s.isStreaming).toBe(true);
    expect(s.lastError).toBeUndefined();
    expect(s.retrying).toMatchObject({ auto: true, error: '502 Bad Gateway' });
  });

  it('auto_retry_start 写入次数和原因，退避结束的 agent_start 不清重试条', () => {
    let s = applyEvent(failingRun(), retryStart(1));
    expect(s.retrying).toEqual({ attempt: 1, max: 3, auto: true, error: '502 Bad Gateway' });
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.isStreaming).toBe(true);
    expect(s.retrying).toMatchObject({ attempt: 1, auto: true });
  });

  it('重试中再次失败不弹红条，只更新重试条', () => {
    let s = applyEvent(failingRun(), retryStart(1));
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, failed('503 Service Unavailable'));
    expect(s.lastError).toBeUndefined();
    expect(s.retrying).toMatchObject({ error: '503 Service Unavailable' });
    s = applyEvent(s, { type: 'agent_end', willRetry: true, messages: [] } as AgentEvent);
    expect(s.isStreaming).toBe(true);
    expect(s.lastError).toBeUndefined();
    expect(s.retrying).toMatchObject({ attempt: 1, max: 3, error: '503 Service Unavailable' });
  });

  it('重试成功后清掉重试条', () => {
    let s = applyEvent(failingRun(), retryStart(1));
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, ok);
    s = applyEvent(s, { type: 'auto_retry_end', success: true, attempt: 1 } as AgentEvent);
    expect(s.retrying).toBeUndefined();
    expect(s.lastError).toBeUndefined();
  });

  it('重试用完才落红条：agent_end 先把最后的报错落成 lastError，auto_retry_end 再给最终原因', () => {
    let s = applyEvent(failingRun(), retryStart(3));
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, failed('503 Service Unavailable'));
    s = applyEvent(s, { type: 'agent_end', willRetry: false, messages: [] } as AgentEvent);
    expect(s.isStreaming).toBe(false);
    expect(s.retrying).toBeUndefined();
    expect(s.lastError).toBe('503 Service Unavailable');
    s = applyEvent(s, { type: 'auto_retry_end', success: false, attempt: 3, finalError: '503 Service Unavailable' } as AgentEvent);
    expect(s.lastError).toBe('503 Service Unavailable');
  });

  it('用户取消重试不弹红条', () => {
    let s = applyEvent(failingRun(), retryStart(1));
    s = { ...s, aborting: true, retrying: undefined };
    s = applyEvent(s, { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' } as AgentEvent);
    s = applyEvent(s, { type: 'agent_settled' } as AgentEvent);
    expect(s.lastError).toBeUndefined();
    expect(s.retrying).toBeUndefined();
    expect(s.isStreaming).toBe(false);
  });

  it('界面自己的发送重试仍由 agent_start 收掉', () => {
    let s: AgentState = { ...initialAgentState(), retrying: { attempt: 1, max: 5 } };
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    expect(s.retrying).toBeUndefined();
  });
});

describe('excludedFromAgent', () => {
  it('按序回放 add/remove 重建排除集', () => {
    const set = excludedFromAgent([
      { role: 'custom', customType: 'context_exclusion', data: { op: 'add', ts: 1 } },
      { role: 'custom', customType: 'context_exclusion', data: { op: 'add', ts: 2 } },
      { role: 'custom', customType: 'context_exclusion', data: { op: 'remove', ts: 1 } },
    ] as never);
    expect([...set].sort((a, b) => a - b)).toEqual([2]);
  });

  it('忽略非 context_exclusion 与缺 ts 的条目（fail-soft）', () => {
    const set = excludedFromAgent([
      { role: 'user', content: 'x', timestamp: 5 },
      { role: 'custom', customType: 'context_exclusion' },
      { role: 'custom', customType: 'other', data: { op: 'add', ts: 9 } },
    ] as never);
    expect(set.size).toBe(0);
  });
});
