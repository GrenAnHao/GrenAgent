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

  it('maps assistant message_start to item.created', () => {
    const raw = {
      type: 'message_start',
      message: { id: 'assistant-1', role: 'assistant', content: [] },
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'item.created', itemId: 'assistant-1', data: raw });
  });

  it('keeps thinking message updates as item.delta', () => {
    const raw = {
      type: 'message_update',
      message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }] },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' },
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'item.delta', itemId: 'assistant-1', data: raw });
  });

  it('maps tool execution progress to item.delta', () => {
    const raw = {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      partialResult: { stdout: 'working' },
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'item.delta', itemId: 'call-1', data: raw });
  });

  it('maps a successful agent_end to turn.completed', () => {
    const raw = { type: 'agent_end', messages: [] };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'turn.completed', data: raw });
  });

  it('maps an agent_end with an assistant errorMessage to turn.failed', () => {
    const raw = {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop', errorMessage: 'model failed', content: [] }],
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'turn.failed', data: raw });
  });

  it('uses the last assistant message stopReason and errorMessage for agent_end status', () => {
    const raw = {
      type: 'agent_end',
      messages: [
        { role: 'assistant', stopReason: 'stop', content: [] },
        { role: 'toolResult', content: [] },
        { role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable', content: [] },
      ],
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'turn.failed', data: raw });
  });

  it('treats an aborted assistant message as failed', () => {
    expect(adaptPiEvent({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }],
    })).toMatchObject({ type: 'turn.failed' });
  });

  it('does not emit a terminal event while agent_end will retry', () => {
    expect(adaptPiEvent({ type: 'agent_end', messages: [], willRetry: true })).toBeUndefined();
  });

  it('uses only the last assistant message to determine final status', () => {
    const raw = {
      type: 'agent_end',
      messages: [
        { role: 'assistant', stopReason: 'error', errorMessage: 'first attempt failed', content: [] },
        { role: 'assistant', stopReason: 'stop', content: [] },
      ],
    };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'turn.completed', data: raw });
  });

  it('does not adapt non-assistant message lifecycle events', () => {
    for (const role of ['user', 'toolResult']) {
      for (const type of ['message_start', 'message_update', 'message_end']) {
        expect(adaptPiEvent({ type, message: { id: `${role}-1`, role, content: [] } })).toBeUndefined();
      }
    }
  });

  it('maps queue updates to a task queued event while preserving the raw event', () => {
    const raw = { type: 'queue_update', steering: ['next'], followUp: [] };

    expect(adaptPiEvent(raw)).toMatchObject({ type: 'task.queued', data: raw });
  });

  it('returns undefined for unknown events', () => {
    expect(adaptPiEvent({ type: 'future_event', value: 1 })).toBeUndefined();
  });
});
