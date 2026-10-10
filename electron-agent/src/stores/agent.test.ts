import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 捕获事件订阅 handler + pi 命令 mock。用 vi.hoisted 确保在 vi.mock 工厂（被提升到文件顶部）执行前已初始化。
const { eventHandlers, exitHandlers, piMock } = vi.hoisted(() => ({
  eventHandlers: [] as Array<(e: { workspace: string; event: unknown; source?: 'interactive' | 'goal'; sessionPath?: string }) => void>,
  exitHandlers: [] as Array<(e: { workspace: string; code: number | null; source?: 'interactive' | 'goal'; sessionPath?: string }) => void>,
  piMock: {
    excludeEntry: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    restoreEntry: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    rewindTo: vi.fn((_ws: string, _ts: number) => Promise.resolve()),
    truncateTo: vi.fn(
      (
        _ws: string,
        _entryId: string,
        _mode: 'drop-target' | 'keep-target',
      ): Promise<{ ok: true; lines: string[] } | { ok: false; reason: 'branched' | 'missing' }> =>
        Promise.resolve({ ok: true, lines: [] }),
    ),
    getMessages: vi.fn(
      (_ws: string): Promise<{ messages: unknown[] }> => Promise.resolve({ messages: [] }),
    ),
    writeUiHistory: vi.fn((_ws: string, _key: string, _jsonl: string) => Promise.resolve()),
    deleteUiHistory: vi.fn((_ws: string, _key: string) => Promise.resolve()),
    readAskUserDraft: vi.fn((_ws: string, _toolCallId: string) => Promise.resolve(null)),
    readUiHistory: vi.fn((_ws: string, _key: string) => Promise.resolve('')),
  },
}));
vi.mock('../lib/pi', () => ({
  pi: piMock,
  onPiEvent: (h: (e: { workspace: string; event: unknown; source?: 'interactive' | 'goal' }) => void) => {
    eventHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onPiExit: (h: (e: { workspace: string; code: number | null; source?: 'interactive' | 'goal'; sessionPath?: string }) => void) => {
    exitHandlers.push(h);
    return Promise.resolve(() => {});
  },
}));
// agent.ts 直接 import 的符号在本工作树 todo-model 里尚未落地；单测只关心消息载入路径。
vi.mock('@extensions/_shared/todo-model', () => ({
  todoListFinishedInTranscript: () => false,
}));

import { createAgentStore } from './agent';
import { clearThinkingDurationsForTest } from '../lib/thinkingDurations';
import { getCachedSession, invalidateCachedSession } from '../lib/sessionMessageCache';
import { useInlineQuestionStore } from './inlineQuestionStore';
import type { QSData } from '../components/QuestionSelector/answers';

function emit(event: unknown, source?: 'interactive' | 'goal', sessionPath?: string) {
  for (const h of eventHandlers) h({ workspace: '.', event, source, ...(sessionPath ? { sessionPath } : {}) });
}

describe('createAgentStore', () => {
  let store: ReturnType<typeof createAgentStore>;
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    eventHandlers.length = 0;
    exitHandlers.length = 0;
    rafCallbacks = [];
    piMock.excludeEntry.mockReset().mockResolvedValue(undefined);
    piMock.restoreEntry.mockReset().mockResolvedValue(undefined);
    piMock.rewindTo.mockReset().mockResolvedValue(undefined);
    piMock.truncateTo.mockReset().mockResolvedValue({ ok: true, lines: [] });
    piMock.getMessages.mockReset().mockResolvedValue({ messages: [] });
    piMock.writeUiHistory.mockReset().mockResolvedValue(undefined);
    piMock.deleteUiHistory.mockReset().mockResolvedValue(undefined);
    piMock.readAskUserDraft.mockReset().mockResolvedValue(null);
    piMock.readUiHistory.mockReset().mockResolvedValue('');
    useInlineQuestionStore.setState({ byWorkspace: {} });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
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

  it('前景进程退出先应用排队事件，再清掉运行标记，迟到帧不会恢复运行', () => {
    store = createAgentStore('.');
    const path = '/s/exit.jsonl';
    store.loadMessages([], { force: true, sessionPath: path });
    store.pushUserMessage('run');
    store.useStore.setState({ awaitingResponse: true });
    emit({ type: 'agent_start' }, 'interactive', path);
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } }, 'interactive', path);
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'last output' } }, 'interactive', path);

    for (const h of exitHandlers) h({ workspace: '.', sessionPath: path, code: 1 });
    expect(store.useStore.getState().messages.some((m) => m.kind === 'assistant' && m.text === 'last output')).toBe(true);
    expect(store.useStore.getState()).toMatchObject({ isStreaming: false, runActive: false, awaitingResponse: false });
    expect(store.hasLiveActivity()).toBe(false);
    flushRAF();
    expect(store.useStore.getState()).toMatchObject({ isStreaming: false, runActive: false, awaitingResponse: false });
  });

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

  it('drops headless Goal worker events from the interactive message stream', () => {
    store = createAgentStore('.');
    emit({ type: 'agent_start' }, 'goal');
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 111 } }, 'goal');
    flushRAF();
    expect(store.useStore.getState().messages).toHaveLength(0);
    expect(store.useStore.getState().isStreaming).toBe(false);
  });

  it('subagent_catalog_changed 不进消息', () => {
    store = createAgentStore('.');
    const before = store.useStore.getState();
    emit({ type: 'subagent_catalog_changed', sessionPath: '/parent.jsonl' });
    flushRAF();
    expect(store.useStore.getState().messages).toEqual(before.messages);
    expect(store.useStore.getState().lastError).toBe(before.lastError);
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

  it('loadMessages 把 memory_extract 会话展开成原对话气泡', () => {
    store = createAgentStore('.');
    const prompt = [
      'Extract durable memory as strict JSON with optional keys l1 (object), l2 (string), and l3 (string). Return JSON only.',
      'Task kind: memory_extract',
      'Input: {"delta":"user: 你是什么模型?\\nassistant: 我是 Claude。"}',
    ].join('\n');
    store.loadMessages(
      [
        { role: 'user', content: [{ type: 'text', text: prompt }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"l2":"用户询问模型身份"}' }] },
      ] as never,
      { force: true, sessionPath: '/sessions/extract.jsonl' },
    );
    const msgs = store.useStore.getState().messages;
    expect(msgs[0]).toMatchObject({ kind: 'user', text: '你是什么模型?' });
    expect(msgs[1]).toMatchObject({ kind: 'assistant', text: '我是 Claude。' });
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

  it('loadMessages caches the restored ask_user waiting row used for signature', () => {
    store = createAgentStore('.');
    const sessionPath = '/sessions/ask-wait.jsonl';
    // uiHistory 必须严格长于 backend（backend = user + messagesFromAgent 补的 ask_user 行 → 2），
    // 才会走「用 UI 完整历史盖掉 backend」分支，从而暴露「先签名后补行」的缓存空洞。
    const uiHistory = [
      { id: 'h-0', kind: 'user' as const, text: 'early' },
      { id: 'h-1', kind: 'assistant' as const, text: 'ok', thinking: '', streaming: false },
      { id: 'h-2', kind: 'user' as const, text: 'pick one' },
    ];
    const backendMsgs = [
      { role: 'user', content: 'pick one' },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'q1',
            name: 'ask_user',
            arguments: { questions: [{ question: '选哪个' }] },
          },
        ],
      },
    ];
    store.loadMessages(backendMsgs as never, { force: true, sessionPath, uiHistory });

    const isWaiting = (m: { kind: string; toolCallId?: string; status?: string }) =>
      m.kind === 'tool' && m.toolCallId === 'q1' && m.status === 'running';

    expect(store.useStore.getState().messages.some(isWaiting)).toBe(true);

    const cached = getCachedSession(sessionPath);
    expect(cached?.messages.some(isWaiting)).toBe(true);

    // 切走再灌缓存：缓存必须已含 waiting，否则 showCachedSession 会丢掉补行。
    store.loadMessages([{ role: 'user', content: 'other' }] as never, {
      force: true,
      sessionPath: '/sessions/other.jsonl',
    });
    expect(store.showCachedSession(sessionPath)).toBe(true);
    expect(store.useStore.getState().messages.some(isWaiting)).toBe(true);

    // 同会话再次 load：签名须基于补行后列表，否则会提前 return 且界面停在无 waiting 的缓存。
    store.loadMessages(backendMsgs as never, { force: true, sessionPath, uiHistory });
    expect(store.useStore.getState().messages.some(isWaiting)).toBe(true);
  });

  const askOverlayData: QSData = {
    kind: 'questions',
    id: 'q1',
    questions: [{ id: 'q1', title: '选哪个', options: [{ id: 'o1', label: '甲' }] }],
  };

  it('showCachedSession 无 pending ask_user 时立刻清掉上一会话的询问卡', async () => {
    store = createAgentStore('.');
    const withAsk = '/sessions/with-ask.jsonl';
    const plain = '/sessions/plain.jsonl';

    store.loadMessages(
      [
        { role: 'user', content: 'pick' },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'old-tc',
              name: 'ask_user',
              arguments: { questions: [{ question: '选哪个', options: ['甲'] }] },
            },
          ],
        },
      ] as never,
      { force: true, sessionPath: withAsk },
    );
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']?.id).toBe('old-tc');
    });

    store.loadMessages([{ role: 'user', content: 'hello' }] as never, {
      force: true,
      sessionPath: plain,
    });
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']).toBeUndefined();
    });

    // 再挂一张属于 withAsk 的卡，模拟切走前浮层仍在。
    useInlineQuestionStore.getState().setRequest({
      workspace: '.',
      id: 'stale-tc',
      data: askOverlayData,
      mode: 'restored',
      toolCallId: 'stale-tc',
      sessionPath: withAsk,
    });

    expect(store.showCachedSession(plain)).toBe(true);
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']).toBeUndefined();
    });
  });

  it('showCachedSession 有 pending ask_user 时立刻换成缓存会话的卡', async () => {
    store = createAgentStore('.');
    const sessionA = '/sessions/a.jsonl';
    const sessionB = '/sessions/b.jsonl';

    store.loadMessages(
      [
        { role: 'user', content: 'a' },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc-a',
              name: 'ask_user',
              arguments: { questions: [{ question: 'A题', options: ['甲'] }] },
            },
          ],
        },
      ] as never,
      { force: true, sessionPath: sessionA },
    );
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']?.id).toBe('tc-a');
    });

    store.loadMessages(
      [
        { role: 'user', content: 'b' },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc-b',
              name: 'ask_user',
              arguments: { questions: [{ question: 'B题', options: ['乙'] }] },
            },
          ],
        },
      ] as never,
      { force: true, sessionPath: sessionB },
    );
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']?.id).toBe('tc-b');
    });

    // 浮层仍是 B，消息切回 A 的缓存：卡必须立刻变成 tc-a，不能留着 tc-b。
    expect(store.showCachedSession(sessionA)).toBe(true);
    await vi.waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['.']).toMatchObject({
        id: 'tc-a',
        mode: 'restored',
        toolCallId: 'tc-a',
        sessionPath: sessionA,
      });
    });
  });

  it('强制重载不会覆盖等待中的实时事件队列', () => {
    store = createAgentStore('.');
    store.loadMessages(
      [
        { role: 'user', content: 'previous' },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      ] as never,
      { force: true, sessionPath: '/s/live.jsonl' },
    );
    store.pushUserMessage('current');
    store.useStore.setState({ awaitingResponse: true });

    // 事件已从 sidecar 到达，但还没等到下一帧 flush；此时 App 的后台 getMessages
    // 若强制重载，会在旧实现中 clearQueue 并把实时轮次整个抹掉。
    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({
      type: 'tool_execution_start',
      toolCallId: 'live-tool',
      toolName: 'bash',
      args: { command: 'echo live' },
    });
    store.loadMessages(
      [
        { role: 'user', content: 'previous' },
        { role: 'assistant', content: [{ type: 'text', text: 'new snapshot' }] },
      ] as never,
      { force: true, sessionPath: '/s/live.jsonl' },
    );
    flushRAF();

    const state = store.useStore.getState();
    expect(state.isStreaming).toBe(true);
    expect(state.messages.some((m) => m.kind === 'tool' && m.toolCallId === 'live-tool')).toBe(true);
  });

  it('同会话快照先应用排队的实时事件，保留未落盘正文', () => {
    store = createAgentStore('.');
    const path = '/s/pending-live.jsonl';
    store.loadMessages([], { force: true, sessionPath: path });
    // 后台回报等主动开启的回合没有 awaitingResponse 占位，状态要由排队的 agent_start 接管。
    emit({ type: 'agent_start' }, 'interactive', path);
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } }, 'interactive', path);
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live token' } }, 'interactive', path);
    store.loadMessages([{ role: 'user', content: 'stale snapshot' }], { force: true, sessionPath: path });
    flushRAF();
    expect(store.useStore.getState().isStreaming).toBe(true);
    expect(store.useStore.getState().messages).toMatchObject([{ kind: 'assistant', text: 'live token' }]);
  });

  it('同会话快照先应用排队的结束事件，再允许更新历史', () => {
    store = createAgentStore('.');
    const path = '/s/pending-end.jsonl';
    store.loadMessages([], { force: true, sessionPath: path });
    emit({ type: 'agent_start' }, 'interactive', path);
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } }, 'interactive', path);
    flushRAF();
    expect(store.useStore.getState().isStreaming).toBe(true);
    emit({ type: 'agent_end', messages: [] }, 'interactive', path);
    emit({ type: 'agent_settled' }, 'interactive', path);
    store.loadMessages([{ role: 'user', content: 'updated history' }], { force: true, sessionPath: path });
    expect(store.useStore.getState()).toMatchObject({
      isStreaming: false,
      messages: [{ kind: 'user', text: 'updated history' }],
    });
    expect(Boolean(store.useStore.getState().runActive)).toBe(false);
  });

  it('强制切换到另一会话仍会加载目标快照', () => {
    store = createAgentStore('.');
    store.loadMessages(
      [{ role: 'user', content: 'old session' }] as never,
      { force: true, sessionPath: '/s/old.jsonl' },
    );
    store.useStore.setState({ isStreaming: true });

    store.loadMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: 'other session' }] }] as never,
      { force: true, sessionPath: '/s/other.jsonl' },
    );

    const state = store.useStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.messages).toHaveLength(1);
  });

  it('正在跑的会话切走后，它的事件不写进当前画面', () => {
    store = createAgentStore('.');
    store.loadMessages([{ role: 'user', content: 'session a' }] as never, {
      force: true,
      sessionPath: '/s/a.jsonl',
    });
    store.loadMessages([{ role: 'user', content: 'session b' }] as never, {
      force: true,
      sessionPath: '/s/b.jsonl',
    });
    store.pushUserMessage('still on b');
    emit({ type: 'agent_start' }, 'interactive', '/s/a.jsonl');
    flushRAF();
    expect(store.useStore.getState().isStreaming).toBe(false);
    expect(store.useStore.getState().messages.some((m) => m.kind === 'user' && m.text === 'still on b')).toBe(true);

    expect(store.showCachedSession('/s/a.jsonl')).toBe(true);
    const back = store.useStore.getState();
    expect(back.isStreaming).toBe(true);
    expect(back.messages.some((m) => m.kind === 'user' && m.text === 'session a')).toBe(true);
    expect(back.messages.some((m) => m.kind === 'user' && m.text === 'still on b')).toBe(false);
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

  it('active store 的 rAF 被暂停时 setTimeout 兜底唤醒（防 rAF 死锁：queue 不再无限堆积）', () => {
    vi.useFakeTimers();
    store = createAgentStore('.');
    // active（默认）→ rAF + timeout 双保险排程。此处不调用 flushRAF，模拟窗口最小化后
    // rAF 回调永不触发（rafId 永久非 null）的场景：修复前 queue 会无限堆积、UI 冻结。
    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });
    // 后续事件在「rAF 已排程但未触发」时继续到达（scheduleFlush 被 rafId != null 挡住）
    emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: '正文' }], timestamp: 1 },
      assistantMessageEvent: { type: 'text_delta', delta: '正文' },
    });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正文' }], timestamp: 1 } });

    // timeout 兜底到点 → flush 应用全部堆积事件
    vi.advanceTimersByTime(80);
    const msgs = store.useStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('assistant');
    expect((msgs[0] as { text: string }).text).toBe('正文');
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

    it('truncateTo 本地找不到 entryId 时 getMessages 重建并落盘短列表', async () => {
      store = createAgentStore('.');
      store.loadMessages(
        [
          { role: 'user', content: 'keep', entryId: 'u1', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }], entryId: 'a1', timestamp: 2 },
          { role: 'user', content: 'gone', entryId: 'u2', timestamp: 3 },
        ] as never,
        { force: true, sessionPath: '/ws/foo.jsonl' },
      );
      // 模拟 UI 列表缺 entryId（无法本地裁切），但磁盘截断已成功
      store.useStore.setState({
        messages: store.useStore.getState().messages.map((m) =>
          m.kind === 'user' ? { ...m, entryId: undefined } : m,
        ),
      });
      piMock.writeUiHistory.mockClear();
      piMock.deleteUiHistory.mockClear();
      piMock.getMessages.mockResolvedValueOnce({
        messages: [
          { role: 'user', content: 'keep', entryId: 'u1', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }], entryId: 'a1', timestamp: 2 },
        ],
      });

      await store.truncateTo('u2', 'drop-target');

      expect(piMock.truncateTo).toHaveBeenCalledWith('.', 'u2', 'drop-target');
      expect(piMock.getMessages).toHaveBeenCalled();
      const msgs = store.useStore.getState().messages;
      expect(msgs).toHaveLength(2);
      expect(msgs.every((m) => m.kind !== 'user' || (m as { text: string }).text !== 'gone')).toBe(true);

      const writes = piMock.writeUiHistory.mock.calls.map((c) => String(c[2]));
      const deleted = piMock.deleteUiHistory.mock.calls.length > 0;
      // 写 0 次且未删旧历史 = 失败：短列表必须落盘，或至少删掉更长的旧 ui-history
      expect(writes.length > 0 || deleted).toBe(true);
      if (writes.length > 0) {
        expect(writes.some((body) => body.includes('gone'))).toBe(false);
        expect(writes.some((body) => body.includes('keep'))).toBe(true);
        expect(piMock.writeUiHistory).toHaveBeenCalledWith('.', 'foo', expect.any(String));
      } else {
        expect(piMock.deleteUiHistory).toHaveBeenCalledWith('.', 'foo');
      }
    });

    it('truncateTo 找不到 entryId 且 getMessages 失败时删除 ui-history', async () => {
      store = createAgentStore('.');
      store.loadMessages(
        [{ role: 'user', content: 'x', entryId: 'u1', timestamp: 1 }] as never,
        { force: true, sessionPath: '/ws/bar.jsonl' },
      );
      store.useStore.setState({
        messages: store.useStore.getState().messages.map((m) =>
          m.kind === 'user' ? { ...m, entryId: undefined } : m,
        ),
      });
      piMock.getMessages.mockRejectedValueOnce(new Error('offline'));
      piMock.writeUiHistory.mockClear();
      piMock.deleteUiHistory.mockClear();

      await store.truncateTo('u1', 'drop-target');

      expect(piMock.deleteUiHistory).toHaveBeenCalledWith('.', 'bar');
      expect(piMock.writeUiHistory.mock.calls.length).toBe(0);
    });

    it('truncateTo 磁盘目标 missing 时不裁短界面、不写 ui-history', async () => {
      store = createAgentStore('.');
      store.loadMessages(
        [
          { role: 'user', content: 'keep', entryId: 'u1', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }], entryId: 'a1', timestamp: 2 },
          { role: 'user', content: 'tail', entryId: 'u2', timestamp: 3 },
        ] as never,
        { force: true, sessionPath: '/ws/miss.jsonl' },
      );
      const before = store.useStore.getState().messages.map((m) => m.id);
      piMock.truncateTo.mockResolvedValueOnce({ ok: false, reason: 'missing' });
      piMock.writeUiHistory.mockClear();
      piMock.deleteUiHistory.mockClear();

      await expect(store.truncateTo('no-such', 'drop-target')).rejects.toThrow(/截断失败|missing/i);

      expect(store.useStore.getState().messages.map((m) => m.id)).toEqual(before);
      expect(piMock.writeUiHistory.mock.calls.length).toBe(0);
      expect(piMock.deleteUiHistory.mock.calls.length).toBe(0);
    });
  });

  it('回合结束后按序回填本地用户消息的 entryId，不重排', async () => {
    store = createAgentStore('.');
    store.loadMessages([], { force: true, sessionPath: '/ws/s.jsonl' });
    store.pushUserMessage('hello');
    expect(store.useStore.getState().messages[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect((store.useStore.getState().messages[0] as { entryId?: string }).entryId).toBeUndefined();

    piMock.getMessages.mockResolvedValueOnce({
      messages: [
        { role: 'user', content: 'hello', entryId: 'entry-hello', timestamp: 42 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
          entryId: 'entry-asst',
          timestamp: 43,
        },
      ],
    });

    emit({ type: 'agent_start' });
    emit({
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 43 },
    });
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
        timestamp: 43,
      },
    });
    emit({ type: 'agent_end' });
    flushRAF();

    await vi.waitFor(() => {
      const user = store.useStore.getState().messages.find((m) => m.kind === 'user');
      expect(user).toMatchObject({ text: 'hello', entryId: 'entry-hello', timestamp: 42 });
    });
    const ids = store.useStore.getState().messages.map((m) => m.id);
    expect(ids[0]).toBe(store.useStore.getState().messages[0]!.id);
  });

  it('发送被接受后、回合未结束前，本地用户消息已有 entryId', async () => {
    store = createAgentStore('.');
    store.loadMessages([], { force: true, sessionPath: '/ws/mid.jsonl' });
    store.pushUserMessage('hello');
    store.useStore.setState({ awaitingResponse: true, isStreaming: true });
    piMock.getMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'hello', entryId: 'entry-mid', timestamp: 99 }],
    });
    piMock.writeUiHistory.mockClear();

    await store.syncEntryIdsAfterAccept();

    const user = store.useStore.getState().messages.find((m) => m.kind === 'user');
    expect(user).toMatchObject({ text: 'hello', entryId: 'entry-mid', timestamp: 99 });
    expect(store.useStore.getState().isStreaming).toBe(true);
    expect(piMock.getMessages).toHaveBeenCalled();
    // 不得整表重置：消息 id 保持，只补字段
    expect(user!.id).toBe(store.useStore.getState().messages[0]!.id);
  });

  it('flush 解析工具草稿；大草稿推迟到队列空时再解析', () => {
    vi.useFakeTimers({
      now: 1_000_000,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    store = createAgentStore('.');
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write' },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a.txt","content":"hi' },
    });
    flushRAF();
    const first = store.useStore.getState().messages.find((m) => m.kind === 'tool');
    expect(first).toMatchObject({ args: { path: 'a.txt', content: 'hi' } });

    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'x'.repeat(64 * 1024) },
    });
    flushRAF();
    const held = store.useStore.getState().messages.find((m) => m.kind === 'tool');
    expect(held).toMatchObject({ args: { path: 'a.txt', content: 'hi' } });
    expect(store.useStore.getState().toolDrafts?.[0]?.dirty).toBe(true);

    vi.advanceTimersByTime(150);
    const parsed = store.useStore.getState().messages.find((m) => m.kind === 'tool');
    expect(store.useStore.getState().toolDrafts?.[0]?.dirty).toBe(false);
    expect(parsed?.kind === 'tool' ? JSON.stringify(parsed.args).length : 0).toBeGreaterThan(1000);
  });
  describe('同项目两个会话同时在跑', () => {
    const A = '/ws/two-a.jsonl';
    const B = '/ws/two-b.jsonl';
    const text = (body: string, ts: number) => [
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } },
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: body }], timestamp: ts },
        assistantMessageEvent: { type: 'text_delta', delta: body },
      },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: body }], timestamp: ts } },
    ];
    const assistantTexts = () =>
      store.useStore.getState().messages.flatMap((m) => (m.kind === 'assistant' ? [m.text] : []));
    const userTexts = () =>
      store.useStore.getState().messages.flatMap((m) => (m.kind === 'user' ? [m.text] : []));

    beforeEach(() => {
      invalidateCachedSession(A);
      invalidateCachedSession(B);
    });

    it('后台连续增量批量更新缓存，切回前先应用排队内容', () => {
      vi.useFakeTimers();
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      const before = getCachedSession(A)?.messages;
      emit({ type: 'agent_start' }, 'interactive', A);
      emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 101 } }, 'interactive', A);
      for (let i = 0; i < 100; i++) emit({
        type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' },
      }, 'interactive', A);
      expect(getCachedSession(A)?.messages).toBe(before);
      expect(store.showCachedSession(A)).toBe(true);
      expect(assistantTexts()).toEqual(['a'.repeat(100)]);
      expect(store.useStore.getState().isStreaming).toBe(true);
      expect(piMock.getMessages).not.toHaveBeenCalled();
    });

    it('草稿首发绑定 A 后新建 B，交替事件各回各的画面，来回切换都只显示自己的内容', () => {
      store = createAgentStore('.');
      // 草稿首发：ensureSessionForSend 落盘后绑定路径。
      store.pushUserMessage('task A');
      store.bindSessionPath(A);
      expect(store.getLoadedSessionPath()).toBe(A);
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of text('answer A1', 101)) emit(ev, 'interactive', A);
      flushRAF();
      expect(assistantTexts()).toEqual(['answer A1']);

      // 新建对话：A 停到后台；B 再从草稿首发。
      store.reset();
      store.pushUserMessage('task B');
      store.bindSessionPath(B);
      emit({ type: 'agent_start' }, 'interactive', B);
      // 交替到达：A 的事件只进 A 的 shadow，B 的进画面。
      for (const ev of text('answer A2', 102)) emit(ev, 'interactive', A);
      for (const ev of text('answer B1', 201)) emit(ev, 'interactive', B);
      flushRAF();
      expect(userTexts()).toEqual(['task B']);
      expect(assistantTexts()).toEqual(['answer B1']);
      expect(store.useStore.getState().isStreaming).toBe(true);

      // 切回 A：显示 A 的实时内容和流式标记，B 的内容不在。
      expect(store.showCachedSession(A)).toBe(true);
      expect(userTexts()).toEqual(['task A']);
      expect(assistantTexts()).toEqual(['answer A1', 'answer A2']);
      expect(store.useStore.getState().isStreaming).toBe(true);
      expect(store.hasLiveActivity()).toBe(true);

      // 后端快照稍后回来：同一会话流式中，不能被快照覆盖。
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      expect(assistantTexts()).toEqual(['answer A1', 'answer A2']);

      // B 在后台继续跑并结束；A 继续往画面写。
      for (const ev of text('answer B2', 202)) emit(ev, 'interactive', B);
      emit({ type: 'agent_end', messages: [] }, 'interactive', B);
      emit({ type: 'agent_settled' }, 'interactive', B);
      for (const ev of text('answer A3', 103)) emit(ev, 'interactive', A);
      flushRAF();
      expect(assistantTexts()).toEqual(['answer A1', 'answer A2', 'answer A3']);

      // 再切到 B：只有 B 的内容，B 已经结束所以没有流式标记。
      expect(store.showCachedSession(B)).toBe(true);
      expect(userTexts()).toEqual(['task B']);
      expect(assistantTexts()).toEqual(['answer B1', 'answer B2']);
      expect(store.useStore.getState().isStreaming).toBe(false);

      // A 后台结束后切回：内容完整，流式标记清掉。
      emit({ type: 'agent_end', messages: [] }, 'interactive', A);
      emit({ type: 'agent_settled' }, 'interactive', A);
      flushRAF();
      expect(assistantTexts()).toEqual(['answer B1', 'answer B2']);
      expect(store.showCachedSession(A)).toBe(true);
      expect(assistantTexts()).toEqual(['answer A1', 'answer A2', 'answer A3']);
      expect(store.useStore.getState().isStreaming).toBe(false);
    });

    it('显式给了另一个路径的 loadMessages 一律按切换处理，并把正在跑的画面停到后台', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of text('live A', 111)) emit(ev, 'interactive', A);
      flushRAF();
      expect(store.useStore.getState().isStreaming).toBe(true);

      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      expect(store.getLoadedSessionPath()).toBe(B);
      expect(userTexts()).toEqual(['task B']);
      expect(store.useStore.getState().isStreaming).toBe(false);

      for (const ev of text('more A', 112)) emit(ev, 'interactive', A);
      flushRAF();
      expect(assistantTexts()).toEqual([]);

      // 回到 A：shadow 比后端快照新，直接显示 shadow 并接着流式。
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      expect(assistantTexts()).toEqual(['live A', 'more A']);
      expect(store.useStore.getState().isStreaming).toBe(true);
    });

    it('未 flush 的事件在切走时落进原会话，不丢也不串到新画面', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of text('pending A', 121)) emit(ev, 'interactive', A);
      // 不 flush 就切走
      store.showCachedSession(B);
      flushRAF();
      expect(assistantTexts()).toEqual([]);
      store.showCachedSession(A);
      expect(assistantTexts()).toEqual(['pending A']);
    });

    it('切走再切回还在跑的会话：正在处理的计时起点不变', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      emit({ type: 'agent_start' }, 'interactive', A);
      flushRAF();
      const started = store.useStore.getState().runStartedAt;
      expect(started).toEqual(expect.any(Number));

      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      expect(store.useStore.getState().runStartedAt).toBeUndefined();
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      expect(store.useStore.getState().isStreaming).toBe(true);
      expect(store.useStore.getState().runStartedAt).toBe(started);
    });

    it('同一会话强制重载不换计时起点', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      store.useStore.setState({ runStartedAt: 1234 });
      store.loadMessages([{ role: 'user', content: 'task A' }, { role: 'assistant', content: 'x' }] as never, { force: true, sessionPath: A });
      expect(store.useStore.getState().runStartedAt).toBe(1234);
    });

    it('停靠时空闲的会话之后被唤醒（如后台子代理回报后再起子代理），事件不灌进草稿', () => {
      store = createAgentStore('.');
      // A 空闲时切到 B：A 没有 shadow，只留 detachedPath。
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      // 新建草稿：停靠 B，detachedPath 换成 B。
      store.reset();
      expect(store.getLoadedSessionPath()).toBeUndefined();

      // A 被唤醒，起一个子代理。
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of text('A woke up', 131)) emit(ev, 'interactive', A);
      emit({
        type: 'tool_execution_start',
        toolCallId: 'spawn-1',
        toolName: 'spawn_agent',
        args: { task: 'child task' },
      }, 'interactive', A);
      flushRAF();
      expect(store.useStore.getState().messages).toEqual([]);
      expect(store.useStore.getState().isStreaming).toBe(false);

      // 切回 A：A 的实时内容都在。
      expect(store.showCachedSession(A)).toBe(true);
      expect(userTexts()).toEqual(['task A']);
      expect(assistantTexts()).toEqual(['A woke up']);
      expect(store.useStore.getState().isStreaming).toBe(true);
    });

    // 只发到流式中途：这条助手消息还没落盘，后端快照里没有它。
    const inFlight = (body: string, ts: number) => [
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } },
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: body }], timestamp: ts },
        assistantMessageEvent: { type: 'text_delta', delta: body },
      },
    ];
    const snapshotA = [
      { role: 'user', content: 'task A', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2 },
    ];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('画面没见过的会话在后台跑：先补后端快照，切回直接显示完整历史和实时尾巴', async () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      piMock.getMessages.mockResolvedValue({ messages: snapshotA });
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of inFlight('live tail', 3)) emit(ev, 'interactive', A);
      await settle();
      expect(piMock.getMessages).toHaveBeenCalledWith('.', A);

      expect(store.showCachedSession(A)).toBe(true);
      expect(userTexts()).toEqual(['task A']);
      expect(assistantTexts()).toEqual(['old answer', 'live tail']);
      expect(store.useStore.getState().isStreaming).toBe(true);
    });

    it('快照还没回来就切回：显示骨架，尾巴继续收事件，快照到了垫在前面', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      piMock.getMessages.mockImplementation(() => new Promise(() => {}));
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of inFlight('live', 3)) emit(ev, 'interactive', A);

      expect(store.showCachedSession(A)).toBe(false);
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'live more' }], timestamp: 3 },
        assistantMessageEvent: { type: 'text_delta', delta: ' more' },
      }, 'interactive', A);
      flushRAF();
      expect(assistantTexts()).toEqual(['live more']);

      store.loadMessages(snapshotA as never, { force: true, sessionPath: A });
      expect(userTexts()).toEqual(['task A']);
      expect(assistantTexts()).toEqual(['old answer', 'live more']);
      expect(store.useStore.getState().isStreaming).toBe(true);
    });

    it('历史还没到就切走：只有尾巴的画面不进缓存，也不覆盖 UI 历史，切回仍走骨架', () => {
      store = createAgentStore('.');
      piMock.getMessages.mockImplementation(() => new Promise(() => {}));
      expect(store.showCachedSession(A)).toBe(false);
      emit({ type: 'agent_start' }, 'interactive', A);
      for (const ev of text('tail', 3)) emit(ev, 'interactive', A);
      flushRAF();
      expect(piMock.writeUiHistory).not.toHaveBeenCalled();

      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      expect(getCachedSession(A)).toBeUndefined();
      expect(store.showCachedSession(A)).toBe(false);
      expect(assistantTexts()).toEqual(['tail']);
      expect(store.useStore.getState().isStreaming).toBe(true);
    });

    it('再点一次正在显示的在跑会话：内容已经在屏上，不退回骨架', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      store.pushUserMessage('go');
      emit({ type: 'agent_start' }, 'interactive', A);
      flushRAF();
      expect(store.showCachedSession(A)).toBe(true);
      expect(userTexts()).toEqual(['task A', 'go']);
    });

    it('跟进条跟着会话走，切到另一个会话后不会被冲进去', () => {
      store = createAgentStore('.');
      store.loadMessages([{ role: 'user', content: 'task A' }] as never, { force: true, sessionPath: A });
      emit({ type: 'agent_start' }, 'interactive', A);
      flushRAF();
      store.useStore.setState({ composerQueue: [{ id: 'q1', text: 'follow A' }] });
      store.loadMessages([{ role: 'user', content: 'task B' }] as never, { force: true, sessionPath: B });
      expect(store.useStore.getState().composerQueue).toEqual([]);
      store.showCachedSession(A);
      expect(store.useStore.getState().composerQueue).toEqual([{ id: 'q1', text: 'follow A' }]);
    });
  });
});
