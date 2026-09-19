import { describe, it, expect } from 'vitest';
import {
  initialAgentState,
  applyEvent,
  addUserMessage,
  messagesFromAgent,
  messagesFromTranscript,
  excludedFromAgent,
  type AgentState,
  type ChatMessage,
} from './agentReducer';
import type { AgentEvent } from '../lib/pi';

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

  it('finalizes on agent_end and clears streaming', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
    expect(s.isStreaming).toBe(false);
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

  it('addUserMessage appends a user message', () => {
    let s = initialAgentState();
    s = addUserMessage(s, 'hi there');
    const last = s.messages.at(-1)!;
    expect(last.kind).toBe('user');
    expect(text(last)).toBe('hi there');
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
