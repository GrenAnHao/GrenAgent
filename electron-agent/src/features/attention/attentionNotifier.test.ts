import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttentionNotifier, diffAttention, type NotifierDeps } from './attentionNotifier';
import { resetSessionAttentionForTest, useAttentionStore, type AttentionStoreState } from '../../stores/sessionAttention';
import { sessionControlKey } from '../../stores/modeStore';
import { useSessionStore } from '../../store/session';
import type { UnreadEntry } from '../../stores/attentionView';
import type { PendingEntry } from '../../stores/attentionPending';

const WS = 'D:/repo';
const A = 'D:/repo/.pi/a.jsonl';
const B = 'D:/repo/.pi/b.jsonl';
const C = 'D:/repo/.pi/c.jsonl';
const keyOf = sessionControlKey;

const base = (): AttentionStoreState => ({ unread: {}, pending: {}, focused: true });
const failed = (path: string, seq = 1, message = 'boom'): UnreadEntry => ({ path, workspace: WS, outcome: { kind: 'failed', message, seq } });
const approval = (path: string, title = '执行 npm publish？'): PendingEntry => ({ path, workspace: WS, kind: 'approval', title });

function setUnread(path: string, entry: UnreadEntry | undefined) {
  useAttentionStore.setState((s) => {
    const unread = { ...s.unread };
    if (entry) unread[keyOf(path)] = entry;
    else delete unread[keyOf(path)];
    return { unread };
  });
}
function setPending(path: string, entry: PendingEntry | undefined) {
  useAttentionStore.setState((s) => {
    const pending = { ...s.pending };
    if (entry) pending[keyOf(path)] = entry;
    else delete pending[keyOf(path)];
    return { pending };
  });
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDeps(route: 'off' | 'in-app' | 'os' = 'in-app', sound = true) {
  const deps = {
    notify: vi.fn().mockResolvedValue({ route, sound }),
    badge: vi.fn().mockResolvedValue(undefined),
    drawOverlay: vi.fn((count: number) => `data:overlay-${count}`),
    toast: { open: vi.fn(), destroy: vi.fn() },
    chime: vi.fn(),
    clear: vi.fn(),
    openSession: vi.fn(),
    titleOf: vi.fn((path: string) => (path === B ? '重构订单页' : '会话')),
    listedKeys: vi.fn(() => new Set([keyOf(A), keyOf(B), keyOf(C)])),
  } satisfies NotifierDeps;
  return deps;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  useSessionStore.setState({ activeSessionPath: A });
  useAttentionStore.setState({ focused: true, visibleKey: keyOf(A) });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  resetSessionAttentionForTest();
});

describe('diffAttention', () => {
  it('opens one transition per new state', () => {
    const next: AttentionStoreState = {
      ...base(),
      pending: { [keyOf(A)]: approval(A) },
      unread: { [keyOf(B)]: failed(B), [keyOf(C)]: { path: C, workspace: WS, blocked: { message: '缺 Key' } } },
    };
    const { opened } = diffAttention(base(), next);
    expect(opened).toEqual(
      expect.arrayContaining([
        { key: keyOf(A), path: A, workspace: WS, kind: 'approval', body: '执行 npm publish？' },
        { key: keyOf(B), path: B, workspace: WS, kind: 'failed', body: 'boom' },
        { key: keyOf(C), path: C, workspace: WS, kind: 'blocked', body: '缺 Key' },
      ]),
    );
    expect(opened).toHaveLength(3);
    expect(diffAttention(next, next).opened).toEqual([]);
  });

  it('truncates long error bodies at 200 chars', () => {
    const long = 'x'.repeat(250);
    const [t] = diffAttention(base(), { ...base(), unread: { [keyOf(B)]: failed(B, 1, long) } }).opened;
    expect(t.body).toBe(`${'x'.repeat(200)}…`);
  });

  it('opens again when the outcome sequence grows', () => {
    const prev = { ...base(), unread: { [keyOf(B)]: failed(B, 1) } };
    const next = { ...base(), unread: { [keyOf(B)]: failed(B, 2, 'again') } };
    expect(diffAttention(prev, next).opened).toEqual([{ key: keyOf(B), path: B, workspace: WS, kind: 'failed', body: 'again' }]);
  });

  it('uses fallback bodies', () => {
    const next: AttentionStoreState = {
      ...base(),
      pending: { [keyOf(A)]: { path: A, workspace: WS, kind: 'choice' } },
      unread: { [keyOf(B)]: { path: B, workspace: WS, outcome: { kind: 'done', seq: 1 } } },
    };
    const bodies = Object.fromEntries(diffAttention(base(), next).opened.map((t) => [t.kind, t.body]));
    expect(bodies).toEqual({ choice: '有问题等你回答', done: '这一轮已经跑完' });
  });

  it('clears toasts when states go away or the session becomes visible', () => {
    const prev: AttentionStoreState = {
      ...base(),
      pending: { [keyOf(A)]: approval(A) },
      unread: { [keyOf(B)]: { ...failed(B), blocked: {} } },
    };
    const gone = diffAttention(prev, base()).cleared;
    expect(gone).toEqual(
      expect.arrayContaining([
        { key: keyOf(A), kinds: ['approval', 'choice'] },
        { key: keyOf(B), kinds: ['blocked'] },
        { key: keyOf(B), kinds: ['failed', 'done'] },
      ]),
    );
    const visible = diffAttention(base(), { ...base(), visibleKey: keyOf(C) }).cleared;
    expect(visible).toEqual([{ key: keyOf(C), kinds: ['approval', 'choice', 'failed', 'blocked', 'done'] }]);
  });
});

describe('createAttentionNotifier', () => {
  it('skips the visible session', async () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    setPending(A, approval(A));
    await flush();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('shows an in-app toast with go and chime when routed in-app', async () => {
    const deps = makeDeps('in-app', true);
    stop = createAttentionNotifier(deps).stop;
    setUnread(B, failed(B));
    await flush();
    expect(deps.notify).toHaveBeenCalledWith({ kind: 'failed', workspace: WS, sessionPath: B, title: '重构订单页 · 失败', body: 'boom' });
    expect(deps.toast.open).toHaveBeenCalledWith(
      expect.objectContaining({ key: `attention:${keyOf(B)}`, kind: 'failed', title: '重构订单页 · 失败', body: 'boom', autoClose: true }),
    );
    expect(deps.chime).toHaveBeenCalledOnce();
    deps.toast.open.mock.calls[0][0].onGo();
    expect(deps.toast.destroy).toHaveBeenCalledWith(`attention:${keyOf(B)}`);
    expect(deps.openSession).toHaveBeenCalledWith(WS, B);
  });

  it('does not chime when sound is off', async () => {
    const deps = makeDeps('in-app', false);
    stop = createAttentionNotifier(deps).stop;
    setUnread(B, failed(B));
    await flush();
    expect(deps.toast.open).toHaveBeenCalled();
    expect(deps.chime).not.toHaveBeenCalled();
  });

  it('does nothing on route off or os', async () => {
    for (const route of ['off', 'os'] as const) {
      const deps = makeDeps(route);
      stop?.();
      resetSessionAttentionForTest();
      useAttentionStore.setState({ focused: true, visibleKey: keyOf(A) });
      stop = createAttentionNotifier(deps).stop;
      setUnread(B, failed(B));
      await flush();
      expect(deps.notify).toHaveBeenCalledOnce();
      expect(deps.toast.open).not.toHaveBeenCalled();
      expect(deps.chime).not.toHaveBeenCalled();
    }
  });

  it('uses one toast key per session', async () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    setUnread(B, failed(B, 1));
    await flush();
    setUnread(B, failed(B, 2));
    await flush();
    setUnread(C, failed(C, 1));
    await flush();
    const keys = deps.toast.open.mock.calls.map(([cfg]) => cfg.key);
    expect(keys).toEqual([`attention:${keyOf(B)}`, `attention:${keyOf(B)}`, `attention:${keyOf(C)}`]);
  });

  it('keeps approval toasts open and destroys them when answered', async () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    setPending(B, approval(B));
    await flush();
    expect(deps.toast.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval', autoClose: false, title: '重构订单页 · 等待批准' }));
    setPending(B, undefined);
    expect(deps.toast.destroy).toHaveBeenCalledWith(`attention:${keyOf(B)}`);
  });

  it('closes the toast when the session is opened', async () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    setPending(B, approval(B));
    await flush();
    useAttentionStore.setState({ visibleKey: keyOf(B) });
    expect(deps.toast.destroy).toHaveBeenCalledWith(`attention:${keyOf(B)}`);
  });

  it('drops a toast whose state cleared while the main process was answering', async () => {
    const deps = makeDeps();
    let release!: (v: unknown) => void;
    deps.notify.mockReturnValueOnce(new Promise((r) => (release = r)));
    stop = createAttentionNotifier(deps).stop;
    setPending(B, approval(B));
    setPending(B, undefined);
    release({ route: 'in-app', sound: true });
    await flush();
    expect(deps.toast.open).not.toHaveBeenCalled();
    expect(deps.chime).not.toHaveBeenCalled();
  });

  it('clears the OS notification of a session when its state goes away', async () => {
    const deps = makeDeps('os');
    stop = createAttentionNotifier(deps).stop;
    setPending(B, approval(B));
    await flush();
    setPending(B, undefined);
    expect(deps.clear).toHaveBeenCalledWith(B);
    deps.clear.mockClear();
    setPending(B, undefined);
    expect(deps.clear).not.toHaveBeenCalled();
  });

  it('clears the OS notification when the session is opened', async () => {
    const deps = makeDeps('os');
    stop = createAttentionNotifier(deps).stop;
    setUnread(B, failed(B));
    await flush();
    useAttentionStore.setState({ visibleKey: keyOf(B) });
    expect(deps.clear).toHaveBeenCalledWith(B);
  });

  it('clears a stale overlay on start after a renderer reload', () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    expect(deps.badge.mock.calls).toEqual([[0, undefined]]);
  });

  it('syncs the taskbar count with an overlay', async () => {
    const deps = makeDeps();
    stop = createAttentionNotifier(deps).stop;
    deps.badge.mockClear();
    setPending(B, approval(B));
    setUnread(C, failed(C));
    setUnread(C, { path: C, workspace: WS, outcome: { kind: 'done', seq: 2 } });
    setUnread(C, { path: C, workspace: WS, outcome: { kind: 'done', seq: 3 } });
    setPending(B, undefined);
    expect(deps.badge.mock.calls).toEqual([
      [1, 'data:overlay-1'],
      [2, 'data:overlay-2'],
      [1, 'data:overlay-1'],
      [0, undefined],
    ]);
  });

  it('counts only listed sessions', async () => {
    const deps = makeDeps();
    deps.listedKeys.mockReturnValue(new Set([keyOf(A)]));
    stop = createAttentionNotifier(deps).stop;
    deps.badge.mockClear();
    setUnread(C, failed(C));
    expect(deps.badge).not.toHaveBeenCalled();
  });

  it('stops listening after stop()', async () => {
    const deps = makeDeps();
    createAttentionNotifier(deps).stop();
    deps.badge.mockClear();
    setUnread(B, failed(B));
    await flush();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.badge).not.toHaveBeenCalled();
  });
});
