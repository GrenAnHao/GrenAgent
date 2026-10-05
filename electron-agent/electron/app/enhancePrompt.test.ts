import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEnhancePrompt,
  createResultTagEmitter,
  ENHANCE_TEMPERATURE,
  ENHANCE_TOP_P,
  ENHANCE_SAMPLING_PARAMS,
  MAX_ENHANCE_CHARS,
  DEFAULT_ENHANCE_SYSTEM,
  PROJECT_ENHANCE_SYSTEM,
  buildEnhanceSystemPrompt,
  buildDraftUserMessage,
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

  it('剥掉整段包裹引号', () => {
    expect(sanitizeEnhanceOutput('"请分析这段代码"')).toEqual({ ok: true, content: '请分析这段代码' });
    expect(sanitizeEnhanceOutput('“请分析这段代码”')).toEqual({ ok: true, content: '请分析这段代码' });
  });

  it('只取〈改写稿〉标签内的内容，标签外的改动说明被丢弃', () => {
    const raw = '〈改写稿〉\n深度分析当前项目：先摸结构，再逐层深入。\n〈/改写稿〉\n\n改动点：把草稿拆成了三段……';
    expect(sanitizeEnhanceOutput(raw)).toEqual({ ok: true, content: '深度分析当前项目：先摸结构，再逐层深入。' });
  });

  it('不守标签契约但用「改写后的提示词」标题+围栏时，取第一个围栏块', () => {
    const raw = [
      '**改写后的提示词**',
      '```markdown',
      '请对这个仓库做一次结构化分析。',
      '【硬性要求】每个结论附 file:line 证据。',
      '```',
      '',
      '**改动点**',
      '| 草稿 | 问题 | 改后 |',
      '**轻量变体**（只想快速摸底时）',
      '```markdown',
      '用 400 字以内讲清这个项目。',
      '```',
    ].join('\n');
    expect(sanitizeEnhanceOutput(raw)).toEqual({
      ok: true,
      content: '请对这个仓库做一次结构化分析。\n【硬性要求】每个结论附 file:line 证据。',
    });
  });

  it('改写稿正文自带围栏但无引导标题时，不误判为外壳', () => {
    const raw = '先做：\n```ts\nconst x = 1;\n```\n然后提交';
    expect(sanitizeEnhanceOutput(raw)).toEqual({ ok: true, content: raw });
  });

  it('裸正文后尾随「主要改动：」解说时，从该行起整体截断', () => {
    const raw = [
      '你在当前仓库中做一次工程层面的项目分析，不是泛泛介绍。',
      '先读代码再下结论：从 src/ 开始梳理目录结构。',
      '按以下维度输出：',
      '1. 项目定位与运行方式',
      '2. 架构与模块地图',
      '',
      '主要改动：原句缺三样东西——读什么、按什么维度拆、输出要什么形态。',
      '把 <入口文件> 换成你的实际值；如果只想快速摸底，删掉第 3 条即可。',
    ].join('\n');
    expect(sanitizeEnhanceOutput(raw)).toEqual({
      ok: true,
      content: [
        '你在当前仓库中做一次工程层面的项目分析，不是泛泛介绍。',
        '先读代码再下结论：从 src/ 开始梳理目录结构。',
        '按以下维度输出：',
        '1. 项目定位与运行方式',
        '2. 架构与模块地图',
      ].join('\n'),
    });
  });

  it('正文里合法出现「改动路径」等词时不误截断', () => {
    const raw = '分析这个仓库。\n上手建议：新人先读入口文件；最常见的三类改动路径也要列出。';
    expect(sanitizeEnhanceOutput(raw)).toEqual({ ok: true, content: raw });
  });

  it('裸正文后尾随「轻量变体」时从该行起截断', () => {
    const raw = [
      '请对这个仓库做一次结构化分析。',
      '',
      '轻量变体（只想快速摸底时）：用 400 字讲清项目。',
    ].join('\n');
    expect(sanitizeEnhanceOutput(raw)).toEqual({
      ok: true,
      content: '请对这个仓库做一次结构化分析。',
    });
  });
});

describe('createResultTagEmitter（流式预览剥标签）', () => {
  function collect() {
    const out: string[] = [];
    return { out, emitter: createResultTagEmitter((c) => out.push(c)) };
  }

  it('剥掉头尾标签，吞掉闭标签后的解说（标签跨 chunk）', () => {
    const { out, emitter } = collect();
    emitter.push('〈改写稿〉\n第一段');
    emitter.push('第二段〈/改写');
    emitter.push('稿〉\n\n改动点：补了结构和约束。');
    emitter.end();
    expect(out.join('')).toBe('第一段第二段');
  });

  it('无标签的模型输出原样透传、零扣留', () => {
    const { out, emitter } = collect();
    emitter.push('改');
    emitter.push('写稿');
    emitter.end();
    expect(out.join('')).toBe('改写稿');
  });

  it('有开标签但流中断：end 放行扣留的尾部', () => {
    const { out, emitter } = collect();
    emitter.push('〈改写稿〉\n只有正文没闭合');
    emitter.end();
    expect(out.join('')).toBe('只有正文没闭合');
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

describe('buildDraftUserMessage（实质增强，草稿不是任务）', () => {
  it('把草稿放进 USER INPUT，并声明不要执行', () => {
    const msg = buildDraftUserMessage('深度分析一下该项目');
    expect(msg).toContain('USER INPUT:\n深度分析一下该项目');
    expect(msg).toContain('不是给你的任务');
    expect(msg).toContain('请解释这段代码的主要功能、执行流程和关键逻辑');
    expect(msg).toContain('800');
    expect(msg).toContain('不要元评论');
  });

  it('系统提示词要求实质增强，禁止执行、提问与扩成写作课', () => {
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('实质增强');
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('不要回答或执行');
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('不要向用户提问');
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('800');
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('自行探索获取');
    expect(DEFAULT_ENHANCE_SYSTEM).toContain('〈改写稿〉');
    expect(DEFAULT_ENHANCE_SYSTEM).not.toContain('不要新增需求、不要扩大范围');
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
      user: buildDraftUserMessage('帮我改 README'),
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
    expect((streamSimple.mock.calls[0]![0] as { model?: unknown }).model).toBe(other);
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
    expect((streamSimple.mock.calls[0]![0] as { systemPrompt?: string }).systemPrompt).toBe(DEFAULT_ENHANCE_SYSTEM);
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

  it('默认路径固定 temperature / top_p / reasoning=minimal（压低自由发挥与自我解说）', async () => {
    const { service, streamSimple } = setup({ sessionModel: model });
    await service.run({ workspace: '/ws', text: 'x' }, () => {});
    const input = streamSimple.mock.calls[0]![0] as {
      temperature?: number;
      reasoning?: string;
      samplingParams?: Record<string, unknown>;
    };
    expect(input.temperature).toBe(ENHANCE_TEMPERATURE);
    expect(input.reasoning).toBe('minimal');
    expect(input.samplingParams).toEqual({ top_p: ENHANCE_TOP_P });
    expect(ENHANCE_SAMPLING_PARAMS).toEqual({ top_p: ENHANCE_TOP_P });
  });

  it('标签包裹的输出：预览不含标签与改动说明，最终内容只取标签内', async () => {
    async function* tagged() {
      yield { type: 'delta', text: '〈改写稿〉\n深度分析当前项目：' };
      yield { type: 'delta', text: '先摸结构再逐层深入。' };
      yield { type: 'delta', text: '〈/改写稿〉\n\n改动点：补了结构。' };
      yield { type: 'done' };
    }
    const { service } = setup({ sessionModel: model, streamSimple: tagged });
    const chunks: string[] = [];
    await expect(service.run({ workspace: '/ws', text: '深度分析一下该项目' }, (c) => chunks.push(c)))
      .resolves.toEqual({ ok: true, content: '深度分析当前项目：先摸结构再逐层深入。' });
    expect(chunks.join('')).toBe('深度分析当前项目：先摸结构再逐层深入。');
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
    const stream = vi.fn(async function* (model: unknown, context: { tools?: unknown[] }, options?: unknown) {
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

  it('首条 user 消息是 USER INPUT 包裹后的草稿', async () => {
    async function* impl() {
      yield { type: 'delta', text: '改写稿' };
      yield { type: 'done' };
    }
    const { service, stream } = projectSetup(impl);
    await service.run({ workspace: '/ws', text: '深度分析一下该项目' }, () => {});
    const context = stream.mock.calls[0]![1] as { messages: Array<{ content: unknown }> };
    expect(context.messages[0]!.content).toBe(buildDraftUserMessage('深度分析一下该项目'));
    const options = stream.mock.calls[0]![2] as { temperature?: number; samplingParams?: Record<string, unknown> };
    expect(options.temperature).toBe(ENHANCE_TEMPERATURE);
    expect(options.samplingParams).toEqual({ top_p: ENHANCE_TOP_P });
  });

  it('只允许五个只读工具；wiki_replace / codegraph_impact 回错误字符串且不 request', async () => {
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
              { type: 'toolCall', id: '1', name: 'wiki_replace', arguments: { page: 'x' } },
              { type: 'toolCall', id: '2', name: 'codegraph_impact', arguments: { symbol: 'Foo' } },            ],
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
            content: [{ type: 'toolCall', id: '1', name: 'wiki_search', arguments: { query: '登录' } }],
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
              { type: 'toolCall', id: `a${round}`, name: 'memory_search', arguments: { query: 'q' } },
              { type: 'toolCall', id: `b${round}`, name: 'memory_search', arguments: { query: 'q' } },
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
            { type: 'toolCall', id: '1', name: 'memory_search', arguments: { query: 'q' } },
            { type: 'toolCall', id: '2', name: 'memory_search', arguments: { query: 'q' } },
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
            content: [{ type: 'toolCall', id: '1', name: 'wiki_read', arguments: { page: 'p' } }],
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
          content: [{ type: 'toolCall', id: '1', name: 'wiki_search', arguments: { query: 'q' } }],
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
            content: [{ type: 'toolCall', id: '1', name: 'wiki_search', arguments: { query: 'q' } }],
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

  it('codegraph_search 走 codeRetrieval.call', async () => {    const request = vi.fn().mockResolvedValue({ hits: [] });
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

  it('暴露给模型的工具名不含点号，且 wiki_search 映射回 wiki.search', async () => {
    const request = vi.fn().mockResolvedValue([]);
    const toolNames: string[][] = [];
    let round = 0;
    async function* impl(context: { tools?: unknown[] }) {
      toolNames.push((context.tools ?? []).map((tool) => (tool as { name: string }).name));
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki_search', arguments: { query: '登录' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '稿' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {})).resolves.toMatchObject({ ok: true });
    // 网关/上游会拒绝带 `.` 的工具名（实测 400 → 503），所以对外必须是无点号名。
    expect(toolNames[0]!.length).toBeGreaterThan(0);
    for (const name of toolNames.flat()) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(req).toHaveBeenCalledWith('wiki.search', expect.objectContaining({ query: '登录' }));
  });
});

describe('createEnhancePrompt 准备阶段', () => {
  it('读设置挂起时也会超时返回，不会永远停在生成中', async () => {
    vi.useFakeTimers();
    try {
      const streamSimple = vi.fn(async function* () { yield { type: 'done' }; });
      const host = {
        streamSimple,
        ensure: vi.fn(async () => ({ stream: vi.fn(), complete: vi.fn(), getModel: vi.fn(() => model) })),
      };
      const agentHost = { get: () => ({ session: { model } }) };
      const service = createEnhancePrompt({
        host: host as never,
        agentHost: agentHost as never,
        settings: () => new Promise<Record<string, string>>(() => {}),
        agentData: { request: vi.fn() } as never,
      });
      const pending = service.run({ workspace: '/ws', text: 'x' }, () => {});
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({ ok: false, error: '增强超时，请重试' });
      expect(streamSimple).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
