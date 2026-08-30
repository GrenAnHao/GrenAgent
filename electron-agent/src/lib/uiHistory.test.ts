import { describe, expect, it } from 'vitest';
import { sessionKeyFromPath, serializeHistory, deserializeHistory } from './uiHistory';
import type { ChatMessage } from '../stores/agentReducer';

describe('sessionKeyFromPath', () => {
  it('takes basename without extension (posix and windows)', () => {
    expect(sessionKeyFromPath('/a/b/.pi/sessions/2026x.jsonl')).toBe('2026x');
    expect(sessionKeyFromPath('C:\\a\\b\\sess-1.jsonl')).toBe('sess-1');
  });
  it('null / undefined / empty → null', () => {
    expect(sessionKeyFromPath(null)).toBeNull();
    expect(sessionKeyFromPath(undefined)).toBeNull();
    expect(sessionKeyFromPath('')).toBeNull();
  });
});

describe('serialize / deserialize', () => {
  const msgs: ChatMessage[] = [
    { kind: 'user', id: 'u1', text: 'hi' } as ChatMessage,
    { kind: 'assistant', id: 'a1', text: 'yo', thinking: '', streaming: false } as ChatMessage,
    { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'read', args: {}, result: {}, status: 'done' } as ChatMessage,
  ];

  it('roundtrips content and reassigns ids to h-<n>', () => {
    const out = deserializeHistory(serializeHistory(msgs));
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe('user');
    expect(out[0].id).toBe('h-0');
    expect(out[1].kind === 'assistant' ? out[1].text : '').toBe('yo');
    expect(out[2].kind).toBe('tool');
  });

  it('skips corrupt lines (fail-soft)', () => {
    const out = deserializeHistory(
      '{"kind":"user","id":"u1","text":"a"}\nGARBAGE\n{"kind":"user","id":"u2","text":"b"}',
    );
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === 'user')).toBe(true);
  });

  it('empty string → []', () => {
    expect(deserializeHistory('')).toEqual([]);
  });
});
