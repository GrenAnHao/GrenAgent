import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useModuleStore } from '../../stores/moduleStore';
import { useSessionStore } from '../../store/session';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import type { SessionInfo } from '../../lib/pi';

const WORKSPACE = 'D:/repo';
const A: SessionInfo = { id: 'a', path: 'D:/sessions/a.jsonl', cwd: WORKSPACE, timestamp: '2026-10-30T08:00:00Z', name: '检查登录流程' };
const B: SessionInfo = { id: 'b', path: 'D:/sessions/b.jsonl', cwd: WORKSPACE, timestamp: '2026-10-30T09:00:00Z', name: '调整工作台标题' };

beforeEach(() => {
  useModuleStore.setState({ activeWorkspaceView: 'chat' });
  useSessionStore.setState({ activeWorkspace: WORKSPACE, activeSessionPath: A.path, draftConversationCwd: null, draftConversationId: null, allSessions: [A, B], optimisticSessions: [], deletedSessionPaths: [] });
});

afterEach(() => {
  cleanup();
});

describe('WorkspaceTabs', () => {
  it('shows the selected session title instead of a fixed view label', () => {
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent(A.name!);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveAttribute('title', A.name);
  });

  it('updates after switching and renaming the selected session', () => {
    render(<WorkspaceTabs />);
    act(() => useSessionStore.getState().setActiveSession(B.path));
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent(B.name!);
    act(() => useSessionStore.setState({ allSessions: [A, { ...B, name: '新生成的会话标题' }] }));
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('新生成的会话标题');
  });

  it('uses the same optimistic title fallback as the sidebar', () => {
    useSessionStore.setState({ allSessions: [{ ...A, name: null }], optimisticSessions: [{ ...A, name: '首条消息的临时标题' }] });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('首条消息的临时标题');
    act(() => useSessionStore.setState({ allSessions: [{ ...A, name: '正式标题' }] }));
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('正式标题');
  });

  it('does not borrow the previous session title for a new draft', () => {
    useSessionStore.setState({ draftConversationCwd: WORKSPACE, draftConversationId: 'fresh' });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('新对话');
  });

  it('keeps an explicit view session separate from the global selection', () => {
    useSessionStore.setState({ activeSessionPath: B.path });
    render(<AgentStoreContext.Provider value={{ workspace: WORKSPACE, sessionPath: A.path, store: {} as never, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true }}><WorkspaceTabs /></AgentStoreContext.Provider>);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent(A.name!);
  });

  it('treats an explicit empty view as a draft', () => {
    render(<AgentStoreContext.Provider value={{ workspace: WORKSPACE, sessionPath: null, draftId: 'fresh', store: {} as never, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true }}><WorkspaceTabs /></AgentStoreContext.Provider>);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('新对话');
  });

  it('matches Windows session paths without changing the full title', () => {
    const title = '很长的会话标题'.repeat(30);
    useSessionStore.setState({ activeSessionPath: 'd:\\SESSIONS\\A.JSONL', allSessions: [{ ...A, name: title }] });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveAttribute('title', title);
    expect(screen.getByTestId('workspace-tab-title').textContent).toBe(title);
  });

  it('shows the new-dialog fallback until the selected session record arrives', () => {
    useSessionStore.setState({ allSessions: [] });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent('新对话');
    act(() => useSessionStore.setState({ allSessions: [A] }));
    expect(screen.getByTestId('workspace-tab-chat')).toHaveTextContent(A.name!);
  });

  it('renders all workspace view tabs', () => {
    render(<WorkspaceTabs />);
    for (const id of ['chat']) {
      expect(screen.getByTestId(`workspace-tab-${id}`)).toBeTruthy();
    }
  });

  it('does not render retired knowledge or memory workspace tabs', () => {
    render(<WorkspaceTabs />);
    expect(screen.queryByTestId('workspace-tab-knowledge')).toBeNull();
    expect(screen.queryByTestId('workspace-tab-memory')).toBeNull();
  });

  it('keeps chat as the active workspace view', () => {
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByTestId('workspace-tab-chat'));
    expect(useModuleStore.getState().activeWorkspaceView).toBe('chat');
  });

  it('marks the active view with aria-pressed', () => {
    useModuleStore.setState({ activeWorkspaceView: 'chat' });
    render(<WorkspaceTabs />);
    expect(screen.getByTestId('workspace-tab-chat').getAttribute('aria-pressed')).toBe('true');
  });
});
