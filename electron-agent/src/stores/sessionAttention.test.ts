import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DONE_GRACE_MS,
  applyGoalState,
  forgetSessionAttention,
  handleAttentionEvent,
  isSessionVisible,
  listedSessionKeys,
  recomputePending,
  resetSessionAttentionForTest,
  resolveSessionTarget,
  sessionStateOf,
  sessionStates,
  setWindowFocused,
  syncVisibility,
  useAttentionStore,
} from './sessionAttention';
import { useSessionStore } from '../store/session';
import { useUiPromptStore } from './uiPromptStore';
import { sessionControlKey } from './modeStore';
import type { PiEventEnvelope } from '../lib/pi';
import type { GoalSnapshot } from './goalStore';

const WS = 'D:/repo';
const A = 'D:/repo/.pi/a.jsonl';
const B = 'D:/repo/.pi/b.jsonl';

const ev = (path: string, event: Record<string, unknown>, extra: Partial<PiEventEnvelope> = {}): PiEventEnvelope =>
  ({ workspace: WS, sessionPath: path, source: 'interactive', event, ...extra }) as PiEventEnvelope;
const start = (path: string) => handleAttentionEvent(ev(path, { type: 'agent_start' }));
const end = (path: string, stopReason: string, errorMessage?: string, willRetry = false) =>
  handleAttentionEvent(
    ev(path, {
      type: 'agent_end',
      willRetry,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) },
      ],
    }),
  );
const settled = (path: string) => handleAttentionEvent(ev(path, { type: 'agent_settled' }));
const outcome = (path: string) => sessionStateOf(useAttentionStore.getState(), path)?.unread?.outcome;
const blocked = (path: string) => sessionStateOf(useAttentionStore.getState(), path)?.unread?.blocked;

const session = (path: string, name: string) => ({ id: name, path, cwd: WS, timestamp: '2026-10-19T08:00:00Z', name });

const goal = (status: GoalSnapshot['status'], message?: string): GoalSnapshot => ({
  goalId: 'g1',
  sessionId: 'sid-b',
  revision: 3,
  condition: '修完测试',
  status,
  roundsStarted: 2,
  maxRounds: 10,
  createdAt: '2026-10-19T08:00:00Z',
  updatedAt: '2026-10-19T08:10:00Z',
  ranMs: 1000,
  activation: 'armed',
  ...(message ? { blockedReason: { code: 'x', message } } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.setState({
    activeSessionPath: A,
    allSessions: [session(A, '会话 A'), session(B, '重构订单查询栏')],
    optimisticSessions: [],
    deletedSessionPaths: [],
    workspaceSessionPaths: { [WS]: A },
  });
});

afterEach(() => {
  resetSessionAttentionForTest();
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
  vi.useRealTimers();
});

describe('sessionAttention rounds', () => {
  it('marks done after the grace window', () => {
    start(B);
    end(B, 'stop');
    settled(B);
    vi.advanceTimersByTime(DONE_GRACE_MS - 1);
    expect(outcome(B)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(outcome(B)).toMatchObject({ kind: 'done', seq: 1 });
  });

  it('skips done when the next Goal round starts within the window', () => {
    end(B, 'stop');
    settled(B);
    vi.advanceTimersByTime(300);
    start(B);
    vi.advanceTimersByTime(5000);
    expect(outcome(B)).toBeUndefined();
  });

  it('restarts the grace window at agent_settled', () => {
    end(B, 'stop');
    vi.advanceTimersByTime(1000);
    settled(B);
    vi.advanceTimersByTime(1000);
    start(B);
    vi.advanceTimersByTime(5000);
    expect(outcome(B)).toBeUndefined();
  });

  it('ignores agent_end that will retry', () => {
    end(B, 'error', 'overloaded', true);
    vi.advanceTimersByTime(5000);
    expect(outcome(B)).toBeUndefined();
  });

  it('records failed immediately with the error message', () => {
    end(B, 'error', '429 rate limited');
    expect(outcome(B)).toEqual({ kind: 'failed', message: '429 rate limited', seq: 1 });
  });

  it('keeps failed while running and replaces it with the next outcome', () => {
    end(B, 'error', 'boom');
    start(B);
    expect(outcome(B)).toMatchObject({ kind: 'failed', seq: 1 });
    end(B, 'stop');
    settled(B);
    vi.advanceTimersByTime(DONE_GRACE_MS);
    expect(outcome(B)).toEqual({ kind: 'done', seq: 2 });
  });

  it('clears done when a new round starts', () => {
    end(B, 'stop');
    vi.advanceTimersByTime(DONE_GRACE_MS);
    expect(outcome(B)?.kind).toBe('done');
    start(B);
    expect(outcome(B)).toBeUndefined();
  });

  it('leaves outcomes alone on abort', () => {
    end(B, 'error', 'boom');
    start(B);
    end(B, 'aborted');
    vi.advanceTimersByTime(5000);
    expect(outcome(B)).toEqual({ kind: 'failed', message: 'boom', seq: 1 });
  });

  it('ignores goal and subagent sources and events without sessionPath', () => {
    handleAttentionEvent(ev(B, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] }, { source: 'goal' }));
    handleAttentionEvent(ev(B, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] }, { source: 'subagent' }));
    handleAttentionEvent({ workspace: WS, event: { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] } } as never);
    expect(useAttentionStore.getState().unread).toEqual({});
  });
});

describe('sessionAttention visibility', () => {
  it('does not record unread for the visible session', () => {
    end(A, 'error', 'boom');
    end(A, 'stop');
    vi.advanceTimersByTime(DONE_GRACE_MS);
    expect(outcome(A)).toBeUndefined();
    expect(isSessionVisible(A)).toBe(true);
    expect(isSessionVisible(B)).toBe(false);
  });

  it('records unread for the active session while unfocused and clears it on focus', () => {
    setWindowFocused(false);
    expect(isSessionVisible(A)).toBe(false);
    end(A, 'error', 'boom');
    expect(outcome(A)?.kind).toBe('failed');
    expect(useAttentionStore.getState().visibleKey).toBeUndefined();
    setWindowFocused(true);
    expect(outcome(A)).toBeUndefined();
    expect(useAttentionStore.getState().visibleKey).toBe(sessionControlKey(A));
  });

  it('clears unread when the session is opened', () => {
    end(B, 'error', 'boom');
    expect(outcome(B)?.kind).toBe('failed');
    useSessionStore.setState({ activeSessionPath: B });
    syncVisibility();
    expect(outcome(B)).toBeUndefined();
  });

  it('treats differently spelled paths as one session', () => {
    handleAttentionEvent(ev('D:\\Repo\\.pi\\b.jsonl', { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }] }));
    expect(sessionStateOf(useAttentionStore.getState(), 'd:/repo/.pi/b.jsonl')?.unread?.outcome?.kind).toBe('failed');
    expect(sessionStateOf(useAttentionStore.getState(), B)?.unread?.outcome?.kind).toBe('failed');
    expect(sessionStates(useAttentionStore.getState())).toHaveLength(1);
    useSessionStore.setState({ activeSessionPath: 'd:/repo/.pi/B.jsonl' });
    syncVisibility();
    expect(sessionStates(useAttentionStore.getState())).toHaveLength(0);
  });
});

describe('sessionAttention goal, pending and lifecycle', () => {
  it('marks blocked from the Goal snapshot and clears it when resumed', () => {
    const bindings = { [sessionControlKey(B)]: 'sid-b' };
    applyGoalState({ bySession: { 'sid-b': goal('active') }, sessionIdByPath: bindings });
    expect(blocked(B)).toBeUndefined();
    applyGoalState({ bySession: { 'sid-b': goal('blocked', '缺少 API Key') }, sessionIdByPath: bindings });
    expect(blocked(B)).toEqual({ message: '缺少 API Key' });
    expect(sessionStateOf(useAttentionStore.getState(), B)?.unread).toMatchObject({ path: B, workspace: WS });
    applyGoalState({ bySession: { 'sid-b': goal('active') }, sessionIdByPath: bindings });
    expect(blocked(B)).toBeUndefined();
  });

  it('does not re-mark blocked after the session was opened while still blocked', () => {
    const bindings = { [sessionControlKey(B)]: 'sid-b' };
    applyGoalState({ bySession: { 'sid-b': goal('blocked', 'x') }, sessionIdByPath: bindings });
    useSessionStore.setState({ activeSessionPath: B });
    syncVisibility();
    useSessionStore.setState({ activeSessionPath: A });
    syncVisibility();
    applyGoalState({ bySession: { 'sid-b': { ...goal('blocked', 'x'), revision: 4 } }, sessionIdByPath: bindings });
    expect(blocked(B)).toBeUndefined();
  });

  it('marks blocked once the session shows up in the list', () => {
    const C = 'D:/repo/.pi/c.jsonl';
    const bindings = { [sessionControlKey(C)]: 'sid-b' };
    applyGoalState({ bySession: { 'sid-b': goal('blocked', 'x') }, sessionIdByPath: bindings });
    expect(blocked(C)).toBeUndefined();
    useSessionStore.setState({ allSessions: [session(A, 'a'), session(B, 'b'), session(C, 'c')] });
    applyGoalState({ bySession: { 'sid-b': goal('blocked', 'x') }, sessionIdByPath: bindings });
    expect(blocked(C)).toEqual({ message: 'x' });
  });

  it('resolves an event spelling to the listed session for opening', () => {
    expect(resolveSessionTarget('D:/other', 'D:\\Repo\\.pi\\B.jsonl')).toEqual({ workspace: WS, path: B });
    expect(resolveSessionTarget('D:/repo', 'D:/repo/.pi/unknown.jsonl')).toEqual({ workspace: 'D:/repo', path: 'D:/repo/.pi/unknown.jsonl' });
  });

  it('derives pending from the request stores', () => {
    useUiPromptStore.getState().setRequest({
      workspace: WS,
      request: { id: 'r1', method: 'confirm', title: '执行 npm publish？' },
      sessionPath: B,
    });
    recomputePending();
    expect(sessionStateOf(useAttentionStore.getState(), B)?.pending).toMatchObject({ kind: 'approval', title: '执行 npm publish？' });
    useUiPromptStore.getState().clear(WS, 'r1');
    recomputePending();
    expect(sessionStateOf(useAttentionStore.getState(), B)).toBeUndefined();
  });

  it('attributes requests without sessionPath to the workspace session', () => {
    useUiPromptStore.getState().setRequest({ workspace: WS, request: { id: 'r1', method: 'confirm' } });
    recomputePending();
    expect(sessionStateOf(useAttentionStore.getState(), A)?.pending?.kind).toBe('approval');
  });

  it('forgets a deleted session', () => {
    end(B, 'error', 'boom');
    end('D:/repo/.pi/c.jsonl', 'stop');
    forgetSessionAttention(B);
    forgetSessionAttention('D:/repo/.pi/c.jsonl');
    vi.advanceTimersByTime(5000);
    expect(useAttentionStore.getState().unread).toEqual({});
  });

  it('lists only visible sessions', () => {
    useSessionStore.setState({
      allSessions: [session(A, 'a'), { ...session(B, 'b'), archived: true }],
      deletedSessionPaths: [],
    });
    expect([...listedSessionKeys()]).toEqual([sessionControlKey(A)]);
  });
});
