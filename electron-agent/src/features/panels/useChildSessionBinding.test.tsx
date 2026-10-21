import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: { workspace: string; sessionPath?: string; source?: string; event: unknown }) => void;

const { handlers, piMock } = vi.hoisted(() => ({
  handlers: [] as Handler[],
  piMock: { subagentGetSessionMessages: vi.fn() },
}));

vi.mock('../../lib/pi', () => ({
  pi: piMock,
  onPiEvent: (h: Handler) => {
    handlers.push(h);
    return Promise.resolve(() => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    });
  },
}));

import { useChildSessionBinding } from './useChildSessionBinding';

const CHILD = '/sessions/child.jsonl';
const OTHER = '/sessions/other.jsonl';

const user = { role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: 1 };
const first = { role: 'assistant', content: [{ type: 'text', text: 'first' }], timestamp: 2 };
const toolCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } }],
  timestamp: 3,
};
const toolResult = {
  role: 'toolResult',
  toolCallId: 't1',
  toolName: 'read',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 4,
};
const final = { role: 'assistant', content: [{ type: 'text', text: 'final' }], timestamp: 5 };

const emit = (event: unknown, sessionPath = CHILD) => {
  for (const h of [...handlers]) h({ workspace: '.', source: 'subagent', sessionPath, event });
};
const start = (ts: number) => ({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } });
const thinking = (delta: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'thinking_delta', delta },
});

describe('useChildSessionBinding', () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  const flushRAF = () => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb(0);
  };

  beforeEach(() => {
    handlers.length = 0;
    rafCallbacks = [];
    piMock.subagentGetSessionMessages.mockReset().mockResolvedValue({ messages: [] });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const settle = () => act(async () => {});

  it('和主代理一样被动收流：一帧批量应用，每个增量只累加一次，别的会话的事件不进来', async () => {
    const { result } = renderHook(() => useChildSessionBinding(CHILD, true));
    await settle();

    act(() => {
      emit(start(10));
      emit(thinking('Wal'));
      emit(thinking('king'));
      emit(thinking('zzz'), OTHER);
    });
    expect(result.current).toHaveLength(0);

    act(() => flushRAF());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ kind: 'assistant', thinking: 'Walking', streaming: true });
  });

  it('JSONL 种子晚到：垫在实时尾巴前面，不重复、不吞掉正在流的那条', async () => {
    let resolveSeed: (v: { messages: unknown[] }) => void = () => {};
    piMock.subagentGetSessionMessages.mockReturnValueOnce(new Promise((r) => { resolveSeed = r; }));
    const { result } = renderHook(() => useChildSessionBinding(CHILD, true));
    await settle();

    act(() => {
      emit(start(10));
      emit(thinking('live'));
      flushRAF();
    });
    expect(result.current).toHaveLength(1);

    await act(async () => resolveSeed({ messages: [user, first] }));
    expect(result.current.map((m) => m.kind)).toEqual(['user', 'assistant', 'assistant']);
    expect(result.current[1]).toMatchObject({ text: 'first', streaming: false });
    expect(result.current[2]).toMatchObject({ thinking: 'live', streaming: true });

    // 种子之后的增量接着往流式那条累加，不会另起一条。
    act(() => {
      emit(thinking('r'));
      flushRAF();
    });
    expect(result.current).toHaveLength(3);
    expect(result.current[2]).toMatchObject({ thinking: 'liver' });
  });

  it('running 翻转不重建订阅、不清空已收到的内容；结束时补读一次', async () => {
    const { result, rerender } = renderHook(({ running }) => useChildSessionBinding(CHILD, running), {
      initialProps: { running: true },
    });
    await settle();
    expect(handlers).toHaveLength(1);

    act(() => {
      emit(start(10));
      emit(thinking('kept'));
      flushRAF();
    });
    expect(result.current).toHaveLength(1);
    expect(piMock.subagentGetSessionMessages).toHaveBeenCalledTimes(1);

    rerender({ running: false });
    await settle();
    expect(handlers).toHaveLength(1);
    expect(piMock.subagentGetSessionMessages).toHaveBeenCalledTimes(2);
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ thinking: 'kept' });
  });

  it('结束补读：JSONL 条数不少于实时时整份采用，进程子代理的工具结果靠它更新', async () => {
    piMock.subagentGetSessionMessages.mockResolvedValueOnce({ messages: [user, first] });
    const { result, rerender } = renderHook(({ running }) => useChildSessionBinding(CHILD, running), {
      initialProps: { running: true },
    });
    await settle();
    expect(result.current.map((m) => m.kind)).toEqual(['user', 'assistant']);

    piMock.subagentGetSessionMessages.mockResolvedValueOnce({
      messages: [user, first, toolCall, toolResult, final],
    });
    rerender({ running: false });
    await settle();
    expect(result.current.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.current[2]).toMatchObject({ kind: 'tool', toolName: 'read', status: 'done' });
    expect(result.current[3]).toMatchObject({ text: 'final' });
    // 下标 id 稳定，整列不会因为重读 JSONL 而重挂载。
    expect(result.current.map((m) => m.id)).toEqual(['sa-0', 'sa-1', 'sa-2', 'sa-3']);
  });

  it('运行中事件还在来就不重读 JSONL，安静满 5 秒才补读', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    renderHook(() => useChildSessionBinding(CHILD, true));
    await settle();
    expect(piMock.subagentGetSessionMessages).toHaveBeenCalledTimes(1);

    act(() => emit(start(10)));
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(piMock.subagentGetSessionMessages).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(piMock.subagentGetSessionMessages).toHaveBeenCalledTimes(2);
  });

  it('运行中安静补读：结果还没落盘的命令仍是运行中，不显示失败；子代理结束后才收成已中断', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const silentBash = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'Start-Sleep 5' } }],
      timestamp: 3,
    };
    piMock.subagentGetSessionMessages.mockResolvedValue({ messages: [user, silentBash] });
    const { result, rerender } = renderHook(({ running }) => useChildSessionBinding(CHILD, running), {
      initialProps: { running: true },
    });
    await settle();
    // 静默命令没有事件：满 5 秒触发补读，用 JSONL 快照整份替换
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(piMock.subagentGetSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
    const bash = result.current.find((m) => m.kind === 'tool');
    expect(bash).toMatchObject({ toolName: 'bash', status: 'running' });

    rerender({ running: false });
    await settle();
    expect(result.current.find((m) => m.kind === 'tool')).toMatchObject({ toolName: 'bash', status: 'error', interrupted: true });
  });

  // pi 并行执行工具时，整批都结束才把 toolResult 写进 JSONL（agent-loop executeToolCallsParallel）。
  // 快的工具先发了 tool_execution_end，慢的还在静默跑；安静补读拿到的快照里两个都没有结果。
  it('运行中安静补读：并行批次里已经结束的工具不被快照退回运行中', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const batch = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm test' } },
        { type: 'toolCall', id: 'c1', name: 'code_explore', arguments: { query: 'relay' } },
      ],
      timestamp: 3,
    };
    piMock.subagentGetSessionMessages.mockResolvedValue({ messages: [user, batch] });
    const { result } = renderHook(() => useChildSessionBinding(CHILD, true));
    await settle();

    act(() => {
      emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'npm test' } });
      emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'code_explore', args: { query: 'relay' } });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'code_explore',
        result: { content: [{ type: 'text', text: '相关上下文（3）' }] },
        isError: false,
      });
      flushRAF();
    });
    const tool = (id: string) => result.current.find((m) => m.kind === 'tool' && m.toolCallId === id);
    expect(tool('c1')).toMatchObject({ status: 'done' });

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(piMock.subagentGetSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(tool('c1')).toMatchObject({ toolName: 'code_explore', status: 'done' });
    expect(tool('b1')).toMatchObject({ toolName: 'bash', status: 'running' });
  });

  it('换 sessionPath 会退订旧的、清空画面', async () => {
    piMock.subagentGetSessionMessages.mockResolvedValue({ messages: [user, first] });
    const { result, rerender } = renderHook(({ path }) => useChildSessionBinding(path, false), {
      initialProps: { path: CHILD as string | null },
    });
    await settle();
    expect(result.current).toHaveLength(2);

    piMock.subagentGetSessionMessages.mockResolvedValue({ messages: [] });
    rerender({ path: null });
    await settle();
    expect(result.current).toHaveLength(0);
    expect(handlers).toHaveLength(0);
  });
});
