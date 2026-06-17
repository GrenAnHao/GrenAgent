import { describe, it, expect } from 'vitest';
import {
  initialAgentState,
  applyEvent,
  addUserMessage,
  messagesFromAgent,
  messagesFromTranscript,
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

  it('finalizes on agent_end and clears streaming', () => {
    let s = initialAgentState();
    s = applyEvent(s, { type: 'agent_start' } as AgentEvent);
    s = applyEvent(s, { type: 'agent_end', messages: [] } as AgentEvent);
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

  it('message_end drops assistant messages with only tool calls (no visible text)', () => {
    let s = initialAgentState();
    s = applyEvent(s, {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }] },
    } as AgentEvent);
    expect(s.messages).toHaveLength(1);
    s = applyEvent(s, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }] },
    } as AgentEvent);
    expect(s.messages).toHaveLength(0);
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
});

describe('custom injection messages -> notice', () => {
  it('applyEvent turns a display custom message into a single notice (deduped)', () => {
    const msg = { role: 'custom', customType: 'knowledge-rag', content: '# KB\n\nsnippet', display: true } as const;
    let state = initialAgentState();
    state = applyEvent(state, { type: 'message_start', message: msg } as never);
    state = applyEvent(state, { type: 'message_end', message: msg } as never);
    const notices = state.messages.filter((m) => m.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', customType: 'knowledge-rag', content: '# KB\n\nsnippet' });
  });

  it('ignores custom messages without display:true', () => {
    const msg = { role: 'custom', customType: 'long-term-memory', content: 'x', display: false } as const;
    const state = applyEvent(initialAgentState(), { type: 'message_start', message: msg } as never);
    expect(state.messages.filter((m) => m.kind === 'notice')).toHaveLength(0);
  });

  it('messagesFromAgent restores notices from history', () => {
    const out = messagesFromAgent([
      { role: 'custom', customType: 'long-term-memory', content: '# Mem', display: true } as never,
      { role: 'user', content: 'hi' } as never,
    ]);
    expect(out[0]).toMatchObject({ kind: 'notice', customType: 'long-term-memory', content: '# Mem' });
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
});
