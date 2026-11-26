import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../stores/agentReducer';

const bridge = vi.hoisted(() => ({
  readUiHistory: vi.fn(),
  writeUiHistory: vi.fn(),
  patchUiHistory: vi.fn(),
  deleteUiHistory: vi.fn(),
}));
vi.mock('./pi', () => ({ pi: bridge }));
import { deleteUiHistoryForSession, deserializeHistory, readUiHistoryForSession, replaceUiHistory, scheduleUiHistory, serializeHistory, sessionKeyFromPath } from './uiHistory';

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

  it('serializeHistory 不输出 argsComplete', () => {
    const done = serializeHistory([
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'write', args: { path: 'a' }, result: {}, status: 'done', argsComplete: true },
    ]);
    expect(done).not.toContain('argsComplete');
    const partial = serializeHistory([
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'write', args: {}, result: undefined, status: 'running', argsComplete: false },
    ]);
    expect(partial).not.toContain('argsComplete');
    expect(partial).toContain('已中断');
    expect(partial).toContain('"status":"error"');
  });
});

const row = (id: string, text: string): ChatMessage => ({ id, kind: 'user', text });

describe('incremental UI history', () => {
  it('recovers a disk checkpoint and sends only the final coalesced UTF-8 tail', async () => {
    vi.clearAllMocks();
    const workspace = '/incremental';
    const path = '/sessions/cold.jsonl';
    const prefix = serializeHistory([row('old', '压缩前的原文 🌱')]);
    bridge.readUiHistory.mockResolvedValueOnce({ content: prefix, revision: 'disk' });
    const old = (await readUiHistoryForSession(workspace, path))!;
    scheduleUiHistory(workspace, path, [...old, row('live', 'first')]);
    scheduleUiHistory(workspace, path, [...old, row('live', 'final')]);
    expect(bridge.patchUiHistory).not.toHaveBeenCalled();
    const finalLine = serializeHistory([row('live', 'final')]);
    bridge.patchUiHistory.mockResolvedValueOnce('after');
    bridge.readUiHistory.mockResolvedValueOnce(prefix + '\n' + finalLine);
    const restored = await readUiHistoryForSession(workspace, path);
    expect(restored?.map(m => m.kind === 'user' && m.text)).toEqual(['压缩前的原文 🌱', 'final']);
    expect(bridge.writeUiHistory).not.toHaveBeenCalled();
    expect(bridge.patchUiHistory).toHaveBeenCalledExactlyOnceWith(workspace, 'cold', 'disk', Buffer.byteLength(prefix), '\n' + finalLine);
  });

  it('holds a rewind behind an already sent write and cancels queued pre-delete history', async () => {
    vi.clearAllMocks();
    const workspace = '/cut';
    const path = '/sessions/cut.jsonl';
    const old = row('old', '保留');
    bridge.writeUiHistory.mockResolvedValueOnce('base');
    await replaceUiHistory(workspace, path, [old]);
    let finishPatch!: (revision: string) => void;
    bridge.patchUiHistory.mockImplementationOnce(() => new Promise<string>(resolve => { finishPatch = resolve; }));
    scheduleUiHistory(workspace, path, [old, row('second', '稍后删除')]);
    const reading = readUiHistoryForSession(workspace, path);
    expect(bridge.patchUiHistory).toHaveBeenCalledOnce();
    scheduleUiHistory(workspace, path, [old, row('third', '未发送的旧尾段')]);
    bridge.writeUiHistory.mockResolvedValueOnce('cut');
    const cut = replaceUiHistory(workspace, path, [old]);
    expect(bridge.writeUiHistory).toHaveBeenCalledOnce();
    finishPatch('pending');
    await Promise.all([reading, cut]);
    expect(bridge.writeUiHistory).toHaveBeenLastCalledWith(workspace, 'cut', serializeHistory([old]), true);
    scheduleUiHistory(workspace, path, [old, row('later', '取消写入')]);
    await deleteUiHistoryForSession(workspace, path);
    expect(bridge.deleteUiHistory).toHaveBeenCalledExactlyOnceWith(workspace, 'cut');
    expect(bridge.patchUiHistory).toHaveBeenCalledOnce();
  });
});
