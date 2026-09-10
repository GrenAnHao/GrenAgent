import { describe, expect, it, vi } from 'vitest';
import { currentWorkspaceContext } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle } from './workspaceHandle.js';

function makeSession(id: string) {
  const subs: Array<(e: unknown) => void> = [];
  return {
    id,
    sessionId: id,
    subscribe: vi.fn((cb: (e: unknown) => void) => { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; }),
    bindExtensions: vi.fn(async (_bindings: {
      mode: string;
      uiContext: unknown;
      onError: (err: { extensionPath: string; event: string; error: string }) => void;
      commandContextActions: {
        newSession: (options?: unknown) => Promise<{ cancelled: boolean }>;
        fork: unknown;
        switchSession: unknown;
        reload: () => Promise<void>;
      };
    }) => {}),
    prompt: vi.fn(async () => {}) as any,
    abort: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emit: (e: unknown) => subs.forEach((cb) => cb(e)),
    subCount: () => subs.length,
  };
}

function makeRuntime() {
  const first = makeSession('s1');
  const second = makeSession('s2');
  let rebindCb: ((s: unknown) => Promise<void>) | undefined;
  const runtime = {
    session: first as unknown,
    setRebindSession: vi.fn((cb: (s: unknown) => Promise<void>) => { rebindCb = cb; }),
    // 真 finishSessionReplacement 在 apply 新 session 后调 rebindSession——mock 如实模拟
    switchSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    newSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    fork: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false, selectedText: 'x' }; }),
    dispose: vi.fn(async () => {}),
  };
  return { runtime, first, second };
}

function makeHandle(runtime: unknown, over: Record<string, unknown> = {}) {
  const onEvent = vi.fn();
  const onFatal = vi.fn();
  const emit = vi.fn();
  const handle = new WorkspaceHandle({
    workspace: 'D:/proj',
    runtime: runtime as never,
    resolveConfig: async () => ({}),
    emitUiRequest: emit,
    onEvent,
    onFatal,
    ...over,
  });
  return { handle, onEvent, onFatal, emit };
}

describe('WorkspaceHandle', () => {
  it('start：注册 setRebindSession，bindExtensions 全量 + subscribe', async () => {
    const { runtime, first } = makeRuntime();
    const { handle } = makeHandle(runtime);
    await handle.start();
    expect(runtime.setRebindSession).toHaveBeenCalledTimes(1);
    expect(first.bindExtensions).toHaveBeenCalledTimes(1);
    const bindings = first.bindExtensions.mock.calls[0][0];
    expect(bindings.mode).toBe('rpc');
    expect(bindings.uiContext).toBeDefined();
    expect(typeof bindings.onError).toBe('function');
    expect(typeof bindings.commandContextActions.newSession).toBe('function');
    expect(first.subCount()).toBe(1);
  });

  it('构造/切换在 runInWorkspace(main) 内', async () => {
    const { runtime } = makeRuntime();
    const seen: Array<string | undefined> = [];
    const { handle } = makeHandle(runtime, {
      resolveConfig: async () => ({}),
    });
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => {
      seen.push(currentWorkspaceContext()?.origin);
      return { cancelled: false };
    });
    await handle.start();
    await handle.switchSession('/x/other.jsonl');
    expect(seen).toEqual(['main']);
  });

  it('message_update 经降级层剥掉 message', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    first.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '全文' }], usage: { input: 1 } }, assistantMessageEvent: { type: 'text_delta', delta: '文' } });
    const [event, meta] = onEvent.mock.calls[0];
    expect(event).not.toHaveProperty('message');
    expect(event.usage).toEqual({ input: 1 });
    expect(meta).toMatchObject({ sessionId: 's1', source: 'interactive' });
  });

  it('非 message_update 原样转发', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const e = { type: 'queue_update', steering: [], followUp: [] };
    first.emit(e);
    expect(onEvent.mock.calls[0][0]).toEqual(e);
  });

  it('switchSession 后重绑一次（不双 bind）、旧 session 事件不再转发', async () => {
    const { runtime, first, second } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.switchSession('/x/other.jsonl');
    expect(second.bindExtensions).toHaveBeenCalledTimes(1); // rebind 只经 setRebindSession 触发
    expect(first.subCount()).toBe(0);
    expect(second.subCount()).toBe(1);
    onEvent.mockClear();
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).not.toHaveBeenCalled();
    second.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('prompt：preflight(true) 即 resolve，设 origin=main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); return new Promise<void>(() => {}); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await handle.prompt('你好', {}, 'main');
    expect(first.prompt).toHaveBeenCalledTimes(1);
    expect(first.prompt.mock.calls[0][1]).toMatchObject({ source: 'rpc' });
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：preflight(false)+throw → reject', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(false); throw new Error('preflight denied'); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await expect(handle.prompt('x', {}, 'goal')).rejects.toThrow('preflight denied');
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：preflight 成功后回合内错误被吞（不 reject 不致命）', async () => {
    const { runtime, first, onFatal } = { ...makeRuntime(), onFatal: undefined } as never;
    const rt = makeRuntime();
    const first2 = rt.first;
    first2.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); throw new Error('turn crashed'); });
    const h = makeHandle(rt.runtime);
    await h.handle.start();
    await expect(h.handle.prompt('x', {}, 'main')).resolves.toBeUndefined();
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it('agent_end(!willRetry) 后 origin 归位到 main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (b: boolean) => void }) => { opts.preflightResult?.(true); return new Promise<void>(() => {}); });
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.prompt('x', {}, 'goal');
    expect(handle.currentTurnOrigin).toBe('goal');
    first.emit({ type: 'agent_end', willRetry: false });
    expect(handle.currentTurnOrigin).toBe('main');
    expect(onEvent.mock.calls.at(-1)?.[1].source).toBe('goal'); // 该 agent_end 仍标 goal
  });

  it('onError 产出 extension_error 事件', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const bindings = first.bindExtensions.mock.calls[0][0];
    bindings.onError({ extensionPath: '/ext', event: 'tool', error: 'boom' });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension_error', extensionPath: '/ext', error: 'boom' }), expect.anything());
  });

  it('switchSession 失败且 session 未换 → 不 onFatal，仍 rethrow', async () => {
    const { runtime } = makeRuntime();
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => { throw new Error('create failed'); });
    const { handle, onFatal } = makeHandle(runtime);
    await handle.start();
    await expect(handle.switchSession('/x/o.jsonl')).rejects.toThrow('create failed');
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('switchSession 失败且 session 已换 → onFatal 并 rethrow', async () => {
    const { runtime } = makeRuntime();
    (runtime as { switchSession: ReturnType<typeof vi.fn>; session: unknown }).switchSession = vi.fn(async () => {
      (runtime as { session: unknown }).session = { sessionId: 'broken' };
      throw new Error('create failed after teardown');
    });
    const { handle, onFatal } = makeHandle(runtime);
    await handle.start();
    await expect(handle.switchSession('/x/o.jsonl')).rejects.toThrow('create failed after teardown');
    expect(onFatal).toHaveBeenCalledWith(expect.any(Error));
  });

  it('commandContextActions.newSession 走宿主 replace：单次 rebind、main ALS、取消挂起 confirm', async () => {
    const { runtime, first, second } = makeRuntime();
    const seen: Array<string | undefined> = [];
    second.bindExtensions = vi.fn(async () => {
      seen.push(currentWorkspaceContext()?.origin);
    });
    const { handle } = makeHandle(runtime);
    await handle.start();
    const pending = handle.ui.context.confirm('一', '');
    const bindings = first.bindExtensions.mock.calls[0][0];
    await bindings.commandContextActions.newSession();
    expect(second.bindExtensions).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['main']);
    await expect(pending).resolves.toBe(false);
  });

  it('session 替换前取消挂起 UI', async () => {
    const { runtime } = makeRuntime();
    const emit = vi.fn();
    const { handle } = makeHandle(runtime, { emitUiRequest: emit });
    await handle.start();
    const pending = handle.ui.context.confirm('一', '');
    await handle.newSession();
    await expect(pending).resolves.toBe(false);
  });

  it('dispose：abort、取消 UI、停止转发', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    await handle.dispose();
    expect(first.abort).toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
    expect(first.subCount()).toBe(0);
    onEvent.mockClear();
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reload：先 waitForIdle 再 reload，在 runInWorkspace 内', async () => {
    const { runtime, first } = makeRuntime();
    const { handle } = makeHandle(runtime);
    await handle.start();
    await handle.reload();
    expect(first.waitForIdle).toHaveBeenCalled();
    expect(first.reload).toHaveBeenCalled();
    expect(first.waitForIdle.mock.invocationCallOrder[0]).toBeLessThan(first.reload.mock.invocationCallOrder[0]);
  });

  it('降级层抛错不断流', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    first.emit({ type: 'message_update', message: { role: 'user' }, assistantMessageEvent: {} });
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('agent_end');
  });

  it('长消息流式回放总字节 O(n)', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const n = 500;
    let acc = '';
    for (let i = 0; i < n; i++) {
      acc += '词';
      first.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: acc }], usage: { output: i } }, assistantMessageEvent: { type: 'text_delta', delta: '词' } });
    }
    const total = onEvent.mock.calls.reduce((s, [e]) => s + JSON.stringify(e).length, 0);
    expect(onEvent).toHaveBeenCalledTimes(n);
    expect(total).toBeLessThan(n * 200);
    expect(total).toBeLessThan((n * (n + 1)) / 2);
  });
});
