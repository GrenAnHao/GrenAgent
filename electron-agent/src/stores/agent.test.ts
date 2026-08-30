import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 捕获事件订阅 handler + pi 命令 mock。用 vi.hoisted 确保在 vi.mock 工厂（被提升到文件顶部）执行前已初始化。
const { eventHandlers, piMock } = vi.hoisted(() => ({
  eventHandlers: [] as Array<(e: { workspace: string; event: unknown }) => void>,
  piMock: {
    excludeEntry: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    restoreEntry: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    rewindTo: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    getMessages: vi.fn(
      (_ws: string): Promise<{ messages: unknown[] }> => Promise.resolve({ messages: [] }),
    ),
    writeUiHistory: vi.fn((_ws: string, _key: string, _jsonl: string) => Promise.resolve()),
  },
}));
vi.mock('../lib/pi', () => ({
  pi: piMock,
  onPiEvent: (h: (e: { workspace: string; event: unknown }) => void) => {
    eventHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onPiExit: () => Promise.resolve(() => {}),
}));

import { createAgentStore } from './agent';
import { clearThinkingDurationsForTest } from '../lib/thinkingDurations';

function emit(event: unknown) {
  for (const h of eventHandlers) h({ workspace: '.', event });
}

describe('createAgentStore', () => {
  let store: ReturnType<typeof createAgentStore>;
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    eventHandlers.length = 0;
    rafCallbacks = [];
    piMock.excludeEntry.mockReset().mockResolvedValue(undefined);
    piMock.restoreEntry.mockReset().mockResolvedValue(undefined);
    piMock.rewindTo.mockReset().mockResolvedValue(undefined);
    piMock.getMessages.mockReset().mockResolvedValue({ messages: [] });
    piMock.writeUiHistory.mockReset().mockResolvedValue(undefined);
    clearThinkingDurationsForTest();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    store?.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const flushRAF = () => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb(performance.now());
  };

  it('loadMessages is skipped after live user activity unless forced', () => {
    store = createAgentStore('.');
    store.pushUserMessage('hello');
    expect(store.useStore.getState().messages).toHaveLength(1);

    store.loadMessages([{ role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }]);
    expect(store.useStore.getState().messages).toHaveLength(1);
    expect(store.useStore.getState().messages[0].kind).toBe('user');

    store.loadMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: 'synced' }] }],
      { force: true },
    );
    expect(store.useStore.getState().messages).toHaveLength(1);
    expect(store.useStore.getState().messages[0].kind).toBe('assistant');
  });

  it('一帧内的多条事件批量应用（flush 前不可见，flush 后按顺序生效）', () => {
    store = createAgentStore('.');
    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 111 } });
    emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '推理中' }],
        timestamp: 111,
      },
      assistantMessageEvent: { type: 'thinking_delta', delta: '推理中' },
    });

    // 尚未到动画帧：状态不变
    expect(store.useStore.getState().messages).toHaveLength(0);
    expect(store.useStore.getState().isStreaming).toBe(false);

    flushRAF();

    const s = store.useStore.getState();
    expect(s.isStreaming).toBe(true);
    const m = s.messages.at(-1);
    expect(m?.kind).toBe('assistant');
    expect(m?.kind === 'assistant' ? m.thinking : '').toBe('推理中');
  });

  it('推理时长在 message_end 后持久化，切换会话恢复时按 timestamp 回填', () => {
    // 只 fake Date（推理计时用 Date.now），不接管 rAF/setTimeout。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1700000000000);

    store = createAgentStore('.');
    const ts = 1700000000123;

    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } });
    emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '思考…' }],
        timestamp: ts,
      },
      assistantMessageEvent: { type: 'thinking_delta', delta: '思考…' },
    });
    flushRAF(); // 首个 thinking 出现：记下推理起点

    vi.advanceTimersByTime(2300); // 推理耗时 2.3s

    emit({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考…' },
          { type: 'text', text: '答案' },
        ],
        timestamp: ts,
      },
      assistantMessageEvent: { type: 'text_delta', delta: '答案' },
    });
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考…' },
          { type: 'text', text: '答案' },
        ],
        timestamp: ts,
      },
    });
    emit({ type: 'agent_end', messages: [] });
    flushRAF();

    const live = store.useStore.getState().messages.at(-1);
    expect(live?.kind === 'assistant' ? live.thinkingDuration : undefined).toBe(2300);

    // 模拟切换会话后从 get_messages 还原：pi 数据本身不带时长
    store.loadMessages(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '思考…' },
            { type: 'text', text: '答案' },
          ],
          timestamp: ts,
        },
      ],
      { force: true },
    );
    const restored = store.useStore.getState().messages.at(-1);
    expect(restored?.kind === 'assistant' ? restored.thinkingDuration : undefined).toBe(2300);
  });

  it('getLoadedSessionPath 记录载入会话，reset 后回到未载入态', () => {
    store = createAgentStore('.');
    // 从未载入：undefined（与「载入了空会话 null」区分，供切回时判断是否需完整加载）
    expect(store.getLoadedSessionPath()).toBeUndefined();

    store.loadMessages([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }], {
      force: true,
      sessionPath: '/s/a.jsonl',
    });
    expect(store.getLoadedSessionPath()).toBe('/s/a.jsonl');

    // 未带 sessionPath 的载入不改写已记录的会话路径
    store.loadMessages([], { force: true });
    expect(store.getLoadedSessionPath()).toBe('/s/a.jsonl');

    store.reset();
    expect(store.getLoadedSessionPath()).toBeUndefined();
  });

  it('loadMessages 在 uiHistory 比后端更长时使用 UI 完整历史', () => {
    store = createAgentStore('.');
    const uiHistory = [
      { id: 'h-0', kind: 'user' as const, text: 'early', timestamp: 1 },
      { id: 'h-1', kind: 'user' as const, text: 'recent', timestamp: 2 },
    ];
    store.loadMessages([{ role: 'user', content: 'recent', timestamp: 2 }] as never, {
      force: true,
      sessionPath: '/sessions/foo.jsonl',
      uiHistory,
    });
    const msgs = store.useStore.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].kind).toBe('user');
    expect(msgs[0].kind === 'user' ? msgs[0].text : '').toBe('early');
  });

  it('loadMessages 首次载入用后端起底并写 UI 历史', async () => {
    store = createAgentStore('.');
    store.loadMessages([{ role: 'user', content: 'hello', timestamp: 1 }] as never, {
      force: true,
      sessionPath: '/sessions/foo.jsonl',
    });
    await vi.waitFor(() => expect(piMock.writeUiHistory).toHaveBeenCalled());
    expect(piMock.writeUiHistory).toHaveBeenCalledWith('.', 'foo', expect.any(String));
  });

  it('agent_end flush 写入 UI 完整历史', async () => {
    store = createAgentStore('.');
    store.loadMessages([], { force: true, sessionPath: '/s/test.jsonl' });
    piMock.writeUiHistory.mockClear();
    emit({ type: 'agent_end', messages: [] });
    flushRAF();
    await vi.waitFor(() => expect(piMock.writeUiHistory).toHaveBeenCalled());
    expect(piMock.writeUiHistory).toHaveBeenCalledWith('.', 'test', expect.any(String));
  });

  it('实时流式中（live + 未带 sessionPath）loadMessages 不被跳过仅在 force 时覆盖', () => {
    store = createAgentStore('.');
    store.pushUserMessage('hi');
    // live 态下普通 loadMessages 被忽略，loadedSessionPath 不应被设置
    store.loadMessages([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }], {
      sessionPath: '/s/should-not-apply.jsonl',
    });
    expect(store.getLoadedSessionPath()).toBeUndefined();
    expect(store.useStore.getState().messages[0].kind).toBe('user');
  });

  it('reset 丢弃尚未应用的排队事件', () => {
    store = createAgentStore('.');
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });
    store.reset();
    flushRAF();
    expect(store.useStore.getState().messages).toHaveLength(0);
  });

  it('非 active store 用 setTimeout 兜底 flush（rAF 不触发也能更新）', () => {
    vi.useFakeTimers();
    store = createAgentStore('.');
    store.setActive(false);

    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });

    // 非 active：不走 rAF，flush 前不可见
    flushRAF();
    expect(store.useStore.getState().messages).toHaveLength(0);

    // setTimeout 到点后应用
    vi.advanceTimersByTime(80);
    expect(store.useStore.getState().isStreaming).toBe(true);
  });

  describe('上下文控制（移出 / 恢复 / 回退 / 重建）', () => {
    it('excludeMessage 乐观加入 excluded 并调后端命令', async () => {
      store = createAgentStore('.');
      await store.excludeMessage(123);
      expect(store.useStore.getState().excluded.has(123)).toBe(true);
      expect(piMock.excludeEntry).toHaveBeenCalledWith('.', 123);
    });

    it('excludeMessage 后端失败时回滚 excluded 并抛出', async () => {
      store = createAgentStore('.');
      piMock.excludeEntry.mockRejectedValueOnce(new Error('boom'));
      await expect(store.excludeMessage(7)).rejects.toThrow('boom');
      expect(store.useStore.getState().excluded.has(7)).toBe(false);
    });

    it('restoreMessage 乐观移除 excluded 并调后端命令', async () => {
      store = createAgentStore('.');
      await store.excludeMessage(5);
      await store.restoreMessage(5);
      expect(store.useStore.getState().excluded.has(5)).toBe(false);
      expect(piMock.restoreEntry).toHaveBeenCalledWith('.', 5);
    });

    it('rewindTo 调后端并按返回消息重载', async () => {
      store = createAgentStore('.');
      piMock.getMessages.mockResolvedValueOnce({
        messages: [{ role: 'user', content: 'after rewind', timestamp: 1 }],
      });
      await store.rewindTo(999);
      expect(piMock.rewindTo).toHaveBeenCalledWith('.', 999);
      const msgs = store.useStore.getState().messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].kind).toBe('user');
    });

    it('loadMessages 从 context_exclusion 条目重建 excluded（add 后 remove 抵消）', () => {
      store = createAgentStore('.');
      store.loadMessages(
        [
          { role: 'user', content: 'a', timestamp: 100 },
          { role: 'user', content: 'b', timestamp: 200 },
          { role: 'custom', customType: 'context_exclusion', data: { op: 'add', ts: 100 } },
          { role: 'custom', customType: 'context_exclusion', data: { op: 'add', ts: 200 } },
          { role: 'custom', customType: 'context_exclusion', data: { op: 'remove', ts: 100 } },
        ] as never,
        { force: true },
      );
      const excluded = store.useStore.getState().excluded;
      expect(excluded.has(200)).toBe(true);
      expect(excluded.has(100)).toBe(false);
    });
  });
});
