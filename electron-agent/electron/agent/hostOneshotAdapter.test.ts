import { describe, expect, it, vi } from 'vitest';
import { runHostOneshot } from './hostOneshotAdapter.js';

function hostStub(overrides: Record<string, unknown> = {}) {
  return {
    completeSimple: vi.fn().mockResolvedValue('fixed'),
    streamSimple: vi.fn(async function* () {
      yield { type: 'delta' as const, text: 'he' };
      yield { type: 'delta' as const, text: 'llo' };
      yield { type: 'done' as const, usage: { total_tokens: 3 } };
    }),
    ...overrides,
  };
}

describe('runHostOneshot', () => {
  it('非流式成功 emit { ok, content }，system 映到 systemPrompt，signal 传到 Host', async () => {
    const signal = new AbortController().signal;
    const host = hostStub();
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'openai', modelId: 'gpt-x', user: 'hi', system: 'sys',
    }, (line) => lines.push(JSON.parse(line)), signal);
    expect(host.completeSimple).toHaveBeenCalledWith({
      user: 'hi', systemPrompt: 'sys', provider: 'openai', modelId: 'gpt-x', signal,
    });
    expect(host.streamSimple).not.toHaveBeenCalled();
    expect(lines).toEqual([{ ok: true, content: 'fixed' }]);
  });

  it('流式行形状为 delta / done', async () => {
    const host = hostStub();
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'openai', modelId: 'gpt-x', user: 'hi', stream: true,
    }, (line) => lines.push(JSON.parse(line)));
    expect(lines).toEqual([
      { type: 'delta', text: 'he' },
      { type: 'delta', text: 'llo' },
      { type: 'done', usage: { total_tokens: 3 } },
    ]);
  });

  it('模型不可用 emit model not found: provider/id', async () => {
    const host = hostStub({
      completeSimple: vi.fn().mockRejectedValue(new Error('模型不可用')),
    });
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'gone', modelId: 'x', user: 'hi',
    }, (line) => lines.push(JSON.parse(line)));
    expect(lines).toEqual([{ ok: false, error: 'model not found: gone/x' }]);
  });
});

describe('runHostOneshot source imports', () => {
  it('main.ts 与 enhancePrompt.ts 都不再 import runOneshotWithRuntime', async () => {
    const { readFile } = await import('node:fs/promises');
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/runOneshotWithRuntime/);
    const enhance = await readFile(new URL('../app/enhancePrompt.ts', import.meta.url), 'utf8');
    expect(enhance).not.toMatch(/runOneshotWithRuntime/);
  });
});
