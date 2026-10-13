import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentWorkspaceContext } from '../../../extensions/_shared/workspace-context.js';
import { drainByParent } from '../../../extensions/multi-agent/activation.js';
import {
  emitCatalogChanged,
  __resetCatalogChangeSinksForTest,
} from '../../../extensions/multi-agent/catalog-events.js';
import {
  emitEmbeddedSubagentEvent,
  __resetEmbeddedSubagentEventSinksForTest,
} from '../../../extensions/multi-agent/embedded-events.js';
import { lookupParentHost, __resetParentHostsForTest } from '../../../extensions/multi-agent/parent-host.js';
import { WorkspaceHandle } from './workspaceHandle.js';

vi.mock('../../../extensions/multi-agent/activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../extensions/multi-agent/activation.js')>();
  return { ...actual, drainByParent: vi.fn(async () => {}) };
});

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
  let invalidateCb: (() => void) | undefined;
  const runtime = {
    session: first as unknown,
    setRebindSession: vi.fn((cb: (s: unknown) => Promise<void>) => { rebindCb = cb; }),
    setBeforeSessionInvalidate: vi.fn((cb?: () => void) => { invalidateCb = cb; }),
    // 真 finishSessionReplacement 在 apply 新 session 后调 rebindSession——mock 如实模拟
    switchSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    newSession: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false }; }),
    fork: vi.fn(async () => { runtime.session = second; await rebindCb?.(second); return { cancelled: false, selectedText: 'x' }; }),
    dispose: vi.fn(async () => {}),
  };
  return { runtime, first, second, invalidate: () => { invalidateCb?.(); } };
}

function makeHandle(runtime: unknown, over: Record<string, unknown> = {}) {
  const onEvent = vi.fn();
  const onFatal = vi.fn();
  const emit = vi.fn();
  const handle = new WorkspaceHandle({
    workspace: 'D:/proj',
    cwd: 'D:/proj',
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
  // 很多用例 start 后不 dispose；模块级 sink 表会留着旧 handle，并按“第一个认领”吞掉子会话事件。
  beforeEach(() => {
    __resetEmbeddedSubagentEventSinksForTest();
  });

  it('start：注册 setRebindSession，bindExtensions 全量 + subscribe', async () => {
    const { runtime, first } = makeRuntime();
    const { handle } = makeHandle(runtime);
    await handle.start();
    expect(runtime.setRebindSession).toHaveBeenCalledTimes(1);
    expect(runtime.setBeforeSessionInvalidate).toHaveBeenCalledTimes(1);
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

  it('ctx 使用 options.cwd 而非 workspace', async () => {
    const { runtime } = makeRuntime();
    const seen: Array<string | undefined> = [];
    const { handle } = makeHandle(runtime, {
      workspace: 'D:/ws',
      cwd: 'D:/resolved',
    });
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => {
      seen.push(currentWorkspaceContext()?.cwd);
      return { cancelled: false };
    });
    await handle.start();
    await handle.switchSession('/x/other.jsonl');
    expect(seen).toEqual(['D:/resolved']);
  });

  it('推给界面这一步抛错（例如 agent-host 和主进程断开）不抛回 SDK，只记一次日志', async () => {
    const { runtime, first } = makeRuntime();
    const onEvent = vi.fn(() => {
      throw new Error('AGENT_HOST_DISCONNECTED');
    });
    const { handle } = makeHandle(runtime, { onEvent });
    await handle.start();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const update = { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '文' }] }, assistantMessageEvent: { type: 'text_delta', delta: '文' } };
      expect(() => first.emit(update)).not.toThrow();
      expect(() => first.emit({ type: 'agent_end', messages: [] })).not.toThrow();
      expect(onEvent).toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toBe('[session-listener] main session events failed; swallowed so the session keeps going');
    } finally {
      log.mockRestore();
    }
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

  it('连续 toolcall_delta 后紧跟 agent_end，先发合并 delta', async () => {
    const { runtime, first } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    const partial = { content: [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: {} }] };
    const base = { role: 'assistant', usage: { output: 1 }, content: partial.content };
    first.emit({
      type: 'message_update',
      message: base,
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"pa', partial },
    });
    first.emit({
      type: 'message_update',
      message: { ...base, usage: { output: 2 } },
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'th"', partial },
    });
    first.emit({ type: 'agent_end', willRetry: false });
    expect(onEvent.mock.calls.map(([event]) => event.assistantMessageEvent?.delta ?? event.type)).toEqual(['{"path"', 'agent_end']);
    expect(onEvent.mock.calls[0][0].assistantMessageEvent).toMatchObject({ id: 'call_1', toolName: 'write' });
    expect(onEvent.mock.calls[0][0]).not.toHaveProperty('message');
  });

  it('forwards embedded child events with sessionPath and source=subagent', async () => {
    const { runtime } = makeRuntime();
    const { handle, onEvent } = makeHandle(runtime);
    await handle.start();
    emitEmbeddedSubagentEvent(
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { sessionId: 'sa-1', sessionPath: '/tmp/child.jsonl', workspace: 'D:/proj' },
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message_end' }),
      { sessionId: 'sa-1', sessionPath: '/tmp/child.jsonl', source: 'subagent' },
    );
    await handle.dispose();
  });

  it('同一项目多个 handle 同时在线时，子会话事件只广播一次', async () => {
    const foreground = makeHandle(makeRuntime().runtime);
    const docked = makeHandle(makeRuntime().runtime);
    const docked2 = makeHandle(makeRuntime().runtime);
    await foreground.handle.start();
    await docked.handle.start();
    await docked2.handle.start();
    // 增量会先合并再发，这里只关心认领，用会立即转发的事件。
    const delta = { type: 'message_end', message: { role: 'assistant', content: [] } };
    const meta = { sessionId: 'sa-1', sessionPath: '/tmp/child.jsonl', workspace: 'D:/proj' };
    emitEmbeddedSubagentEvent(delta, meta);
    const total = () => foreground.onEvent.mock.calls.length + docked.onEvent.mock.calls.length + docked2.onEvent.mock.calls.length;
    expect(total()).toBe(1);

    // 认领的 handle 被淘汰后，下一个顶上，仍然只发一次。
    await foreground.handle.dispose();
    emitEmbeddedSubagentEvent(delta, meta);
    expect(total()).toBe(2);
    expect(docked.onEvent.mock.calls.length + docked2.onEvent.mock.calls.length).toBe(1);
    await docked.handle.dispose();
    await docked2.handle.dispose();
  });

  it('子会话的文字 / 思考增量按会话合并后再发，其它事件到来或会话结束时先冲掉', async () => {
    const { handle, onEvent } = makeHandle(makeRuntime().runtime);
    await handle.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const a = { sessionId: 'sa-1', sessionPath: '/tmp/a.jsonl', workspace: 'D:/proj' };
      const b = { sessionId: 'sa-2', sessionPath: '/tmp/b.jsonl', workspace: 'D:/proj' };
      const think = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta } });
      const text = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta } });
      emitEmbeddedSubagentEvent(think('Wal'), a);
      emitEmbeddedSubagentEvent(think('king'), b);
      emitEmbeddedSubagentEvent(think('king'), a);
      // 另一个子会话的增量不打断这一个的合并
      expect(onEvent).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      const deltas = () => onEvent.mock.calls.map(([event, meta]) => `${meta.sessionPath}:${event.assistantMessageEvent?.type ?? event.type}:${event.assistantMessageEvent?.delta ?? ''}`);
      expect(deltas()).toEqual(['/tmp/a.jsonl:thinking_delta:Walking', '/tmp/b.jsonl:thinking_delta:king']);

      onEvent.mockClear();
      emitEmbeddedSubagentEvent(text('hel'), a);
      emitEmbeddedSubagentEvent(text('lo'), a);
      emitEmbeddedSubagentEvent({ type: 'agent_end', messages: [] }, a);
      // 结束事件之前先冲掉挂起的增量，顺序不变
      expect(deltas()).toEqual(['/tmp/a.jsonl:text_delta:hello', '/tmp/a.jsonl:agent_end:']);
      expect(onEvent.mock.calls[0][1]).toEqual({ sessionId: 'sa-1', sessionPath: '/tmp/a.jsonl', source: 'subagent' });
    } finally {
      vi.useRealTimers();
    }
    await handle.dispose();
  });

  it('handle 拆掉时把子会话挂起的增量冲掉，不丢最后几个字', async () => {
    const { handle, onEvent } = makeHandle(makeRuntime().runtime);
    await handle.start();
    emitEmbeddedSubagentEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tail' } },
      { sessionId: 'sa-1', sessionPath: '/tmp/a.jsonl', workspace: 'D:/proj' },
    );
    expect(onEvent).not.toHaveBeenCalled();
    await handle.dispose();
    expect(onEvent.mock.calls.map(([event]) => event.assistantMessageEvent?.delta)).toEqual(['tail']);
  });

  it('别的项目的子会话事件不会被认领，也不挡住本项目的 handle', async () => {
    const other = makeHandle(makeRuntime().runtime, { workspace: 'D:/other', cwd: 'D:/other' });
    const mine = makeHandle(makeRuntime().runtime);
    await other.handle.start();
    await mine.handle.start();
    emitEmbeddedSubagentEvent(
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { sessionId: 'sa-1', sessionPath: '/tmp/child.jsonl', workspace: 'D:/proj' },
    );
    expect(other.onEvent).not.toHaveBeenCalled();
    expect(mine.onEvent).toHaveBeenCalledTimes(1);
    await other.handle.dispose();
    await mine.handle.dispose();
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

  it('prompt：含空格的技能名在交给 pi 之前展开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-skill-'));
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '---\nname: IDA Pro逆向分析\n---\n\n# body\n');
    try {
      const { runtime, first } = makeRuntime();
      (first as { resourceLoader?: unknown }).resourceLoader = {
        getSkills: () => ({
          skills: [{ name: 'IDA Pro逆向分析', filePath: file, baseDir: dir }],
        }),
      };
      first.prompt = vi.fn(async (_text: string, opts: { preflightResult?: (disposition: unknown) => void }) => {
        opts.preflightResult?.("started");
      });
      const { handle } = makeHandle(runtime);
      await handle.start();
      await handle.prompt('/skill:"IDA Pro逆向分析" 我', {}, 'main');
      const sent = first.prompt.mock.calls[0][0] as string;
      expect(sent).toContain('name="IDA Pro逆向分析"');
      expect(sent).toContain('# body');
      expect(sent.endsWith('\n\n我')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prompt：preflight(true) 即 resolve，设 origin=main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void }) => { opts.preflightResult?.("started"); return new Promise<void>(() => {}); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await handle.prompt('你好', {}, 'main');
    expect(first.prompt).toHaveBeenCalledTimes(1);
    expect(first.prompt.mock.calls[0][1]).toMatchObject({ source: 'rpc' });
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：preflight 未接受且 throw → reject', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async () => { throw new Error('preflight denied'); });
    const { handle } = makeHandle(runtime);
    await handle.start();
    await expect(handle.prompt('x', {}, 'goal')).rejects.toThrow('preflight denied');
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：无 preflightResult 且 resolve → reject prompt not accepted', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async () => {});
    const { handle } = makeHandle(runtime);
    await handle.start();
    await expect(handle.prompt('x', {}, 'goal')).rejects.toThrow('prompt not accepted');
    expect(handle.currentTurnOrigin).toBe('main');
  });

  it('prompt：preflight 成功后回合内错误被吞（不 reject 不致命）', async () => {
    const { runtime, first, onFatal } = { ...makeRuntime(), onFatal: undefined } as never;
    const rt = makeRuntime();
    const first2 = rt.first;
    first2.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void }) => { opts.preflightResult?.("started"); throw new Error('turn crashed'); });
    const h = makeHandle(rt.runtime);
    await h.handle.start();
    await expect(h.handle.prompt('x', {}, 'main')).resolves.toBeUndefined();
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it('agent_end(!willRetry) 后 origin 归位到 main', async () => {
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void }) => { opts.preflightResult?.("started"); return new Promise<void>(() => {}); });
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

  it('switchSession：已 invalidate 但 session 引用未换 → onFatal 并 rethrow', async () => {
    const { runtime, invalidate } = makeRuntime();
    (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => {
      invalidate();
      throw new Error('create failed after invalidate');
    });
    const { handle, onFatal } = makeHandle(runtime);
    await handle.start();
    await expect(handle.switchSession('/x/o.jsonl')).rejects.toThrow('create failed after invalidate');
    expect(onFatal).toHaveBeenCalledWith(expect.any(Error), handle);
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
    expect(onFatal).toHaveBeenCalledWith(expect.any(Error), handle);
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

  it('getState 把 session.model 的 getter 拍成可 IPC 的纯对象', () => {
    const { runtime, first } = makeRuntime();
    Object.assign(first, {
      model: {
        get id() { return 'claude'; },
        get provider() { return 'anthropic'; },
        get name() { return 'Claude'; },
        get api() { return 'anthropic-messages'; },
        get reasoning() { return true; },
        get thinkingLevelMap() { return { low: 'low', medium: 'medium', high: 'high' }; },
        think() { return 'side-effect'; },
      },
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: false,
      followUpMode: false,
      sessionFile: '/s.jsonl',
      sessionName: '',
      autoCompactionEnabled: true,
      messages: [],
      pendingMessageCount: 0,
    });
    const { handle } = makeHandle(runtime);
    const state = handle.getState();
    expect(state.model).toEqual({
      id: 'claude',
      provider: 'anthropic',
      name: 'Claude',
      api: 'anthropic-messages',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
    });
    expect(state.model).not.toHaveProperty('think');
  });

  it('dispose 调用 onDispose(workspace, cwd)', async () => {
    const onDispose = vi.fn();
    const { handle } = makeHandle(makeRuntime().runtime, { cwd: 'D:/resolved', onDispose });
    await handle.dispose();
    expect(onDispose).toHaveBeenCalledWith('D:/proj', 'D:/resolved');
  });

  it('prompt 的 ALS cwd 是 options.cwd', async () => {
    const seen: string[] = [];
    const { runtime, first } = makeRuntime();
    first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void }) => {
      seen.push(currentWorkspaceContext()?.cwd ?? '');
      opts.preflightResult?.("started");
    });
    const { handle } = makeHandle(runtime, { cwd: 'D:/resolved' });
    await handle.start();
    await handle.prompt('hi', {}, 'main');
    expect(seen).toEqual(['D:/resolved']);
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

  describe('parent host', () => {
    const sessionPath = '/ws/s1.jsonl';

    beforeEach(() => {
      __resetParentHostsForTest();
      vi.mocked(drainByParent).mockReset();
      vi.mocked(drainByParent).mockImplementation(async () => {});
    });

    afterEach(() => {
      __resetParentHostsForTest();
    });

    function attachParentFields(session: ReturnType<typeof makeSession>, file = sessionPath) {
      Object.assign(session, {
        sessionFile: file,
        sendCustomMessage: vi.fn(async () => {}),
        isStreaming: false,
      });
    }

    it('start 之后 lookupParentHost 有值', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      const { handle } = makeHandle(runtime);
      await handle.start();
      const host = lookupParentHost(sessionPath, 'D:/proj');
      expect(host).toBeDefined();
      expect(host?.sessionId).toBe('s1');
      expect(host?.workspace).toBe('D:/proj');
      await handle.dispose();
    });

    it('dispose 之后 lookup 为空，且 drainByParent 在注销前调用', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      vi.mocked(drainByParent).mockImplementation(async () => {
        const host = lookupParentHost(sessionPath, 'D:/proj');
        expect(host).toBeDefined();
        expect(host?.isDraining()).toBe(true);
      });
      const { handle } = makeHandle(runtime);
      await handle.start();
      await handle.dispose();
      expect(drainByParent).toHaveBeenCalledWith(sessionPath);
      expect(lookupParentHost(sessionPath, 'D:/proj')).toBeUndefined();
    });

    it('host.sendMessage 调用当前 session.sendCustomMessage', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      const { handle } = makeHandle(runtime);
      await handle.start();
      const host = lookupParentHost(sessionPath, 'D:/proj');
      const msg = { customType: 'subagent-settled', content: 'done', display: true, details: {} };
      const opts = { triggerTurn: true, deliverAs: 'followUp' as const };
      host!.sendMessage(msg, opts);
      expect((first as { sendCustomMessage: ReturnType<typeof vi.fn> }).sendCustomMessage).toHaveBeenCalledWith(msg, opts);
      await handle.dispose();
    });

    it('host.prompt followUp 且未 streaming 不带 streamingBehavior，origin 为 main', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      const seen: Array<string | undefined> = [];
      let resolvePrompt!: () => void;
      const prompted = new Promise<void>((resolve) => { resolvePrompt = resolve; });
      first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void; streamingBehavior?: string }) => {
        seen.push(currentWorkspaceContext()?.origin);
        opts.preflightResult?.("started");
        resolvePrompt();
      });
      const { handle } = makeHandle(runtime);
      await handle.start();
      lookupParentHost(sessionPath, 'D:/proj')!.prompt('hi', 'followUp');
      await prompted;
      expect(first.prompt).toHaveBeenCalledTimes(1);
      expect(first.prompt.mock.calls[0][0]).toBe('hi');
      expect(first.prompt.mock.calls[0][1].streamingBehavior).toBeUndefined();
      expect(seen).toEqual(['main']);
      await handle.dispose();
    });

    it('host.prompt steer 且 streaming 时带 streamingBehavior', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      first.isStreaming = true;
      let resolvePrompt!: () => void;
      const prompted = new Promise<void>((resolve) => { resolvePrompt = resolve; });
      first.prompt = vi.fn(async (_t: string, opts: { preflightResult?: (disposition: unknown) => void; streamingBehavior?: string }) => {
        opts.preflightResult?.("started");
        resolvePrompt();
      });
      const { handle } = makeHandle(runtime);
      await handle.start();
      lookupParentHost(sessionPath, 'D:/proj')!.prompt('hi', 'steer');
      await prompted;
      expect(first.prompt.mock.calls[0][1]).toMatchObject({ streamingBehavior: 'steer' });
      await handle.dispose();
    });

    it('switchSession 成功换会话后才 drain 旧 path，再注册新 host', async () => {
      const nextPath = '/ws/s2.jsonl';
      const { runtime, first, second } = makeRuntime();
      attachParentFields(first, sessionPath);
      attachParentFields(second, nextPath);
      const notice = { customType: 'subagent-settled', content: 'aborted', display: true, details: {} };
      const noticeOpts = { triggerTurn: false as const };
      vi.mocked(drainByParent).mockImplementation(async (path) => {
        expect(path).toBe(sessionPath);
        expect(runtime.switchSession).toHaveBeenCalled();
        const host = lookupParentHost(sessionPath, 'D:/proj');
        expect(host).toBeDefined();
        expect(host?.isDraining()).toBe(true);
        host!.sendMessage(notice, noticeOpts);
        expect((first as { sendCustomMessage: ReturnType<typeof vi.fn> }).sendCustomMessage).toHaveBeenCalledWith(notice, noticeOpts);
        expect((second as { sendCustomMessage: ReturnType<typeof vi.fn> }).sendCustomMessage).not.toHaveBeenCalled();
      });
      const { handle } = makeHandle(runtime);
      await handle.start();
      await handle.switchSession(nextPath);
      expect(runtime.switchSession.mock.invocationCallOrder[0]).toBeLessThan(drainByParent.mock.invocationCallOrder[0]);
      expect(drainByParent).toHaveBeenCalledWith(sessionPath);
      expect(lookupParentHost(sessionPath, 'D:/proj')).toBeUndefined();
      const next = lookupParentHost(nextPath, 'D:/proj');
      expect(next).toBeDefined();
      expect(next?.sessionId).toBe('s2');
      vi.mocked(drainByParent).mockImplementation(async () => {});
      await handle.dispose();
    });

    it('switchSession 失败且 session 未换时不 drain、host 仍在', async () => {
      const { runtime, first } = makeRuntime();
      attachParentFields(first);
      (runtime as { switchSession: ReturnType<typeof vi.fn> }).switchSession = vi.fn(async () => { throw new Error('create failed'); });
      const { handle, onFatal } = makeHandle(runtime);
      await handle.start();
      await expect(handle.switchSession('/x/o.jsonl')).rejects.toThrow('create failed');
      expect(drainByParent).not.toHaveBeenCalled();
      expect(lookupParentHost(sessionPath, 'D:/proj')).toBeDefined();
      expect(onFatal).not.toHaveBeenCalled();
    });

    it('switchSession 已换后 throw：onFatal dispose 后不挂回 host', async () => {
      const nextPath = '/ws/s2.jsonl';
      const { runtime, first, second } = makeRuntime();
      attachParentFields(first, sessionPath);
      attachParentFields(second, nextPath);
      (runtime as { switchSession: ReturnType<typeof vi.fn>; session: unknown }).switchSession = vi.fn(async () => {
        (runtime as { session: unknown }).session = second;
        throw new Error('create failed after teardown');
      });
      const { handle, onFatal } = makeHandle(runtime);
      onFatal.mockImplementation(() => { void handle.dispose(); });
      await handle.start();
      await expect(handle.switchSession(nextPath)).rejects.toThrow('create failed after teardown');
      expect(onFatal).toHaveBeenCalled();
      expect(lookupParentHost(sessionPath, 'D:/proj')).toBeUndefined();
      expect(lookupParentHost(nextPath, 'D:/proj')).toBeUndefined();
    });
  });

  describe('catalog change sink', () => {
    afterEach(() => {
      __resetCatalogChangeSinksForTest();
    });

    it('start 后 emit 当前 sessionFile 会按 interactive 转发', async () => {
      const { runtime, first } = makeRuntime();
      Object.assign(first, { sessionFile: '/parent.jsonl' });
      const { handle, onEvent } = makeHandle(runtime);
      await handle.start();
      onEvent.mockClear();
      emitCatalogChanged({ sessionPath: '/parent.jsonl' });
      expect(onEvent).toHaveBeenCalledWith(
        { type: 'subagent_catalog_changed', sessionPath: '/parent.jsonl' },
        expect.objectContaining({ source: 'interactive', sessionPath: '/parent.jsonl' }),
      );
      await handle.dispose();
    });

    it('子路径 catalog 变更也转发（页头展开行要热更新）', async () => {
      const { runtime, first } = makeRuntime();
      Object.assign(first, { sessionFile: '/parent.jsonl' });
      const { handle, onEvent } = makeHandle(runtime);
      await handle.start();
      onEvent.mockClear();
      emitCatalogChanged({ sessionPath: '/child.jsonl' });
      expect(onEvent).toHaveBeenCalledWith(
        { type: 'subagent_catalog_changed', sessionPath: '/child.jsonl' },
        expect.objectContaining({ source: 'interactive', sessionPath: '/child.jsonl' }),
      );
      await handle.dispose();
    });

    it('dispose 后不再转发', async () => {
      const { runtime, first } = makeRuntime();
      Object.assign(first, { sessionFile: '/parent.jsonl' });
      const { handle, onEvent } = makeHandle(runtime);
      await handle.start();
      await handle.dispose();
      onEvent.mockClear();
      emitCatalogChanged({ sessionPath: '/parent.jsonl' });
      expect(onEvent).not.toHaveBeenCalled();
    });
  });
});
