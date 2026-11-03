import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../store/session';
import { applyOpenedProject, enterPendingNewSession, needsSessionCreateOnSend } from './pendingSession';

beforeEach(() => {
  useSessionStore.setState({
    activeWorkspace: '/proj',
    activeSessionPath: '/proj/old.jsonl',
    draftConversationCwd: null,
    draftConversationId: null,
  });
});

describe('needsSessionCreateOnSend', () => {
  it('已有会话且不是待创建草稿时不建', () => {
    expect(
      needsSessionCreateOnSend({
        workspace: '/proj',
        activeSessionPath: '/proj/a.jsonl',
        draftConversationCwd: null,
      }),
    ).toBe(false);
  });

  it('对话草稿要建', () => {
    expect(
      needsSessionCreateOnSend({
        workspace: '/works/u1',
        activeSessionPath: null,
        draftConversationCwd: '/works/u1',
      }),
    ).toBe(true);
  });

  it('项目点新会话后没有 path 也要建', () => {
    expect(
      needsSessionCreateOnSend({
        workspace: '/proj',
        activeSessionPath: null,
        draftConversationCwd: '/proj',
      }),
    ).toBe(true);
  });

  it('项目无草稿标记但 path 为空也要建', () => {
    expect(
      needsSessionCreateOnSend({
        workspace: '/proj',
        activeSessionPath: '',
        draftConversationCwd: null,
      }),
    ).toBe(true);
  });
});

describe('enterPendingNewSession', () => {
  it('同项目连续新建草稿使用不同身份，不能覆盖之前草稿的偏好和输入', () => {
    enterPendingNewSession('/proj');
    const first = useSessionStore.getState().draftConversationId;
    enterPendingNewSession('/proj');
    const second = useSessionStore.getState().draftConversationId;
    expect(typeof first).toBe('string');
    expect(first).toMatch(/^draft:/);
    expect(second).not.toBe(first);
  });

  it('恢复已有草稿身份，旧首发完成不能清除后来创建的草稿', () => {
    useSessionStore.getState().setDraftConversation('/proj', 'draft:restored');
    expect(useSessionStore.getState().draftConversationId).toBe('draft:restored');
    useSessionStore.getState().setDraftConversation('/proj', 'draft:newer');
    useSessionStore.getState().clearDraftConversation('/proj', 'draft:restored');
    expect(useSessionStore.getState().draftConversationId).toBe('draft:newer');
    useSessionStore.getState().clearDraftConversation('/proj', 'draft:newer');
    expect(useSessionStore.getState().draftConversationId).toBeNull();
    expect(useSessionStore.getState().draftConversationCwd).toBeNull();
  });
  it('清掉当前会话并记下待创建 cwd，同工作区时回调 reset', () => {
    const reset = vi.fn();
    enterPendingNewSession('/proj', reset);
    const st = useSessionStore.getState();
    expect(st.activeSessionPath).toBe('');
    expect(st.draftConversationCwd).toBe('/proj');
    expect(st.activeWorkspace).toBe('/proj');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('切到别的工作区时改 activeWorkspace，不 reset 当前 store', () => {
    const reset = vi.fn();
    enterPendingNewSession('/other', reset);
    const st = useSessionStore.getState();
    expect(st.activeWorkspace).toBe('/other');
    expect(st.draftConversationCwd).toBe('/other');
    expect(st.activeSessionPath).toBe('');
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('applyOpenedProject', () => {
  it('从其他项目恢复已有草稿时切回目标工作区并保留草稿身份', () => {
    useSessionStore.setState({ activeWorkspace: '/other', draftConversationCwd: '/proj', draftConversationId: 'draft:keep-current' });
    const reset = vi.fn();
    applyOpenedProject('/proj', null, reset);
    expect(useSessionStore.getState().activeWorkspace).toBe('/proj');
    expect(useSessionStore.getState().draftConversationId).toBe('draft:keep-current');
    expect(useSessionStore.getState().activeSessionPath).toBe('');
    expect(reset).not.toHaveBeenCalled();
  });
  it('重复打开同一未使用项目不替换当前草稿身份', () => {
    useSessionStore.getState().setDraftConversation('/proj', 'draft:keep-current');
    applyOpenedProject('/proj', null);
    expect(useSessionStore.getState().draftConversationId).toBe('draft:keep-current');
  });

  it('没有可恢复会话时把项目标成草稿，供输入栏读默认模型', () => {
    useSessionStore.setState({
      activeWorkspace: '/works/scratch',
      activeSessionPath: '',
      draftConversationCwd: '/works/scratch',
    });
    const reset = vi.fn();
    applyOpenedProject('/proj', null, reset);
    const st = useSessionStore.getState();
    expect(st.activeWorkspace).toBe('/proj');
    expect(st.draftConversationCwd).toBe('/proj');
    expect(st.activeSessionPath).toBe('');
    expect(reset).not.toHaveBeenCalled();
  });

  it('有上一会话时恢复该会话，并清掉残留的草稿标记', () => {
    useSessionStore.setState({
      activeWorkspace: '/works/scratch',
      activeSessionPath: '',
      draftConversationCwd: '/works/scratch',
    });
    applyOpenedProject('/proj', '/proj/last.jsonl');
    const st = useSessionStore.getState();
    expect(st.activeWorkspace).toBe('/proj');
    expect(st.draftConversationCwd).toBeNull();
    expect(st.activeSessionPath).toBe('/proj/last.jsonl');
    expect(st.workspaceSessionPaths['/proj']).toBe('/proj/last.jsonl');
  });
});
