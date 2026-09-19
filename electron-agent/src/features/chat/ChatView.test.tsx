import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentState } from '../../stores/agentReducer';

const state = vi.hoisted(() => ({
  workspace: '/home/.pi/agent/works/u1',
  workspaceReady: true,
  messageCount: 0,
  storeState: {
    messages: [] as unknown[],
    isStreaming: false,
    steering: [] as string[],
    followUp: [] as string[],
    composerQueue: [] as Array<{ id: string; text: string }>,
    lastError: undefined as string | undefined,
    retrying: undefined as { attempt: number; max: number } | undefined,
  },
  pushUserMessage: vi.fn(),
  piPrompt: vi.fn(),
  piAbort: vi.fn(),
  piOpenWorkspace: vi.fn(),
  piNewSession: vi.fn(),
  piGetState: vi.fn(),
  piSetModel: vi.fn(),
  composerModel: { provider: 'openai', id: 'g' } as { provider: string; id: string } | null,
  peekCalls: [] as Array<{ provider: string; id: string } | null>,
  commitComposerModelToSession: vi.fn(),
  commandRun: vi.fn(),
  sessionState: {
    worksDir: '/home/.pi/agent/works',
    activeSessionPath: '/home/.pi/agent/works/u1/s.jsonl' as string | null,
    draftConversationCwd: null as string | null,
  },
  setActiveSession: vi.fn(),
  setWorkspaceSessionPath: vi.fn(),
  upsertOptimisticSession: vi.fn(),
  clearDraftConversation: vi.fn(),
  pendingSend: 'hello',
  pendingBehavior: undefined as 'steer' | 'followUp' | undefined,
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    prompt: state.piPrompt,
    abort: state.piAbort,
    openWorkspace: state.piOpenWorkspace,
    newSession: state.piNewSession,
    getState: state.piGetState,
    setModel: state.piSetModel,
    setSessionDisplayName: vi.fn(),
  },
}));
vi.mock('../../lib/commandLanes', () => ({ commandLanes: { run: state.commandRun } }));
vi.mock('../../lib/streamingGate', () => ({ awaitStreamingEnd: vi.fn() }));
vi.mock('../../lib/sidebarSessionSync', () => ({ syncSidebarOnSend: vi.fn() }));
vi.mock('./ChatListView', () => ({ ChatListView: () => <div data-testid="chat-list" /> }));
vi.mock('./ChatListSkeleton', () => ({ ChatListSkeleton: () => <div data-testid="chat-skeleton" /> }));
vi.mock('./ChatInput', () => ({
  ChatInput: (props: {
    onSend: (message: string, images?: unknown, behavior?: 'steer' | 'followUp') => void | Promise<void>;
    onAbort?: () => void | Promise<void>;
  }) => (
    <div>
      <button type="button" data-testid="chat-input" onClick={() => void props.onSend(state.pendingSend, undefined, state.pendingBehavior)}>
        send
      </button>
      <button type="button" data-testid="chat-abort" onClick={() => void props.onAbort?.()}>
        abort
      </button>
    </div>
  ),
}));
vi.mock('./input/actions/ModelThinkingAction', () => ({
  peekComposerModel: () => {
    const queued = state.peekCalls.shift();
    return queued !== undefined ? queued : state.composerModel;
  },
  commitComposerModelToSession: (...args: unknown[]) => state.commitComposerModelToSession(...args),
}));
vi.mock('./EmptyChatPrompt', () => ({
  EmptyChatPrompt: () => <div data-testid="empty-chat-prompt" />,
}));
vi.mock('../../store/session', () => {
  const store = () => ({
    ...state.sessionState,
    setActiveSession: (path: string) => {
      state.sessionState.activeSessionPath = path;
      state.setActiveSession(path);
    },
    setWorkspaceSessionPath: state.setWorkspaceSessionPath,
    upsertOptimisticSession: state.upsertOptimisticSession,
    clearDraftConversation: state.clearDraftConversation,
  });
  const useSessionStore = (sel: (s: ReturnType<typeof store>) => unknown) => sel(store());
  useSessionStore.getState = () => store();
  return { useSessionStore };
});
vi.mock('../../stores/AgentStoreContext', () => {
  const subscribers = new Set<(s: AgentState) => void>();
  const useStore = ((sel?: (s: AgentState) => unknown) =>
    sel ? sel(state.storeState as AgentState) : (state.storeState as AgentState)) as {
    (sel?: (s: AgentState) => unknown): unknown;
    getState: () => AgentState;
    setState: (partial: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
    subscribe: (listener: (s: AgentState) => void) => () => void;
  };
  useStore.getState = () => state.storeState as AgentState;
  useStore.setState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state.storeState as AgentState) : partial;
    state.storeState = { ...state.storeState, ...patch };
    for (const listener of subscribers) listener(state.storeState as AgentState);
  };
  useStore.subscribe = (listener) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  };
  return {
    useAgentStoreContext: () => ({
      workspace: state.workspace,
      store: {
        useStore,
        pushUserMessage: (text: string, images?: unknown, steering?: boolean) => {
          state.pushUserMessage(text, images, steering);
          state.storeState = {
            ...state.storeState,
            messages: [...state.storeState.messages, { kind: 'user', id: 'u1', text, ...(steering ? { steering: true } : {}) }],
          };
        },
      },
      setWorkspaceReady: () => {},
      appBooted: true,
      workspaceReady: state.workspaceReady,
    }),
  };
});

state.commandRun.mockImplementation((_: string, fn: () => Promise<unknown>) => fn());

import { CHAT_CONTENT_WIDTH } from './chatStyles';
import { ChatView } from './ChatView';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  state.workspace = '/home/.pi/agent/works/u1';
  state.workspaceReady = true;
  state.messageCount = 0;
  state.storeState = {
    messages: [],
    isStreaming: false,
    steering: [],
    followUp: [],
    composerQueue: [],
    lastError: undefined,
    retrying: undefined,
  };
  state.commandRun.mockImplementation((_: string, fn: () => Promise<unknown>) => fn());
  state.sessionState = {
    worksDir: '/home/.pi/agent/works',
    activeSessionPath: '/home/.pi/agent/works/u1/s.jsonl',
    draftConversationCwd: null,
  };
  state.pendingSend = 'hello';
  state.pendingBehavior = undefined;
  state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: '/home/.pi/agent/works/u1/s.jsonl' });
  state.piNewSession.mockResolvedValue(undefined);
  state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/s.jsonl' });
  state.composerModel = { provider: 'openai', id: 'g' };
  state.peekCalls = [];
  state.piSetModel.mockResolvedValue(undefined);
});

describe('ChatView 内容区 gating（骨架屏替代全屏）', () => {
  it('未就绪：内容区显示骨架屏，不显示消息列表', () => {
    state.workspaceReady = false;
    state.messageCount = 0;
    state.storeState.messages = [];
    render(<ChatView />);
    expect(screen.getByTestId('chat-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('chat-list')).toBeNull();
  });

  it('已就绪：显示消息列表，不显示骨架屏', () => {
    state.workspaceReady = true;
    state.messageCount = 1;
    state.storeState.messages = Array(state.messageCount).fill({});
    render(<ChatView />);
    expect(screen.getByTestId('chat-list')).toBeTruthy();
    expect(screen.queryByTestId('chat-skeleton')).toBeNull();
    expect(screen.getByTestId('composer-seat')).toBeTruthy();
  });

  it('composer seat matches the chat column background without a fade overlay', () => {
    state.workspaceReady = true;
    state.storeState.messages = [{}];
    render(<ChatView />);
    const seat = screen.getByTestId('composer-seat');
    expect(seat.innerHTML).not.toContain('linear-gradient');
    expect(seat.style.background).not.toContain('bg-layout');
    expect(seat.style.background).toMatch(/gren-content-bg|bg-container/);
  });

  it('空对话：居中占位 + 输入区，不渲染消息列表', () => {
    state.workspaceReady = true;
    state.messageCount = 0;
    state.storeState.messages = [];
    render(<ChatView />);
    expect(screen.getByTestId('empty-chat-prompt')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    expect(screen.queryByTestId('chat-list')).toBeNull();
    expect(screen.queryByTestId('composer-seat')).toBeNull();
  });

  it('keeps the compose column width when leaving the empty layout', () => {
    state.workspaceReady = true;
    state.messageCount = 0;
    state.storeState.messages = [];
    const empty = render(<ChatView />);
    expect(empty.getByTestId('chat-input-region')).toHaveStyle({ width: CHAT_CONTENT_WIDTH });
    empty.unmount();

    state.messageCount = 1;
    state.storeState.messages = Array(state.messageCount).fill({});
    render(<ChatView />);
    const occupied = screen.getByTestId('chat-input-region');
    expect(occupied).toHaveStyle({ width: '100%' });
    expect(occupied.parentElement).toHaveStyle({ width: CHAT_CONTENT_WIDTH });
  });
});

describe('ChatView 发送失败自动重试', () => {
  it('prompt 在进入 turn 前连续失败时，自动重试 5 次后才暴露最终错误', async () => {
    vi.useFakeTimers();
    state.workspaceReady = true;
    state.storeState.messages = [];
    state.piPrompt.mockRejectedValue(new Error('provider down'));

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(state.piPrompt).toHaveBeenCalledTimes(6);
    expect(state.storeState.lastError).toContain('已重试 5 次仍失败：provider down');
    expect(state.storeState.retrying).toBeUndefined();
  });

  it('用户中断（错误经事件流写入 lastError）不报错、不重试、不残留错误条', async () => {
    state.workspaceReady = true;
    state.storeState.messages = [];
    // 模拟 abort：pi.prompt 正常 resolve，但中断错误经事件流写进 store.lastError。
    state.piPrompt.mockImplementation(async () => {
      state.storeState.lastError = 'Request was aborted.';
    });

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piPrompt).toHaveBeenCalledTimes(1);
    expect(state.storeState.lastError).toBeUndefined();
    expect(state.storeState.retrying).toBeUndefined();
  });

  it('用户点停止后空轮（无 error 事件）按中断处理，不报「本轮没有返回」', async () => {
    state.workspaceReady = true;
    state.storeState.messages = [];
    // pi.prompt 挂起，等用户点停止后再 resolve；resolve 后末尾仍是 user 消息、无 lastError（空轮）。
    let resolvePrompt: () => void = () => {};
    state.piPrompt.mockImplementation(
      () => new Promise<void>((res) => { resolvePrompt = () => res(); }),
    );
    state.piAbort.mockResolvedValue(undefined);

    render(<ChatView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-input'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-abort'));
    });
    await act(async () => {
      resolvePrompt();
    });

    expect(state.piAbort).toHaveBeenCalled();
    expect(state.storeState.lastError).toBeUndefined();
    expect(state.storeState.retrying).toBeUndefined();
  });

  it('turn 已开始后失败（未真正重试）：直接显示错误，不加「已重试 N 次」前缀', async () => {
    state.workspaceReady = true;
    state.storeState.messages = [];
    // 已产出助手消息（turn 已开始）后再出错：retryable=false，不应触发重试，也不应套「已重试」前缀。
    state.piPrompt.mockImplementation(async () => {
      state.storeState.messages = [...state.storeState.messages, { kind: 'assistant', id: 'a1', text: 'x' }];
      state.storeState.lastError = 'boom';
    });

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piPrompt).toHaveBeenCalledTimes(1);
    expect(state.storeState.lastError).toBe('boom');
    expect(state.storeState.retrying).toBeUndefined();
  });

  it('首响应较慢（agent_start 未到、仍 awaitingResponse）时不误判空轮、不闪「发送失败」、不重发', async () => {
    state.workspaceReady = true;
    state.storeState.messages = [];
    // 慢启动：prompt 接受即返回，但 agent_start 尚未到达——awaitingResponse 仍为 true、未流式、
    // 末尾仍是 user 消息。这不是空轮，不应误判失败、闪「发送失败，正在重试」红条或重发 prompt。
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piPrompt).toHaveBeenCalledTimes(1);
    expect(state.storeState.lastError).toBeUndefined();
    expect(state.storeState.retrying).toBeUndefined();
  });

  it('重试状态存在时显示会话内重试提示和取消', () => {
    state.workspaceReady = true;
    state.storeState.messages = [{ kind: 'user', id: 'u1', text: 'hello' }];
    state.storeState.retrying = { attempt: 2, max: 5 };

    render(<ChatView />);

    expect(screen.getByTestId('send-retry-indicator').textContent).toContain('正在重试（2/5）');
    expect(screen.getByTestId('send-retry-cancel')).toBeTruthy();
  });

  it('重试等待期间点停止：结束重试、不再发 prompt、不报错', async () => {
    vi.useFakeTimers();
    state.workspaceReady = true;
    state.storeState.messages = [];
    state.piPrompt.mockRejectedValue(new Error('provider down'));
    state.piAbort.mockResolvedValue(undefined);

    render(<ChatView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-input'));
    });
    expect(state.storeState.retrying).toEqual({ attempt: 1, max: 5 });

    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-abort'));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(state.piAbort).toHaveBeenCalled();
    expect(state.piPrompt).toHaveBeenCalledTimes(1);
    expect(state.storeState.retrying).toBeUndefined();
    expect(state.storeState.lastError).toBeUndefined();
  });

  it('草稿对话首发时先懒初始化 workspace 和 session', async () => {
    state.composerModel = { provider: 'openai', id: 'g' };
    state.piSetModel.mockClear();
    state.piSetModel.mockResolvedValue(undefined);
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piOpenWorkspace).toHaveBeenCalledWith('/home/.pi/agent/works/u1');
    expect(state.piNewSession).toHaveBeenCalledWith('/home/.pi/agent/works/u1');
    expect(state.setActiveSession).toHaveBeenCalledWith('/home/.pi/agent/works/u1/created.jsonl');
    expect(state.clearDraftConversation).toHaveBeenCalledWith('/home/.pi/agent/works/u1');
    expect(state.commitComposerModelToSession).toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1',
      '/home/.pi/agent/works/u1/created.jsonl',
      { provider: 'openai', id: 'g' },
    );
    expect(state.piSetModel).toHaveBeenCalledWith('/home/.pi/agent/works/u1', 'openai', 'g');
    expect(state.commitComposerModelToSession.mock.invocationCallOrder[0]).toBeLessThan(
      state.piSetModel.mock.invocationCallOrder[0],
    );
    expect(state.piSetModel.mock.invocationCallOrder[0]).toBeLessThan(state.piPrompt.mock.invocationCallOrder[0]);
    expect(state.piNewSession.mock.invocationCallOrder[0]).toBeLessThan(state.piSetModel.mock.invocationCallOrder[0]);
  });

  it('草稿首发没有输入栏模型时不调用 setModel', async () => {
    state.composerModel = null;
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);
    state.piSetModel.mockClear();

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piNewSession).toHaveBeenCalled();
    expect(state.piSetModel).not.toHaveBeenCalled();
    expect(state.piPrompt).toHaveBeenCalled();
  });

  it('项目草稿首发即使 openWorkspace 带回上一会话也要 newSession 再 setModel', async () => {
    state.workspace = 'D:/repo/app';
    state.composerModel = { provider: 'openai', id: 'g' };
    state.piSetModel.mockClear();
    state.sessionState.worksDir = '/home/.pi/agent/works';
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = 'D:/repo/app';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: 'D:/repo/app/old.jsonl' });
    state.piGetState.mockResolvedValue({ sessionFile: 'D:/repo/app/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piOpenWorkspace).toHaveBeenCalledWith('D:/repo/app');
    expect(state.piNewSession).toHaveBeenCalledWith('D:/repo/app');
    expect(state.setActiveSession).toHaveBeenCalledWith('D:/repo/app/created.jsonl');
    expect(state.clearDraftConversation).toHaveBeenCalledWith('D:/repo/app');
    expect(state.commitComposerModelToSession).toHaveBeenCalledWith(
      'D:/repo/app',
      'D:/repo/app/created.jsonl',
      { provider: 'openai', id: 'g' },
    );
    expect(state.piSetModel).toHaveBeenCalledWith('D:/repo/app', 'openai', 'g');
    expect(state.piSetModel.mock.invocationCallOrder[0]).toBeLessThan(state.piPrompt.mock.invocationCallOrder[0]);
    expect(state.piNewSession.mock.invocationCallOrder[0]).toBeLessThan(state.piSetModel.mock.invocationCallOrder[0]);
  });

  it('草稿首发用发送瞬间的输入栏模型，不被 await 之后的默认回填盖掉', async () => {
    state.composerModel = { provider: 'deepseek', id: 'deepseek-flash' };
    state.peekCalls = [{ provider: 'custom-mu78dr9u', id: 'grok-4.6-fast' }];
    state.piSetModel.mockClear();
    state.piSetModel.mockResolvedValue(undefined);
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.commitComposerModelToSession).toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1',
      '/home/.pi/agent/works/u1/created.jsonl',
      { provider: 'custom-mu78dr9u', id: 'grok-4.6-fast' },
    );
    expect(state.piSetModel).toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1',
      'custom-mu78dr9u',
      'grok-4.6-fast',
    );
    expect(state.piSetModel).not.toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1',
      'deepseek',
      'deepseek-flash',
    );
  });

  it('草稿首发 getState 遇到 SESSION_WORKSPACE_MISMATCH 时新建会话再读', async () => {
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState
      .mockRejectedValueOnce(new Error('SESSION_WORKSPACE_MISMATCH'))
      .mockResolvedValueOnce({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piNewSession).toHaveBeenCalledTimes(2);
    expect(state.setActiveSession).toHaveBeenCalledWith('/home/.pi/agent/works/u1/created.jsonl');
    expect(state.storeState.lastError).toBeUndefined();
    expect(state.piPrompt).toHaveBeenCalled();
  });

  it('停流后空跟进回车只冲刷队列，不再插一条用户气泡', async () => {
    state.workspaceReady = true;
    state.storeState.messages = [{ kind: 'user', id: 'u1', text: '改用 chrome 跑自动化' }];
    state.pendingSend = '';
    state.pendingBehavior = 'followUp';
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.pushUserMessage).not.toHaveBeenCalled();
    expect(state.piPrompt).toHaveBeenCalledWith('/home/.pi/agent/works/u1', '', 'followUp');
  });

  it('执行中发送先落成跟进条，不立刻 prompt、不进对话', async () => {
    state.storeState.isStreaming = true;
    state.pendingSend = '先别再测了';
    state.pendingBehavior = 'followUp';
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.pushUserMessage).not.toHaveBeenCalled();
    expect(state.piPrompt).not.toHaveBeenCalled();
    expect(state.storeState.composerQueue).toEqual([expect.objectContaining({ text: '先别再测了' })]);
  });

  it('空闲时若已有跟进条则自动作为新一轮发出', async () => {
    state.storeState.isStreaming = false;
    state.storeState.composerQueue = [{ id: 'cq-1', text: '改用 chrome' }];
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    await act(async () => {});

    expect(state.pushUserMessage).toHaveBeenCalledWith('改用 chrome', undefined, undefined);
    expect(state.storeState.composerQueue).toEqual([]);
    expect(state.piPrompt).toHaveBeenCalledWith('/home/.pi/agent/works/u1', '改用 chrome', undefined, undefined);
  });
});
