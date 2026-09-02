import { describe, expect, it } from 'vitest';
import { adaptPiEvent } from './eventAdapter';

describe('adaptPiEvent', () => {
  it('maps message_update to item.delta without mutating the Pi event', () => {
    const raw = {
      type: 'message_update',
      message: { id: 'message-1', role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    };

    const mapped = adaptPiEvent(raw, { projectId: 'project-1', threadId: 'thread-1', turnId: 'turn-1' });

    expect(mapped).toMatchObject({
      type: 'item.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      data: raw,
    });
    expect(raw).toEqual({
      type: 'message_update',
      message: { id: 'message-1', role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
  });

  it('maps tool_execution_end to item.updated', () => {
    const raw = {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [] },
      isError: false,
    };

    expect(adaptPiEvent(raw)).toMatchObject({
      type: 'item.updated',
      itemId: 'call-1',
      data: raw,
    });
  });

  it('returns undefined for unknown events', () => {
    expect(adaptPiEvent({ type: 'future_event', value: 1 })).toBeUndefined();
  });
});
