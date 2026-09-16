import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEnhancePrompt,
  MAX_ENHANCE_CHARS,
  DEFAULT_ENHANCE_SYSTEM,
  PROJECT_ENHANCE_SYSTEM,
  buildEnhanceSystemPrompt,
  sanitizeEnhanceOutput,
} from './enhancePrompt.js';

describe('sanitizeEnhanceOutput', () => {
  it('剥掉整段围栏', () => {
    expect(sanitizeEnhanceOutput('```\nhello\n```')).toEqual({ ok: true, content: 'hello' });
    expect(sanitizeEnhanceOutput('```markdown\nhello\n```')).toEqual({ ok: true, content: 'hello' });
  });

  it('保留中间代码块', () => {
    const raw = '先做：\n```ts\nconst x = 1;\n```\n然后提交';
    expect(sanitizeEnhanceOutput(raw)).toEqual({ ok: true, content: raw });
  });

  it('剥完为空失败', () => {
    expect(sanitizeEnhanceOutput('```\n  \n```')).toEqual({ ok: false, error: '模型返回为空' });
    expect(sanitizeEnhanceOutput('   ')).toEqual({ ok: false, error: '模型返回为空' });
  });
});

describe('buildEnhanceSystemPrompt', () => {
  it('关实验只用默认文案', () => {
    expect(buildEnhanceSystemPrompt({ useProjectContext: false, goalText: '状态: active\n条件: 完成' })).toBe(DEFAULT_ENHANCE_SYSTEM);
  });

  it('开实验时用 \\n\\n 拼接，缺 Goal 写「无」', () => {
    expect(buildEnhanceSystemPrompt({ useProjectContext: true, goalText: '' })).toBe(
      `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}无`,
    );
    expect(buildEnhanceSystemPrompt({ useProjectContext: true, goalText: '状态: active\n条件: 完工' })).toBe(
      `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}状态: active\n条件: 完工`,
    );
  });
});

const model = { provider: 'openai', id: 'gpt-x' };

function setup(options?: {
  settings?: Record<string, string>;
  sessionModel?: { provider: string; id: string } | null;
  getModel?: (provider: string, id: string) => unknown;
  streamSimple?: (input: unknown) => AsyncGenerator<unknown>;
}) {
  async function* defaultStream() {
    yield { type: 'delta', text: '改' };
    yield { type: 'delta', text: '写稿' };
    yield { type: 'done' };
  }
  const streamSimple = vi.fn(options?.streamSimple ?? defaultStream);
  const stream = vi.fn(async function* () { /* 实验才用 */ });
  const complete = vi.fn();
  const getModel = vi.fn(options?.getModel ?? ((provider: string, id: string) => (
    provider === model.provider && id === model.id ? model : undefined
  )));
  const host = {
    streamSimple,
    ensure: vi.fn(async () => ({ stream, complete, getModel })),
  };
  const agentHost = {
    get: vi.fn(() => options?.sessionModel ? { session: { model: options.sessionModel }, getState: () => ({ model: options.sessionModel }) } : undefined),
  };
  const agentData = { request: vi.fn() };
  const service = createEnhancePrompt({
    host: host as never,
    agentHost: agentHost as never,
    settings: async () => options?.settings ?? {},
    agentData: agentData as never,
  });
  return { service, streamSimple, stream, complete, getModel, agentData };
}

describe('createEnhancePrompt 默认路径', () => {
  afterEach(() => vi.useRealTimers());

  it('留空设置 → 用会话模型的 provider/id 再 getModel', async () => {
    const { service, streamSimple, getModel } = setup({ sessionModel: { provider: 'openai', id: 'gpt-x' } });
    const chunks: string[] = [];
    await expect(service.run({ workspace: '/ws', text: '帮我改 README' }, (c) => chunks.push(c)))
      .resolves.toEqual({ ok: true, content: '改写稿' });
    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-x');
    expect(streamSimple.mock.calls[0][0]).toMatchObject({
      user: '帮我改 README',
      model,
    });
    expect(chunks).toEqual(['改', '写稿']);
  });

  it('有设置且 getModel 命中 → 用设置，不回退会话', async () => {
    const other = { provider: 'anthropic', id: 'claude' };
    const { service, streamSimple } = setup({
      settings: { enhancePromptModel: 'anthropic/claude' },
      sessionModel: { provider: 'openai', id: 'gpt-x' },
      getModel: (p, id) => (p === 'anthropic' && id === 'claude' ? other : undefined),
    });
    await service.run({ workspace: '/ws', text: 'x' }, () => {});
    expect(streamSimple.mock.calls[0][0].model).toBe(other);
  });

  it('有设置但未命中 → 失败不回退', async () => {
    const { service, streamSimple } = setup({
      settings: { enhancePromptModel: 'gone/x' },
      sessionModel: { provider: 'openai', id: 'gpt-x' },
    });
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {}))
      .resolves.toMatchObject({ ok: false, error: '增强提示词模型不可用，请在设置中重选或留空' });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('超长拒绝', async () => {
    const { service, streamSimple } = setup({ sessionModel: model });
    await expect(service.run({ workspace: '/ws', text: '汉'.repeat(MAX_ENHANCE_CHARS + 1) }, () => {}))
      .resolves.toMatchObject({ ok: false, error: '正文过长，请缩短后再增强' });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('开关关不调 stream/complete，忽略 goalText', async () => {
    const { service, stream, complete, streamSimple } = setup({
      settings: { enhancePromptUseProjectContext: '0' },
      sessionModel: model,
    });
    await service.run({ workspace: '/ws', text: 'x', goalText: '状态: active\n条件: 完工' }, () => {});
    expect(stream).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(streamSimple.mock.calls[0][0].systemPrompt).toBe(DEFAULT_ENHANCE_SYSTEM);
  });

  it('abort 后不把后续 delta 当成功', async () => {
    let yieldNext: () => void = () => {};
    async function* hanging() {
      yield { type: 'delta', text: 'a' };
      await new Promise<void>((resolve) => { yieldNext = resolve; });
      yield { type: 'delta', text: 'b' };
      yield { type: 'done' };
    }
    const { service } = setup({ sessionModel: model, streamSimple: hanging });
    const chunks: string[] = [];
    const pending = service.run({ workspace: '/ws', text: 'x' }, (c) => chunks.push(c));
    // 不要只 await Promise.resolve()——run() 里先 await settings()，一个 tick 不够，abort 会早于首包。
    await vi.waitFor(() => expect(chunks).toEqual(['a']));
    service.abort('/ws');
    yieldNext();
    await expect(pending).resolves.toMatchObject({ cancelled: true, ok: false });
    expect(chunks).toEqual(['a']);
  });

  it('超时返回增强超时，请重试', async () => {
    vi.useFakeTimers();
    async function* hang() {
      await new Promise(() => {});
    }
    const { service } = setup({ sessionModel: model, streamSimple: hang });
    const pending = service.run({ workspace: '/ws', text: 'x' }, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: '增强超时，请重试' });
  });
});

describe('createEnhancePrompt 实验路径', () => {
  function projectSetup(streamImpl: (context: { tools?: unknown[] }) => AsyncGenerator<unknown>, request = vi.fn()) {
    const stream = vi.fn(async function* (model: unknown, context: { tools?: unknown[] }) {
      yield* streamImpl(context);
    });
    const getModel = vi.fn(() => model);
    const host = {
      streamSimple: vi.fn(async function* () { yield { type: 'done' }; }),
      ensure: vi.fn(async () => ({ stream, complete: vi.fn(), getModel })),
    };
    const service = createEnhancePrompt({
      host: host as never,
      agentHost: { get: () => ({ session: { model }, getState: () => ({ model }) }) } as never,
      settings: async () => ({ enhancePromptUseProjectContext: '1' }),
      agentData: { request } as never,
    });
    return { service, stream, request, streamSimple: host.streamSimple };
  }

  it('只允许五个只读工具；wiki.replace / codegraph_impact 回错误字符串且不 request', async () => {
    const request = vi.fn();
    let round = 0;
    async function* impl() {
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: '1', name: 'wiki.replace', arguments: { page: 'x' } },
              { type: 'toolCall', id: '2', name: 'codegraph_impact', arguments: { symbol: 'Foo' } },
            ],
            stopReason: 'toolUse',
          },
        };
        return;
      }
      yield {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: '改写稿' }], reason: 'stop' },
      };
    }
    const { service, request: req } = projectSetup(impl, request);
    const chunks: string[] = [];
    await expect(service.run({ workspace: '/ws', text: '修登录' }, (c) => chunks.push(c)))
      .resolves.toEqual({ ok: true, content: '改写稿' });
    expect(req).not.toHaveBeenCalled();
    expect(chunks).toEqual(['改写稿']);
  });

  it('wiki.search 空结果仍能改写', async () => {
    const request = vi.fn().mockResolvedValue([]);
    let round = 0;
    async function* impl() {
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki.search', arguments: { query: '登录' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '贴合项目的改写' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '贴合项目的改写' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: '修登录' }, () => {}))
      .resolves.toEqual({ ok: true, content: '贴合项目的改写' });
    expect(req).toHaveBeenCalledWith('wiki.search', expect.objectContaining({ workspace: '/ws', query: '登录' }));
  });

  it('第 9 次工具调用被拒绝；超过 4 轮不再带 tools', async () => {
    const request = vi.fn().mockResolvedValue('ok');
    const toolSets: number[] = [];
    let round = 0;
    async function* impl(context: { tools?: unknown[] }) {
      toolSets.push(context.tools?.length ?? 0);
      round += 1;
      if ((context.tools?.length ?? 0) > 0) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: `a${round}`, name: 'memory.search', arguments: { query: 'q' } },
              { type: 'toolCall', id: `b${round}`, name: 'memory.search', arguments: { query: 'q' } },
            ],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '终稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '终稿' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {})).resolves.toMatchObject({ ok: true, content: '终稿' });
    expect(req).toHaveBeenCalledTimes(8);
    expect(toolSets.some((n) => n === 0)).toBe(true);
  });

  it('tools 已空仍只回 toolCall 时结束且不再 request', async () => {
    const request = vi.fn().mockResolvedValue('ok');
    async function* impl() {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: '1', name: 'memory.search', arguments: { query: 'q' } },
            { type: 'toolCall', id: '2', name: 'memory.search', arguments: { query: 'q' } },
          ],
          reason: 'toolUse',
        },
      };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {}))
      .resolves.toMatchObject({ ok: false, error: '模型返回为空' });
    expect(req).toHaveBeenCalledTimes(8);
  });

  it('单次工具结果超过 4000 字被截断', async () => {
    const request = vi.fn().mockResolvedValue('字'.repeat(5000));
    const resultLens: number[] = [];
    let round = 0;
    const stream = vi.fn(async function* (_model: unknown, context: { messages: Array<{ role?: string; content?: Array<{ text?: string }> }> }) {
      for (const msg of context.messages) {
        if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
          resultLens.push(msg.content[0]?.text?.length ?? 0);
        }
      }
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki.read', arguments: { page: 'p' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '稿' }], reason: 'stop' } };
    });
    const host = {
      streamSimple: vi.fn(async function* () { yield { type: 'done' }; }),
      ensure: vi.fn(async () => ({ stream, complete: vi.fn(), getModel: vi.fn(() => model) })),
    };
    const service = createEnhancePrompt({
      host: host as never,
      agentHost: { get: () => ({ session: { model }, getState: () => ({ model }) }) } as never,
      settings: async () => ({ enhancePromptUseProjectContext: '1' }),
      agentData: { request } as never,
    });
    await service.run({ workspace: '/ws', text: 'x' }, () => {});
    expect(resultLens).toContain(4000);
  });

  it('工具执行挂起时 abort 返回 cancelled', async () => {
    const request = vi.fn(() => new Promise(() => {}));
    async function* impl() {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: '1', name: 'wiki.search', arguments: { query: 'q' } }],
          reason: 'toolUse',
        },
      };
    }
    const { service, request: req } = projectSetup(impl, request);
    const pending = service.run({ workspace: '/ws', text: 'x' }, () => {});
    await vi.waitFor(() => expect(req).toHaveBeenCalled());
    service.abort('/ws');
    await expect(pending).resolves.toMatchObject({ cancelled: true, ok: false });
  });

  it('工具执行挂起时超时返回增强超时，请重试', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(() => new Promise(() => {}));
      async function* impl() {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki.search', arguments: { query: 'q' } }],
            reason: 'toolUse',
          },
        };
      }
      const { service, request: req } = projectSetup(impl, request);
      const pending = service.run({ workspace: '/ws', text: 'x' }, () => {});
      for (let i = 0; i < 30 && req.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(req).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toMatchObject({ ok: false, error: '增强超时，请重试' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('codegraph_search 走 codeRetrieval.call', async () => {
    const request = vi.fn().mockResolvedValue({ hits: [] });
    let round = 0;
    async function* impl() {
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'codegraph_search', arguments: { query: 'Login' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '稿' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {})).resolves.toMatchObject({ ok: true, content: '稿' });
    expect(req).toHaveBeenCalledWith('codeRetrieval.call', expect.objectContaining({
      workspace: '/ws',
      tool: 'codegraph_search',
      args: expect.objectContaining({ query: 'Login' }),
    }));
  });
});
