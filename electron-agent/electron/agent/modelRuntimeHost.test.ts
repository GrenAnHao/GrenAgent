import { describe, expect, it, vi } from 'vitest';
import { ModelRuntimeHost } from './modelRuntimeHost.js';

const stubRuntime = () => ({ getAvailableSnapshot: () => [], refresh: vi.fn(async () => ({})) });

describe('ModelRuntimeHost', () => {
  it('ensure() 只创建一次', async () => {
    const create = vi.fn().mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('并发 ensure() 不重复创建', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const create = vi.fn().mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const host = new ModelRuntimeHost({ create });
    const pending = Promise.all([host.ensure(), host.ensure(), host.ensure()]);
    resolveCreate(stubRuntime());
    const [a, b, c] = await pending;
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('创建失败后下次 ensure() 重试', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('auth failed')).mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    await expect(host.ensure()).rejects.toThrow('auth failed');
    await expect(host.ensure()).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refresh() 原地刷新，不丢弃实例', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    await host.refresh();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('refresh() 未 ensure 时先 ensure 再刷新', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    await host.refresh();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });
});

const model = { provider: 'openai', id: 'gpt-x', name: 'GPT-X' } as never;

describe('ModelRuntimeHost 短调用', () => {
  it('completeSimple 传 Model 对象与 messages，文本取 content[]', async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '模型回答' }],
    });
    const create = vi.fn().mockResolvedValue({
      completeSimple,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.completeSimple({ user: '问题' })).resolves.toBe('模型回答');
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: [expect.objectContaining({ role: 'user', content: '问题' })],
      }),
      expect.objectContaining({ signal: undefined }),
    );
  });

  it('completeSimple 把 signal 透传到第三参', async () => {
    const signal = new AbortController().signal;
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => model, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await host.completeSimple({ user: 'q', signal });
    expect(completeSimple.mock.calls[0][2]).toEqual({ signal });
  });

  it('describeModel 返回 provider/id，不是 displayName', async () => {
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.describeModel()).resolves.toBe('openai/gpt-x');
  });

  it('settings 模型无鉴权时回退快照第一项', async () => {
    const fallback = { provider: 'anthropic', id: 'claude', name: 'Claude' } as never;
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [fallback],
      getModel: () => undefined,
      hasConfiguredAuth: () => false,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'missing' }) });
    await expect(host.describeModel()).resolves.toBe('anthropic/claude');
  });

  it('没有任何模型时 describeModel 抛 MODEL_UNAVAILABLE', async () => {
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
      hasConfiguredAuth: () => false,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'x', modelId: 'y' }) });
    await expect(host.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE');
  });

  it('completeSimple 接受 provider+modelId 并 getModel', async () => {
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const getModel = vi.fn((_p: string, _id: string) => model);
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'other', modelId: 'nope' }) });
    await expect(host.completeSimple({ user: 'q', provider: 'openai', modelId: 'gpt-x' })).resolves.toBe('ok');
    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-x');
    expect(completeSimple.mock.calls[0][0]).toBe(model);
  });

  it('completeSimple 在文本校验前回报用量：空内容失败的那次也记账', async () => {
    const usage = { input: 120, output: 0, cacheRead: 16_000, cacheWrite: 0 };
    const completeSimple = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage })
      .mockResolvedValueOnce({ content: [{ type: 'thinking', thinking: '...' }], stopReason: 'stop', usage });
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => model, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    const onUsage = vi.fn();
    await expect(host.completeSimple({ user: 'q', onUsage })).resolves.toBe('ok');
    await expect(host.completeSimple({ user: 'q', onUsage })).rejects.toThrow('empty content (stopReason=stop, blocks=thinking)');
    expect(onUsage.mock.calls).toEqual([[{ model: 'openai/gpt-x', usage }], [{ model: 'openai/gpt-x', usage }]]);
    expect(completeSimple.mock.calls[0][2]).toEqual({ signal: undefined });
  });

  it('completeSimple 把 provider 报错原样抛出，onUsage 抛错不影响结果', async () => {
    const completeSimple = vi.fn().mockResolvedValue({ content: [], stopReason: 'error', errorMessage: '400 context length exceeded' });
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => model, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.completeSimple({ user: 'q', onUsage: () => { throw new Error('ledger down'); } })).rejects.toThrow('400 context length exceeded');
  });

  it('provider+modelId 未命中时抛 模型不可用，不回退默认', async () => {
    const completeSimple = vi.fn();
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => undefined, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.completeSimple({ user: 'q', provider: 'gone', modelId: 'x' })).rejects.toThrow('模型不可用');
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it('streamSimple 条件透传 temperature / reasoning / samplingParams', async () => {
    async function* streamSimple() {
      yield { type: 'done', message: { usage: {} } };
    }
    const inner = vi.fn((_model?: unknown, _context?: unknown, _options?: unknown) => streamSimple());
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      streamSimple: inner,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    for await (const _ of host.streamSimple({
      user: 'q',
      temperature: 0.3,
      reasoning: 'minimal',
      samplingParams: { top_p: 0.85 },
    })) { /* drain */ }
    expect(inner.mock.calls[0][2]).toEqual({
      signal: undefined,
      temperature: 0.3,
      reasoning: 'minimal',
      samplingParams: { top_p: 0.85 },
    });
  });

  it('streamSimple 把 signal 透传到第三参并映射 text_delta', async () => {
    const signal = new AbortController().signal;
    async function* streamSimple() {
      yield { type: 'text_delta', delta: '你好' };
      yield { type: 'done', message: { usage: { totalTokens: 1 } } };
    }
    const inner = vi.fn((_model?: unknown, _context?: unknown, _options?: unknown) => streamSimple());
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      streamSimple: inner,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    const events: Array<{ type: string; text?: string }> = [];
    for await (const ev of host.streamSimple({ user: 'q', signal })) events.push(ev);
    expect(events).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'done', usage: { totalTokens: 1 } },
    ]);
    expect(inner.mock.calls[0][2]).toEqual({ signal });
  });
});
