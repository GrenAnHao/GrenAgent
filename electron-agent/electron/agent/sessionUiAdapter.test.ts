import { describe, expect, it, vi } from 'vitest';
import { SessionUiAdapter } from './sessionUiAdapter.js';

function makeAdapter(over: { isGoalTurn?: () => boolean } = {}) {
  const emit = vi.fn();
  const adapter = new SessionUiAdapter({
    workspace: 'D:/proj',
    sessionId: () => 's1',
    isGoalTurn: over.isGoalTurn ?? (() => false),
    emit,
  });
  return { adapter, emit };
}

const EXPECTED_KEYS = [
  'select','confirm','input','notify','onTerminalInput','setStatus','setWorkingMessage','setWorkingVisible',
  'setWorkingIndicator','setHiddenThinkingLabel','setWidget','setFooter','setHeader','setTitle','custom',
  'pasteToEditor','setEditorText','getEditorText','editor','addAutocompleteProvider','setEditorComponent',
  'getEditorComponent','theme','getAllThemes','getTheme','setTheme','getToolsExpanded','setToolsExpanded',
];

describe('SessionUiAdapter', () => {
  it('28 项全部为自有可枚举属性，无 hasUI/mode', () => {
    const { adapter } = makeAdapter();
    const own = Object.keys(adapter.context);
    for (const key of EXPECTED_KEYS) expect(own, key).toContain(key);
    expect(own).toHaveLength(28);
    expect(own).not.toContain('hasUI');
    expect(own).not.toContain('mode');
  });

  it('select 广播线协议字段并在 respond value 后 resolve', async () => {
    const { adapter, emit } = makeAdapter();
    const pending = adapter.context.select('选一个', ['a', 'b']);
    const env = emit.mock.calls[0][0];
    expect(env.workspace).toBe('D:/proj');
    expect(env.sessionId).toBe('s1');
    expect(env.source).toBe('interactive');
    expect(env.request).toMatchObject({ type: 'extension_ui_request', method: 'select', title: '选一个', options: ['a', 'b'] });
    expect(typeof env.request.id).toBe('string');
    adapter.respond(env.request.id, { value: 'b' });
    await expect(pending).resolves.toBe('b');
  });

  it('confirm 用 confirmed；input 带 placeholder；editor 带 prefill 无 timeout', async () => {
    const { adapter, emit } = makeAdapter();
    const c = adapter.context.confirm('标题', '消息', { timeout: 5000 });
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'confirm', title: '标题', message: '消息', timeout: 5000 });
    adapter.respond(emit.mock.calls[0][0].request.id, { confirmed: true });
    await expect(c).resolves.toBe(true);

    emit.mockClear();
    void adapter.context.input('标题', '占位');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'input', title: '标题', placeholder: '占位' });

    emit.mockClear();
    void adapter.context.editor('标题', '预填');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'editor', title: '标题', prefill: '预填' });
    expect(emit.mock.calls[0][0].request).not.toHaveProperty('timeout');
  });

  it('cancelled 回默认值：select→undefined，confirm→false', async () => {
    const { adapter, emit } = makeAdapter();
    const s = adapter.context.select('一', ['x']);
    adapter.respond(emit.mock.calls[0][0].request.id, { cancelled: true });
    await expect(s).resolves.toBeUndefined();
    emit.mockClear();
    const c = adapter.context.confirm('二', '');
    adapter.respond(emit.mock.calls[0][0].request.id, { cancelled: true });
    await expect(c).resolves.toBe(false);
  });

  it('已 aborted 的 signal 立即默认值且不广播', async () => {
    const { adapter, emit } = makeAdapter();
    await expect(adapter.context.select('一', ['x'], { signal: AbortSignal.abort() })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('signal abort 事件 → 默认值', async () => {
    const { adapter } = makeAdapter();
    const ctrl = new AbortController();
    const p = adapter.context.input('一', undefined, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).resolves.toBeUndefined();
  });

  it('timeout → 默认值', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter();
    const p = adapter.context.select('一', ['a'], { timeout: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('cancelAll 把挂起请求标为默认值', async () => {
    const { adapter } = makeAdapter();
    const a = adapter.context.select('一', ['x']);
    const b = adapter.context.confirm('二', '');
    adapter.cancelAll();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe(false);
  });

  it('重复 respond 同一 id 不抛错', () => {
    const { adapter, emit } = makeAdapter();
    void adapter.context.confirm('一', '');
    const id = emit.mock.calls[0][0].request.id;
    adapter.respond(id, { confirmed: true });
    expect(() => adapter.respond(id, { confirmed: false })).not.toThrow();
  });

  it('custom() 返回 Promise<undefined>', async () => {
    const { adapter } = makeAdapter();
    const r = adapter.context.custom(() => ({}) as never);
    expect(r).toBeInstanceOf(Promise);
    await expect(r).resolves.toBeUndefined();
  });

  it('notify/setStatus/setTitle/setEditorText 走通知信封（无挂起请求）', () => {
    const { adapter, emit } = makeAdapter();
    adapter.context.notify('提示', 'warning');
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'notify', message: '提示', notifyType: 'warning' });
    adapter.context.setStatus('k', 't');
    expect(emit.mock.calls[1][0].request).toMatchObject({ method: 'setStatus', statusKey: 'k', statusText: 't' });
    adapter.context.setTitle('标题');
    expect(emit.mock.calls[2][0].request).toMatchObject({ method: 'setTitle', title: '标题' });
    adapter.context.setEditorText('文本');
    expect(emit.mock.calls[3][0].request).toMatchObject({ method: 'set_editor_text', text: '文本' });
  });

  it('setWidget 数组走线协议，factory 被忽略', () => {
    const { adapter, emit } = makeAdapter();
    adapter.context.setWidget('k', ['l1', 'l2'], { placement: 'belowEditor' });
    expect(emit.mock.calls[0][0].request).toMatchObject({ method: 'setWidget', widgetKey: 'k', widgetLines: ['l1', 'l2'], widgetPlacement: 'belowEditor' });
    emit.mockClear();
    adapter.context.setWidget('k', (() => ({})) as never);
    expect(emit).not.toHaveBeenCalled();
  });

  it('getEditorText 返回空串；no-op 方法不抛', () => {
    const { adapter } = makeAdapter();
    expect(adapter.context.getEditorText()).toBe('');
    expect(adapter.context.getToolsExpanded()).toBe(false);
    expect(adapter.context.getEditorComponent()).toBeUndefined();
    expect(adapter.context.getAllThemes()).toEqual([]);
    expect(() => adapter.context.setWorkingMessage('x')).not.toThrow();
    expect(adapter.context.onTerminalInput(() => undefined)()).toBeUndefined();
  });

  it('Goal 回合：对话不广播、立即默认值；通知丢弃', async () => {
    const { adapter, emit } = makeAdapter({ isGoalTurn: () => true });
    await expect(adapter.context.confirm('一', '')).resolves.toBe(false);
    adapter.context.notify('x');
    expect(emit).not.toHaveBeenCalled();
  });

  it('pendingAskUserRequestId 只指向仍在等待的 ask_user', async () => {
    const { adapter } = makeAdapter();
    void adapter.context.input('你的名字');
    expect(adapter.pendingAskUserRequestId()).toBeUndefined();
    const title = JSON.stringify({ __askUser: 1, data: { id: 'q1' } });
    const pending = adapter.context.input(title);
    const id = adapter.pendingAskUserRequestId();
    expect(typeof id).toBe('string');
    adapter.respond(id!, { value: '[我的选择]\n1. 问题：甲' });
    await expect(pending).resolves.toBe('[我的选择]\n1. 问题：甲');
    expect(adapter.pendingAskUserRequestId()).toBeUndefined();
  });
});
