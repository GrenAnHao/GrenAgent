import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUiPromptStore } from './uiPromptStore';

const select = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, method: 'select', title: id, options: ['允许本次', '拒绝'], ...extra }) as never;

const head = (ws = '/ws') => useUiPromptStore.getState().byWorkspace[ws]?.request.id;
const waiting = (ws = '/ws') => (useUiPromptStore.getState().waiting[ws] ?? []).map((i) => i.request.id);

afterEach(() => {
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
  vi.useRealTimers();
});

describe('uiPromptStore queue', () => {
  it('shows the first request and queues the rest instead of overwriting', () => {
    const { setRequest } = useUiPromptStore.getState();
    setRequest({ workspace: '/ws', request: select('a') });
    setRequest({ workspace: '/ws', request: select('b') });
    setRequest({ workspace: '/ws', request: select('c') });
    setRequest({ workspace: '/other', request: select('x') });

    expect(head()).toBe('a');
    expect(waiting()).toEqual(['b', 'c']);
    expect(head('/other')).toBe('x');
  });

  it('answering the shown request brings up the next one; clearing a queued one leaves the head alone', () => {
    const { setRequest, clear } = useUiPromptStore.getState();
    setRequest({ workspace: '/ws', request: select('a') });
    setRequest({ workspace: '/ws', request: select('b') });
    setRequest({ workspace: '/ws', request: select('c') });

    clear('/ws', 'b');
    expect(head()).toBe('a');
    expect(waiting()).toEqual(['c']);
    clear('/ws', 'a');
    expect(head()).toBe('c');
    expect(waiting()).toEqual([]);
    clear('/ws', 'gone');
    expect(head()).toBe('c');
    clear('/ws');
    expect(head()).toBeUndefined();
  });

  it('the same id again replaces in place and keeps its position', () => {
    const { setRequest } = useUiPromptStore.getState();
    setRequest({ workspace: '/ws', request: select('a') });
    setRequest({ workspace: '/ws', request: select('b') });
    setRequest({ workspace: '/ws', request: select('b', { title: 'again' }) });
    expect(waiting()).toEqual(['b']);
    expect(useUiPromptStore.getState().waiting['/ws']?.[0].request.title).toBe('again');
  });

  it('stamps receivedAt once so a countdown survives being parked and restored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    useUiPromptStore.getState().setRequest({ workspace: '/ws', request: select('a') });
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.receivedAt).toBe(1000);
    vi.setSystemTime(5000);
    useUiPromptStore.getState().setRequest({ workspace: '/ws', request: select('b'), receivedAt: 2000 });
    expect(useUiPromptStore.getState().waiting['/ws']?.[0].receivedAt).toBe(2000);
  });

  it('dismiss removes a request wherever it is, in any workspace', () => {
    const { setRequest, dismiss } = useUiPromptStore.getState();
    setRequest({ workspace: '/ws', request: select('a') });
    setRequest({ workspace: '/ws', request: select('b') });
    setRequest({ workspace: '/other', request: select('x') });

    dismiss('b');
    expect(waiting()).toEqual([]);
    dismiss('a');
    expect(head()).toBeUndefined();
    dismiss('x');
    expect(head('/other')).toBeUndefined();
    const before = useUiPromptStore.getState();
    dismiss('unknown');
    expect(useUiPromptStore.getState()).toBe(before);
  });

  it('takeWhere removes matching requests in order and promotes what is left', () => {
    const { setRequest, takeWhere } = useUiPromptStore.getState();
    setRequest({ workspace: '/ws', request: select('a'), sessionPath: '/ws/1.jsonl' });
    setRequest({ workspace: '/ws', request: select('b'), sessionPath: '/ws/2.jsonl' });
    setRequest({ workspace: '/ws', request: select('c'), sessionPath: '/ws/1.jsonl' });

    const taken = useUiPromptStore.getState().takeWhere('/ws', (i) => i.sessionPath === '/ws/1.jsonl');
    expect(taken.map((i) => i.request.id)).toEqual(['a', 'c']);
    expect(head()).toBe('b');
    expect(waiting()).toEqual([]);
    expect(takeWhere('/ws', () => false)).toEqual([]);
  });
});
