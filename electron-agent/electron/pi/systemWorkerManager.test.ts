import { describe, expect, it, vi } from 'vitest';
import { SystemWorkerManager, serviceTaskRequestForTest } from './systemWorkerManager';

type CompleteInput = { user: string; systemPrompt?: string; signal?: AbortSignal };

function hangUntilAbort(error = 'aborted') {
  return ({ signal }: CompleteInput) => new Promise<string>((_resolve, reject) => {
    const fail = () => reject(new Error(error));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

describe('SystemWorkerManager', () => {
  it('describeModel 返回 provider/id', async () => {
    const manager = new SystemWorkerManager({ describeModel: async () => 'test-provider/test-model', complete: async () => '' });
    await expect(manager.describeModel()).resolves.toBe('test-provider/test-model');
  });

  it('describeModel 失败统一成 MODEL_UNAVAILABLE', async () => {
    const manager = new SystemWorkerManager({ describeModel: async () => { throw new Error('nope'); }, complete: async () => '' });
    await expect(manager.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE');
  });

  it('describeModel 超时后队列仍可用', async () => {
    vi.useFakeTimers();
    try {
      const manager = new SystemWorkerManager({
        describeModel: () => new Promise(() => {}),
        complete: async () => '{"ok":true}',
        taskTimeoutMs: 50,
      });
      const model = manager.describeModel();
      let failure = '';
      void model.catch((error: Error) => { failure = error.message; });
      await vi.advanceTimersByTimeAsync(51);
      expect(failure).toBe('MODEL_UNAVAILABLE');
      await expect(manager.run({ id: 'after-model-timeout', kind: 'content_classify', input: {} })).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('wiki_page_generate 在执行前比对 expectedModel', async () => {
    const complete = vi.fn(async () => '# page');
    const manager = new SystemWorkerManager({
      describeModel: async () => 'openai/gpt-x',
      complete,
    });
    await expect(manager.run({ id: '1', kind: 'wiki_page_generate', input: { expectedModel: 'anthropic/other' } })).rejects.toThrow('MODEL_CHANGED');
    expect(complete).not.toHaveBeenCalled();
  });

  it('expectedModel 一致时才调用 complete，并返回 Markdown 原文', async () => {
    const complete = vi.fn(async (_input: CompleteInput) => '# Generated\n\nBody');
    const manager = new SystemWorkerManager({
      describeModel: async () => 'test/confirmed',
      complete,
    });
    await expect(manager.run({ id: 'confirmed-wiki', kind: 'wiki_page_generate', input: { expectedModel: 'test/confirmed' } })).resolves.toBe('# Generated\n\nBody');
    expect(complete).toHaveBeenCalledOnce();
    const prompt = String(complete.mock.calls[0]![0].user);
    expect(prompt).toContain('Markdown');
    expect(prompt).not.toContain('JSON only');
  });

  it('goal_judge 超时 abort', async () => {
    vi.useFakeTimers();
    try {
      const manager = new SystemWorkerManager({
        describeModel: async () => 'x/y',
        complete: hangUntilAbort(),
        taskTimeoutMs: 20,
      });
      const pending = manager.run({ id: '1', kind: 'goal_judge', input: {} });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).rejects.toThrow('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('任务串行：第二个 complete 在第一个结束后才调用', async () => {
    const order: string[] = [];
    let release!: () => void;
    const manager = new SystemWorkerManager({
      describeModel: async () => 'x/y',
      complete: async ({ user }) => {
        if (user.includes('first')) {
          order.push('first');
          await new Promise<void>((r) => { release = r; });
          return '{"ok":true}';
        }
        order.push('second');
        return '{"ok":true}';
      },
    });
    const a = manager.run({ id: 'a', kind: 'content_classify', input: { tag: 'first' } });
    const b = manager.run({ id: 'b', kind: 'content_classify', input: { tag: 'second' } });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    release();
    await a;
    await b;
    expect(order).toEqual(['first', 'second']);
  });

  it('describeModel 与 run 共享同一条队列', async () => {
    const order: string[] = [];
    let release!: () => void;
    const manager = new SystemWorkerManager({
      describeModel: async () => {
        order.push('describe');
        await new Promise<void>((r) => { release = r; });
        return 'x/y';
      },
      complete: async () => {
        order.push('complete');
        return '{"ok":true}';
      },
    });
    const model = manager.describeModel();
    const task = manager.run({ id: 'after-describe', kind: 'content_classify', input: {} });
    await Promise.resolve();
    expect(order).toEqual(['describe']);
    release();
    await expect(model).resolves.toBe('x/y');
    await expect(task).resolves.toEqual({ ok: true });
    expect(order).toEqual(['describe', 'complete']);
  });

  it('混合 kind 串行，前一个结果不能完成后一个任务', async () => {
    const order: string[] = [];
    let release!: () => void;
    const manager = new SystemWorkerManager({
      describeModel: async () => 'x/y',
      complete: async ({ user }) => {
        if (user.includes('content_classify')) {
          order.push('classify');
          await new Promise<void>((r) => { release = r; });
          return '{"classification":"fact"}';
        }
        order.push('wiki');
        return '# Wiki';
      },
    });
    const classify = manager.run({ id: 'classify', kind: 'content_classify', input: {} });
    const wiki = manager.run({ id: 'wiki', kind: 'wiki_page_generate', input: {} });
    await Promise.resolve();
    expect(order).toEqual(['classify']);
    release();
    await expect(classify).resolves.toEqual({ classification: 'fact' });
    await expect(wiki).resolves.toBe('# Wiki');
    expect(order).toEqual(['classify', 'wiki']);
  });

  it('run 在解析前把模型原文交给 hooks.onRawOutput，解析失败也一样', async () => {
    const onRawOutput = vi.fn();
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete: async () => 'not json at all' });
    await expect(manager.run({ id: 'r', kind: 'goal_judge', input: {} }, { onRawOutput })).rejects.toThrow('invalid JSON');
    expect(onRawOutput).toHaveBeenCalledExactlyOnceWith('not json at all');
  });

  it('其余 kind 的 Input 段保持原样', () => {
    const input = { memories: [{ content: 'x' }], currentTimestamp: 't', maxScenes: 15, delta: 'keep', background: 'keep' };
    for (const kind of ['thread_title_generate', 'goal_judge']) {
      const { user } = serviceTaskRequestForTest({ id: 'k', kind, input });
      expect(user.endsWith(`\nInput: ${JSON.stringify(input)}`)).toBe(true);
    }
  });

  it('run 把 hooks.onUsage 交给 complete', async () => {
    const onUsage = vi.fn();
    const complete = vi.fn(async (input: CompleteInput & { onUsage?: (r: { usage: unknown }) => void }) => {
      input.onUsage?.({ usage: { input: 3 } });
      return '{"ok":true}';
    });
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete });
    await expect(manager.run({ id: 'u', kind: 'goal_judge', input: {} }, { onUsage })).resolves.toEqual({ ok: true });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ usage: { input: 3 } });
  });

  it('非法 JSON 失败，可按 maxAttempts 重试', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('{"ok":true}');
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete, maxAttempts: 2 });
    await expect(manager.run({ id: 'a', kind: 'content_classify', input: {} })).resolves.toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(manager.taskState('a')).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('超过 maxAttempts 后标记 failed', async () => {
    const manager = new SystemWorkerManager({
      describeModel: async () => 'x/y',
      complete: async () => { throw new Error('boom'); },
      maxAttempts: 2,
    });
    await expect(manager.run({ id: 'a', kind: 'content_classify', input: {} })).rejects.toThrow('boom');
    expect(manager.taskState('a')).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('同一 task id 再次 run 会重新获得一轮 attempt 预算', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('{"ok":true}');
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete });
    const task = { id: 'same-id', kind: 'content_classify', input: {} };
    await expect(manager.run(task)).rejects.toThrow('temporary failure');
    await expect(manager.run(task)).resolves.toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('close 后进行中与排队任务都失败，且不再调用 complete', async () => {
    const complete = vi.fn(() => new Promise<string>(() => {}));
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete });
    const first = manager.run({ id: 'a', kind: 'content_classify', input: { tag: 'a' } });
    const second = manager.run({ id: 'b', kind: 'content_classify', input: { tag: 'b' } });
    await Promise.resolve();
    manager.close();
    await expect(first).rejects.toThrow('system worker is closed');
    await expect(second).rejects.toThrow('system worker is closed');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('close 会中断进行中的 complete', async () => {
    const manager = new SystemWorkerManager({
      describeModel: async () => 'x/y',
      complete: hangUntilAbort('system worker is closed'),
    });
    const running = manager.run({ id: 'a', kind: 'content_classify', input: {} });
    await Promise.resolve();
    manager.close();
    await expect(running).rejects.toThrow('system worker is closed');
  });
});
