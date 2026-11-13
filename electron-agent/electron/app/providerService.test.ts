import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { describeProviderLoginError, ProviderService, type ProviderLoginUiEvent } from './providerService';

const directories: string[] = [];

function stubRuntime(overrides: Record<string, unknown> = {}): ModelRuntime {
  const login = vi.fn(async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 0 }));
  return {
    setRuntimeApiKey: vi.fn(async () => {}),
    removeRuntimeApiKey: vi.fn(async () => {}),
    listCredentials: vi.fn(async () => []),
    getProviderAuthStatus: vi.fn(() => ({ configured: false })),
    getProviders: vi.fn(() => []),
    login,
    // 1.4.0 的适配走同一实例内的 Models 集合；这里转发到 login，现有用例无需改动。
    models: { login: vi.fn((p: string, t: string, i: unknown) => login(p, t, i)) },
    logout: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ModelRuntime;
}

/** 官方 flow 的交互面形状；测试里驱动 notify / prompt 而不引入 pi-ai 运行时。 */
interface LoginInteractionStub {
  signal: AbortSignal;
  notify(event: Record<string, unknown>): void;
  prompt(prompt: Record<string, unknown>): Promise<string>;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProviderService', () => {
  it('persists validated models.json and never writes auth.json', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{"providers":{}}')).resolves.toEqual({ refreshed: [], failed: [] });
    await expect(service.getConfig()).resolves.toEqual({
      modelsJson: '{"providers":{}}',
      authJson: null,
      agentDir,
    });
    await expect(readFile(join(agentDir, 'models.json'), 'utf8')).resolves.toBe('{"providers":{}}');
  });

  it('leaves an existing OAuth credential untouched when saving model config', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const oauth = JSON.stringify({
      anthropic: { type: 'oauth', refresh: 'refresh-token', access: 'access-token', expires: 1893456000000 },
    });
    await writeFile(join(agentDir, 'auth.json'), oauth);
    const service = new ProviderService({ agentDir });

    await service.setConfig('{"providers":{}}');
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe(oauth);
  });

  it('rejects malformed provider JSON before writing the file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{')).rejects.toThrow('models.json is not valid JSON');
    await expect(service.getConfig()).resolves.toEqual({ modelsJson: null, authJson: null, agentDir });
  });

  it('writes a built-in API key through the official runtime', async () => {
    const runtime = stubRuntime();
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.setApiKey('openai', 'sk-new');
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-new');
  });

  it('does not remove an OAuth credential when the API key input is cleared', async () => {
    const runtime = stubRuntime({
      listCredentials: vi.fn(async () => [{ providerId: 'anthropic', type: 'oauth' }]),
    });
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.setApiKey('anthropic', null);
    expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('removes an api_key credential when the key is cleared', async () => {
    const runtime = stubRuntime({
      listCredentials: vi.fn(async () => [{ providerId: 'openai', type: 'api_key' }]),
    });
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.setApiKey('openai', null);
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('openai');
  });

  it('returns credential status without exposing token values', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      anthropic: { type: 'oauth', refresh: 'secret-refresh', access: 'secret-access', expires: 1893456000000 },
    }));
    const runtime = stubRuntime({
      listCredentials: vi.fn(async () => [{ providerId: 'anthropic', type: 'oauth' }]),
      getProviderAuthStatus: vi.fn(() => ({ configured: true, label: 'OAuth' })),
      getProviders: vi.fn(() => [{
        id: 'anthropic',
        auth: { oauth: { name: 'Anthropic (Claude Pro/Max)', isSubscription: true } },
      }]),
    });
    const service = new ProviderService({ agentDir, runtime: async () => runtime });

    await expect(service.getCredentials()).resolves.toEqual([{
      providerId: 'anthropic', type: 'oauth', source: 'OAuth', configured: true,
      expiresAt: 1893456000000, isSubscription: true,
    }]);
  });

  it('discovers OAuth capabilities from the runtime and excludes radius', async () => {
    const runtime = stubRuntime({
      getProviders: vi.fn(() => [
        { id: 'anthropic', auth: { oauth: { name: 'Anthropic (Claude Pro/Max)', loginLabel: 'Sign in with Claude', isSubscription: true } } },
        { id: 'radius', auth: { oauth: { name: 'Radius gateway' } } },
        { id: 'openai', auth: {} },
      ]),
    });
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await expect(service.getOAuthCapabilities()).resolves.toEqual([{
      providerId: 'anthropic', name: 'Anthropic (Claude Pro/Max)',
      loginLabel: 'Sign in with Claude', isSubscription: true,
    }]);
  });

  it('passes a stable UUID device id and agent name into the official OAuth flow', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const runtime = stubRuntime();
    const service = new ProviderService({ agentDir, runtime: async () => runtime });

    await service.startLogin('openai', () => {});
    await service.startLogin('openai', () => {});

    const modelsLogin = (runtime as unknown as { models: { login: ReturnType<typeof vi.fn> } }).models.login;
    const first = modelsLogin.mock.calls[0][3] as { getDeviceId(): string; agentName?: string };
    const second = modelsLogin.mock.calls[1][3] as { getDeviceId(): string; agentName?: string };
    expect(first.getDeviceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(first.getDeviceId()).toBe(second.getDeviceId());
    expect(first.agentName).toBe('GrenAgent');
    await expect(readFile(join(agentDir, 'device-id.json'), 'utf8')).resolves.toContain(first.getDeviceId());
  });

  it('emits Chinese, actionable text for official OAuth errors', () => {
    expect(describeProviderLoginError('Sign in with ChatGPT requires a device ID (UUID) for this installation'))
      .toContain('设备标识');
    expect(describeProviderLoginError('Port 1456 is in use, probably by an unfinished login'))
      .toContain('回调端口被占用');
    expect(describeProviderLoginError('access_denied')).toContain('授权被拒绝');
    expect(describeProviderLoginError('oops')).toBe('登录失败：oops');
  });

  it('turns the English device-id failure from the flow into a Chinese UI error', async () => {
    const runtime = stubRuntime({
      models: {
        login: vi.fn(async () => {
          throw new Error('Sign in with ChatGPT requires a device ID (UUID) for this installation');
        }),
      },
    });
    const events: ProviderLoginUiEvent[] = [];
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.startLogin('openai', (e) => events.push(e));
    expect(events.find((e) => e.type === 'error')?.message).toContain('设备标识');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('falls back to the public login when the internal models collection is absent', async () => {
    const runtime = stubRuntime({ models: undefined });
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.startLogin('anthropic', () => {});
    expect(runtime.login).toHaveBeenCalledWith('anthropic', 'oauth', expect.anything());
  });

  it('forwards all four AuthEvent kinds and resolves an interactive prompt', async () => {
    const events: ProviderLoginUiEvent[] = [];
    const runtime = stubRuntime();
    let service!: ProviderService;
    (runtime.login as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_provider: string, _type: string, interaction: LoginInteractionStub) => {
        interaction.notify({ type: 'info', message: 'starting' });
        interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize', instructions: 'open browser' });
        interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' });
        interaction.notify({ type: 'progress', message: 'waiting' });
        const answer = interaction.prompt({ type: 'manual_code', message: 'paste code', placeholder: 'code' });
        const promptEvent = events.find((e) => e.type === 'prompt')!;
        expect(promptEvent.prompt?.type).toBe('manual_code');
        service.respondPrompt(promptEvent.promptId!, 'pasted-code');
        expect(await answer).toBe('pasted-code');
        return { type: 'oauth' };
      },
    );
    service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.startLogin('anthropic', (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual([
      'progress', 'info', 'auth_url', 'device_code', 'progress', 'prompt', 'done',
    ]);
    expect(events[2].url).toBe('https://auth.example/authorize');
    expect(events[3].userCode).toBe('ABCD-1234');
    expect(runtime.login).toHaveBeenCalledWith('anthropic', 'oauth', expect.anything());
  });

  it('rejects a second concurrent login', async () => {
    const runtime = stubRuntime();
    let release!: () => void;
    (runtime.login as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ type: 'oauth' }); }),
    );
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    const first = service.startLogin('anthropic', () => {});
    await expect(service.startLogin('openai', () => {})).rejects.toThrow('已有登录流程正在进行');
    // deviceId 落盘是一次异步读；等第一次登录真正进入官方 flow 再放行。
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await first;
  });

  it('cancels a login without writing credentials or leaving a hanging prompt', async () => {
    const events: ProviderLoginUiEvent[] = [];
    const runtime = stubRuntime();
    (runtime.login as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_p: string, _t: string, interaction: LoginInteractionStub) => new Promise((_resolve, reject) => {
        // 官方 flow 在进入等待前会检查 signal；取消可能先于 flow 启动。
        if (interaction.signal.aborted) { reject(new Error('aborted')); return; }
        interaction.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        void interaction.prompt({ type: 'text', message: 'code' }).catch(() => {});
      }),
    );
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    const login = service.startLogin('anthropic', (e) => events.push(e));
    service.cancelLogin(events[0].loginId);
    await login;
    expect(events.some((e) => e.type === 'error' && e.message === '登录已取消')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('drops a manual-code prompt when its own signal aborts', async () => {
    const events: ProviderLoginUiEvent[] = [];
    const runtime = stubRuntime();
    (runtime.login as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_p: string, _t: string, interaction: LoginInteractionStub) => {
        const controller = new AbortController();
        const answer = interaction.prompt({
          type: 'manual_code', message: 'paste code', signal: controller.signal,
        });
        controller.abort();
        await expect(answer).rejects.toThrow('Login prompt cancelled');
        return { type: 'oauth' };
      },
    );
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.startLogin('anthropic', (e) => events.push(e));
    expect(events.some((e) => e.type === 'prompt_cancelled')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('reports a failed login and allows an immediate retry', async () => {
    const events: ProviderLoginUiEvent[] = [];
    const runtime = stubRuntime();
    (runtime.login as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('access_denied'))
      .mockResolvedValueOnce({ type: 'oauth' });
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime });

    await service.startLogin('anthropic', (e) => events.push(e));
    expect(events.find((e) => e.type === 'error')?.message).toContain('授权被拒绝');
    await expect(service.startLogin('openai', () => {})).resolves.toBeUndefined();
  });

  it('logs out through the official runtime and refreshes both views', async () => {
    const runtime = stubRuntime();
    const refresh = vi.fn(async () => ({ refreshed: [], failed: [] }));
    const service = new ProviderService({ agentDir: 'C:/agent', runtime: async () => runtime, refresh });

    await service.logout('anthropic');
    expect(runtime.logout).toHaveBeenCalledWith('anthropic');
    expect(refresh).toHaveBeenCalled();
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

      expect(requests[0]).toEqual({ requestId:'r1',provider: 'p', modelId: 'm', user: 'hi', stream: true, reasoning: 'high' });
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

    it('OAuth 刷新失败给出重新登录提示，且不删除原凭据', async () => {
      const runtime = stubRuntime();
      const service = new ProviderService({
        agentDir: 'C:/agent',
        runtime: async () => runtime,
        oneshot: async (_request, onLine) => {
          onLine?.('{"type":"error","error":"ModelsError [oauth]: invalid_grant"}');
        },
      });

      const result = await service.diagnose({ ...base, stream: true }, () => {});
      expect(result.error).toContain('重新登录');
      expect(runtime.logout).not.toHaveBeenCalled();
      expect(runtime.removeRuntimeApiKey).not.toHaveBeenCalled();
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

it('rejects invalid advanced fields before writing or resolving command credentials; refresh failure keeps saved file',async()=>{
 const agentDir=await mkdtemp(join(tmpdir(),'gren-advanced-save-'));directories.push(agentDir);
 const before='{"providers":{}}';await writeFile(join(agentDir,'models.json'),before);await writeFile(join(agentDir,'auth.json'),'fixture-unchanged');
 const service=new ProviderService({agentDir,refresh:async()=>({refreshed:['good'],failed:[{workspace:'bad',error:'offline'}]})});
 for(const option of [{samplingParams:[]},{promptCache:{short:null}},{inputLimits:{images:{resize:{jpegQuality:101}}}}]){
  const raw=JSON.stringify({providers:{fixture:{apiKey:'!DO_NOT_EXECUTE',models:[{id:'fixture',...option}]}}});
  await expect(service.setConfig(raw)).rejects.toThrow();
  expect(await readFile(join(agentDir,'models.json'),'utf8')).toBe(before);
 }
 const raw=JSON.stringify({providers:{fixture:{apiKey:'!DO_NOT_EXECUTE',models:[{id:'fixture',samplingParams:{top_p:0},promptCache:{short:0.5}}]}}});
 expect(await service.setConfig(raw)).toEqual({refreshed:['good'],failed:[{workspace:'bad',error:'offline'}]});
 expect(await readFile(join(agentDir,'models.json'),'utf8')).toBe(raw);
 expect(await readFile(join(agentDir,'auth.json'),'utf8')).toBe('fixture-unchanged');
});
