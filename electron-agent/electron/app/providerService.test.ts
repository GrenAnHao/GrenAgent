import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderService } from './providerService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProviderService', () => {
  it('persists validated model and auth JSON then returns the provider payload', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{"providers":{}}', '{"openai":{"type":"api_key"}}')).resolves.toEqual({ refreshed: [], failed: [] });
    await expect(service.getConfig()).resolves.toEqual({
      modelsJson: '{"providers":{}}',
      authJson: '{"openai":{"type":"api_key"}}',
      agentDir,
    });
    await expect(readFile(join(agentDir, 'models.json'), 'utf8')).resolves.toBe('{"providers":{}}');
  });

  it('rejects malformed provider JSON before writing either file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{', '{}')).rejects.toThrow('models.json is not valid JSON');
    await expect(service.getConfig()).resolves.toEqual({ modelsJson: null, authJson: null, agentDir });
  });

  it('returns models parsed from the Pi probe output', async () => {
    const service = new ProviderService({
      agentDir: 'C:/agent',
      probeModels: async () => '{"ok":true,"models":[{"provider":"openai","id":"gpt-5"}]}',
    });

    await expect(service.listModels()).resolves.toEqual([{ provider: 'openai', id: 'gpt-5' }]);
  });

  it('discovers OpenAI-compatible model ids from the provider endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await expect(service.fetchModels('https://provider.example', 'secret', 'openai-completions')).resolves.toEqual(['model-a']);
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer secret' },
    }));
  });

  it('applies custom headers (e.g. a neutral User-Agent) to the model probe request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await service.fetchModels('https://provider.example', 'secret', 'openai-completions', { 'User-Agent': 'pi-agent/1.0' });
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { 'User-Agent': 'pi-agent/1.0', authorization: 'Bearer secret' },
    }));
  });

  it('does not let custom headers override the authorization/x-api-key credential', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await service.fetchModels('https://provider.example', 'secret', 'openai-completions', { Authorization: 'Bearer spoofed' });
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer secret' },
    }));
  });

  it('resolves {sessionId} in custom headers for the model probe', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await service.fetchModels('https://provider.example', 'secret', 'openai-completions', {
      'x-opencode-session': '{sessionId}',
    });
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { 'x-opencode-session': 'settings-probe', authorization: 'Bearer secret' },
    }));
  });

  it('sends custom headers alongside x-api-key for anthropic-messages', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await service.fetchModels('https://provider.example', 'secret', 'anthropic-messages', { 'User-Agent': 'pi-agent/1.0' });
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { 'User-Agent': 'pi-agent/1.0', 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' },
    }));
  });

  it('uses the active workspace model for Mermaid repair and streams diagnostics', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new ProviderService({
      agentDir: 'C:/agent',
      activeModel: async () => ({ provider: 'openai', modelId: 'gpt-5' }),
      oneshot: async (request, onLine) => {
        requests.push(request);
        if ('system' in request) { onLine?.('{"ok":true,"content":"hello"}'); return; }
        onLine?.('{"type":"delta","text":"hello"}');
        onLine?.('{"type":"done","usage":{"total_tokens":3}}');
      },
    });
    const chunks: string[] = [];

    await expect(service.fixMermaid('C:/project', 'graph TD', 'parse error')).resolves.toBe('hello');
    await expect(service.diagnose(
      { requestId: 'r1', providerId: 'openai', modelId: 'gpt-5', prompt: '', stream: true },
      (chunk) => chunks.push(chunk.text),
    )).resolves.toMatchObject({ ok: true, cancelled: false, content: 'hello', totalTokens: 3 });
    expect(requests[0]).toMatchObject({ provider: 'openai', modelId: 'gpt-5' });
    expect(chunks).toEqual(['hello']);
  });

  describe('diagnose', () => {
    const base = { requestId: 'r1', providerId: 'p', modelId: 'm', prompt: 'hi' };

    it('思考档透传给 oneshot，关闭时不带 reasoning；两种显示模式线上都走流式', async () => {
      const requests: Record<string, unknown>[] = [];
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async (request, onLine) => {
          requests.push(request);
          onLine?.('{"type":"delta","text":"ok"}');
          onLine?.('{"type":"done","usage":{}}');
        },
      });

      await service.diagnose({ ...base, stream: false, reasoning: 'high' }, () => {});
      await service.diagnose({ ...base, stream: true }, () => {});

      expect(requests[0]).toEqual({ provider: 'p', modelId: 'm', user: 'hi', stream: true, reasoning: 'high' });
      expect(requests[1]).not.toHaveProperty('reasoning');
    });

    it('思考与正文分开收集；按 pi-ai Usage 字段读 token，思考 token 单列', async () => {
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async (_request, onLine) => {
          onLine?.('{"type":"thinking","text":"let me "}');
          onLine?.('{"type":"thinking","text":"think"}');
          onLine?.('{"type":"delta","text":"answer"}');
          onLine?.('{"type":"done","usage":{"input":12,"output":30,"reasoning":20,"totalTokens":42}}');
        },
      });
      const chunks: unknown[] = [];

      const result = await service.diagnose({ ...base, stream: true, reasoning: 'low' }, (chunk) => chunks.push(chunk));

      expect(result).toMatchObject({
        ok: true, content: 'answer', thinking: 'let me think',
        promptTokens: 12, completionTokens: 30, reasoningTokens: 20, totalTokens: 42,
      });
      expect(result.ttftMs).toBeGreaterThanOrEqual(0);
      expect(chunks).toEqual([
        { type: 'thinking', text: 'let me ' },
        { type: 'thinking', text: 'think' },
        { type: 'text', text: 'answer' },
      ]);
    });

    it('stream=false 不推分片，全文只在结果里', async () => {
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async (_request, onLine) => { onLine?.('{"type":"delta","text":"full"}'); },
      });
      const onChunk = vi.fn();

      await expect(service.diagnose({ ...base, stream: false }, onChunk)).resolves.toMatchObject({ ok: true, content: 'full' });
      expect(onChunk).not.toHaveBeenCalled();
    });

    it('没有正文算失败：只有思考、什么都没有分别报', async () => {
      const thinkingOnly = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async (_request, onLine) => { onLine?.('{"type":"thinking","text":"hmm"}'); },
      });
      const empty = new ProviderService({ agentDir: 'C:/agent', oneshot: async () => {} });

      await expect(thinkingOnly.diagnose({ ...base, stream: true }, () => {})).resolves.toMatchObject({ ok: false, error: '模型只返回了思考，没有正文' });
      await expect(empty.diagnose({ ...base, stream: true }, () => {})).resolves.toMatchObject({ ok: false, error: '模型返回了空内容' });
    });

    it('供应商报错原样带回', async () => {
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async (_request, onLine) => { onLine?.('{"type":"error","error":"401 invalid key"}'); },
      });

      await expect(service.diagnose({ ...base, stream: true }, () => {})).resolves.toMatchObject({ ok: false, cancelled: false, error: '401 invalid key' });
    });

    it('abortDiagnose 立即返回 cancelled，不等卡住的请求收尾，也不再推分片', async () => {
      let signal: AbortSignal | undefined;
      let late: ((line: string) => void) | undefined;
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: (_request, onLine, s) => {
          signal = s;
          late = onLine;
          onLine?.('{"type":"delta","text":"par"}');
          return new Promise<void>(() => {}); // 供应商卡住，永不结束
        },
      });
      const chunks: string[] = [];

      const pending = service.diagnose({ ...base, stream: true }, (chunk) => chunks.push(chunk.text));
      service.abortDiagnose('r1');
      const result = await pending;
      late?.('{"type":"delta","text":"tial"}');

      expect(signal?.aborted).toBe(true);
      expect(result).toMatchObject({ ok: false, cancelled: true, error: null, content: 'par', tokensPerSec: null });
      expect(chunks).toEqual(['par']);
    });

    it('abortDiagnose 只取消对应 requestId；未知 id 什么都不做', async () => {
      const signals: AbortSignal[] = [];
      const finish: Array<() => void> = [];
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: (_request, onLine, s) => new Promise<void>((resolve) => {
          signals.push(s!);
          finish.push(() => { onLine?.('{"type":"delta","text":"ok"}'); resolve(); });
        }),
      });

      const a = service.diagnose({ ...base, requestId: 'a', stream: true }, () => {});
      const b = service.diagnose({ ...base, requestId: 'b', stream: true }, () => {});
      service.abortDiagnose('nope');
      service.abortDiagnose('a');
      finish[1]!();

      await expect(a).resolves.toMatchObject({ cancelled: true });
      await expect(b).resolves.toMatchObject({ ok: true, cancelled: false });
      expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    });

    it('oneshot 抛错算失败，不冒泡', async () => {
      const service = new ProviderService({
        agentDir: 'C:/agent',
        oneshot: async () => { throw new Error('runtime down'); },
      });

      await expect(service.diagnose({ ...base, stream: true }, () => {})).resolves.toMatchObject({ ok: false, error: 'runtime down' });
    });
  });
});
