import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import { reviewView } from './reviewView';

const messages: ChatMessage[] = [
  { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
  {
    kind: 'tool', id: 'w', toolCallId: 'w1', toolName: 'write',
    args: { path: 'a.txt', content: 'hello' }, result: { content: [] }, status: 'done',
  },
];

describe('reviewView', () => {
  it('returns empty without turnId', () => {
    expect(reviewView(messages, {}).kind).toBe('empty');
  });
  it('returns missing when the turn is gone', () => {
    expect(reviewView(messages, { turnId: 'nope' }).kind).toBe('missing');
  });
  it('returns ready hunks for the selected file', () => {
    const view = reviewView(messages, { turnId: 'turn-1', fileIndex: 0 });
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.files[0]?.display).toBe('a.txt');
    expect(view.hunks[0]?.rows.some((row) => row.text === 'hello')).toBe(true);
  });
  it('falls back to the first file when fileIndex is out of range', () => {
    const twoWrites: ChatMessage[] = [
      { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
      {
        kind: 'tool', id: 'w-a', toolCallId: 'w1', toolName: 'write',
        args: { path: 'a.txt', content: 'hello-a' }, result: { content: [] }, status: 'done',
      },
      {
        kind: 'tool', id: 'w-b', toolCallId: 'w2', toolName: 'write',
        args: { path: 'b.txt', content: 'hello-b' }, result: { content: [] }, status: 'done',
      },
    ];
    const view = reviewView(twoWrites, { turnId: 'turn-1', fileIndex: 99 });
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.selected).toBe(0);
    expect(view.hunks[0]?.path).toBe('a.txt');
    expect(view.hunks[0]?.rows.some((row) => row.text === 'hello-a')).toBe(true);
  });
  it('keeps write then edit on the same path as two hunks', () => {
    const edited: ChatMessage[] = [
      { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
      {
        kind: 'tool', id: 'w', toolCallId: 'w1', toolName: 'write',
        args: { path: 'a.txt', content: 'hello' }, result: { content: [] }, status: 'done',
      },
      {
        kind: 'tool', id: 'e', toolCallId: 'e1', toolName: 'edit',
        args: { path: 'a.txt', old_string: 'hello', new_string: 'HELLO\nworld' },
        result: { content: [] }, status: 'done',
      },
    ];
    const view = reviewView(edited, { turnId: 'turn-1', fileIndex: 0 });
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.hunks).toHaveLength(2);
    expect(view.hunks[0]?.rows.every((row) => row.marker === '+')).toBe(true);
    expect(view.hunks[1]?.rows.some((row) => row.marker === '-')).toBe(true);
    expect(view.hunks[1]?.rows.some((row) => row.marker === '+')).toBe(true);
  });
  it('omits other files from the selected hunks', () => {
    const mixed: ChatMessage[] = [
      { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
      {
        kind: 'tool', id: 'w-a', toolCallId: 'w1', toolName: 'write',
        args: { path: 'a.txt', content: 'hello-a' }, result: { content: [] }, status: 'done',
      },
      {
        kind: 'tool', id: 'w-o', toolCallId: 'w2', toolName: 'write',
        args: { path: 'other.txt', content: 'other-only' }, result: { content: [] }, status: 'done',
      },
    ];
    const view = reviewView(mixed, { turnId: 'turn-1', fileIndex: 0 });
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') return;
    expect(view.hunks.every((hunk) => hunk.path === 'a.txt')).toBe(true);
    expect(view.hunks.some((hunk) => hunk.rows.some((row) => row.text === 'other-only'))).toBe(false);
  });
  it('returns none when the turn has no mutations', () => {
    const textOnly: ChatMessage[] = [
      { kind: 'assistant', id: 'turn-1', text: 'nothing changed', thinking: '', streaming: false },
    ];
    expect(reviewView(textOnly, { turnId: 'turn-1' }).kind).toBe('none');
  });
});
