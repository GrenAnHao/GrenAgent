import { describe, expect, it } from 'vitest';
import { toJsonEvent } from '../../../cli/src/json-event.js';
import { toRendererEvent } from './streamingEvent.js';

function messageUpdate(assistantMessageEvent: Record<string, unknown>, usage: unknown = { output: 1 }) {
  return {
    type: 'message_update',
    message: { role: 'assistant', usage, content: [] },
    assistantMessageEvent,
  };
}

describe('toRendererEvent', () => {
  it('toolcall_delta 补上 partial 块的 id / toolName', () => {
    const event = messageUpdate({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"path"',
      partial: { content: [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: {} }] },
    });
    const out = toRendererEvent(event as never);
    expect(out).not.toHaveProperty('message');
    const ame = out.assistantMessageEvent as Record<string, unknown>;
    expect(ame).toMatchObject({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path"', id: 'call_1', toolName: 'write' });
    expect(ame).not.toHaveProperty('partial');
  });

  it('块上 id 为空时不补 id', () => {
    const event = messageUpdate({
      type: 'toolcall_delta',
      contentIndex: 1,
      delta: 'x',
      partial: { content: [{ type: 'text' }, { type: 'toolCall', id: '', name: 'edit' }] },
    });
    const ame = (toRendererEvent(event as never).assistantMessageEvent) as Record<string, unknown>;
    expect(ame).not.toHaveProperty('id');
    expect(ame.toolName).toBe('edit');
    expect(ame).not.toHaveProperty('partial');
  });

  it('仍然剥掉 message 与 partial', () => {
    const event = messageUpdate({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{}',
      partial: { content: [{ type: 'toolCall', id: 'c', name: 'bash' }] },
    });
    const out = toRendererEvent(event as never);
    expect(out).not.toHaveProperty('message');
    expect(out.assistantMessageEvent).not.toHaveProperty('partial');
  });

  it('非 message_update 事件原样返回', () => {
    const event = { type: 'agent_end', messages: [], willRetry: false };
    expect(toRendererEvent(event as never)).toBe(event);
  });

  it('toolcall_start / toolcall_end 形状与 toJsonEvent 一致', () => {
    const start = messageUpdate({
      type: 'toolcall_start',
      contentIndex: 0,
      partial: { content: [{ type: 'toolCall', id: 'call_1', name: 'write' }] },
    });
    const end = messageUpdate({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'call_1', name: 'write', arguments: { path: 'a.txt' } },
      partial: { content: [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: { path: 'a.txt' } }] },
    });
    expect(toRendererEvent(start as never)).toEqual(toJsonEvent(start as never));
    expect(toRendererEvent(end as never)).toEqual(toJsonEvent(end as never));
  });
});
