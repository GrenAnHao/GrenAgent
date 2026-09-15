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
    lastError: undefined as string | undefined,
    retrying: undefined as { attempt: number; max: number } | undefined,
  },
  pushUserMessage: vi.fn(),
  piPrompt: vi.fn(),
  piAbort: vi.fn(),
  piOpenWorkspace: vi.fn(),
  piNewSession: vi.fn(),
  piGetState: vi.fn(),
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
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    prompt: state.piPrompt,
    abort: state.piAbort,
    openWorkspace: state.piOpenWorkspace,
    newSession: state.piNewSession,
    getState: state.piGetState,
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
    onSend: (message: string) => void | Promise<void>;
    onAbort?: () => void | Promise<void>;
  }) => (
    <div>
      <button type="button" data-testid="chat-input" onClick={() => void props.onSend(state.pendingSend)}>
        send
      </button>
      <button type="button" data-testid="chat-abort" onClick={() => void props.onAbort?.()}>
        abort
      </button>
    </div>
  ),
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
        pushUserMessage: (text: string) => {
          state.pushUserMessage(text);
          state.storeState = {
            ...state.storeState,
            messages: [...state.storeState.messages, { kind: 'user', id: 'u1', text }],
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

import { pi } from '../../lib/pi';
import { useCommandInputStore } from '../../stores/commandInputStore';
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
  state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: '/home/.pi/agent/works/u1/s.jsonl' });
  state.piNewSession.mockResolvedValue(undefined);
  state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/s.jsonl' });
  useCommandInputStore.setState({ bySession: {} });
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

  it('重试状态存在时显示会话内重试提示', () => {
    state.workspaceReady = true;
    state.storeState.messages = [{ kind: 'user', id: 'u1', text: 'hello' }];
    state.storeState.retrying = { attempt: 2, max: 5 };

    render(<ChatView />);

    expect(screen.getByTestId('send-retry-indicator').textContent).toContain('正在重试（2/5）');
  });

  it('草稿对话首发时先懒初始化 workspace 和 session', async () => {
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

  it('项目点新会话后发送时即使已有 last_session 也要新建，而不是写回旧会话', async () => {
    state.workspace = '/proj/foo';
    state.sessionState.worksDir = '/home/.pi/agent/works';
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/proj/foo';
    state.piOpenWorkspace.mockResolvedValue({
      restoredSession: '/proj/foo/old.jsonl',
      sessionFile: '/proj/foo/old.jsonl',
    });
    state.piGetState.mockResolvedValue({ sessionFile: '/proj/foo/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piNewSession).toHaveBeenCalledWith('/proj/foo');
    expect(state.setActiveSession).toHaveBeenCalledWith('/proj/foo/created.jsonl');
    expect(state.clearDraftConversation).toHaveBeenCalledWith('/proj/foo');
    expect(state.piPrompt).toHaveBeenCalled();
  });
});

describe('ChatView 执行性 /goal', () => {
  it('草稿对话发送 /goal 时先落盘会话再 prompt，并留下 command-input', async () => {
    state.sessionState.activeSessionPath = null;
    state.sessionState.draftConversationCwd = '/home/.pi/agent/works/u1';
    state.pendingSend = '/goal 测试子代理理';
    state.piOpenWorkspace.mockResolvedValue({ restoredSession: null, sessionFile: null });
    state.piGetState.mockResolvedValue({ sessionFile: '/home/.pi/agent/works/u1/created.jsonl' });
    state.piPrompt.mockResolvedValue(undefined);

    render(<ChatView />);
    fireEvent.click(screen.getByTestId('chat-input'));
    await act(async () => {});

    expect(state.piNewSession).toHaveBeenCalledWith('/home/.pi/agent/works/u1');
    expect(state.setActiveSession).toHaveBeenCalledWith('/home/.pi/agent/works/u1/created.jsonl');
    expect(state.piPrompt).toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1',
      '/goal 测试子代理理',
      undefined,
      undefined,
    );
    expect(state.piPrompt.mock.invocationCallOrder[0]).toBeGreaterThan(
      state.setActiveSession.mock.invocationCallOrder[0],
    );
    expect(state.pushUserMessage).not.toHaveBeenCalled();
    expect(useCommandInputStore.getState().list('/home/.pi/agent/works/u1/created.jsonl')).toEqual([
      expect.objectContaining({
        kind: 'command-input',
        command: '/goal',
        rest: '测试子代理理',
        beforeCount: 0,
      }),
    ]);
    expect(screen.queryByTestId('empty-chat-prompt')).toBeNull();
    expect(screen.getByTestId('chat-list')).toBeTruthy();
    expect(state.upsertOptimisticSession).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/.pi/agent/works/u1/created.jsonl',
        name: '测试子代理理',
      }),
    );
    expect(pi.setSessionDisplayName).toHaveBeenCalledWith(
      '/home/.pi/agent/works/u1/created.jsonl',
      '测试子代理理',
    );
  });
});
