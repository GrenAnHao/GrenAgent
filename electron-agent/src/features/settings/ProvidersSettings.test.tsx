import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const {
  getProviderConfig, setProviderConfig, setProviderApiKey, getSettings, setSettings, listModelsGlobal,
  getProviderCredentials, getProviderOAuthCapabilities, logoutProvider, listBuiltinModels,
} = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{}', agentDir: '/a' })),
  setProviderConfig: vi.fn(() => Promise.resolve({ refreshed: ['/ws'], failed: [] })),
  setProviderApiKey: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  setSettings: vi.fn(() => Promise.resolve()),
  listModelsGlobal: vi.fn(() => Promise.resolve({ ok: true, models: [{ provider: 'openai', id: 'gpt-5', reasoning: true }] })),
  listBuiltinModels: vi.fn(() => Promise.resolve([] as Record<string, unknown>[])),
  getProviderCredentials: vi.fn(() => Promise.resolve([])),
  getProviderOAuthCapabilities: vi.fn(() => Promise.resolve([])),
  logoutProvider: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({
  pi: {
    getProviderConfig, setProviderConfig, setProviderApiKey, getSettings, setSettings, listModelsGlobal,
    getProviderCredentials, getProviderOAuthCapabilities, logoutProvider, listBuiltinModels,
  },
}));

const openaiCapability = {
  providerId: 'openai', name: 'OpenAI (ChatGPT subscription)',
  loginLabel: 'Sign in with ChatGPT', isSubscription: true,
};
const oauthCredential = {
  providerId: 'openai', type: 'oauth' as const, source: 'OAuth', configured: true,
  expiresAt: 1893456000000, isSubscription: true,
};
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Popconfirm: ({ onConfirm, children }: { onConfirm?: () => void; children?: ReactNode }) => (
      <div>
        {children}
        <button type="button" data-testid="prov-del-confirm" onClick={() => onConfirm?.()}>
          确认删除
        </button>
      </div>
    ),
  };
});

import { THINKING_LEVEL_ROWS } from './modelCompatCatalog';
import { defaultThinkingLevelMap } from './providerConfigAdapter';
import { ProvidersSettings } from './ProvidersSettings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** antd Select 渲染为只读 combobox，fireEvent.change 驱动不了：打开下拉再点选项。 */
async function pickApiType(label: string) {
  fireEvent.mouseDown(screen.getByTestId('prov-api').closest('.ant-select')!);
  const option = await waitFor(() => {
    const hit = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find(
      (el) => el.getAttribute('title') === label || el.textContent?.trim() === label,
    );
    if (!hit) throw new Error(`找不到 API 类型选项：${label}`);
    return hit;
  });
  fireEvent.click(option);
}

/** 第 0 个模型卡片的档位对照应与该协议默认映射一致：字符串 = 显示并填值，null / 缺省 = 隐藏。 */
function expectLadder(api: string) {
  const map = defaultThinkingLevelMap(api, 'claude-x');
  for (const { level } of THINKING_LEVEL_ROWS) {
    const input = screen.getByTestId(`prov-model-map-${level}-0`) as HTMLInputElement;
    const want = map?.[level];
    expect(input.value).toBe(typeof want === 'string' ? want : '');
    expect(input.disabled).toBe(typeof want !== 'string');
  }
}

describe('ProvidersSettings', () => {
  it('详情分两层：上层是供应商设置，下层是测活（内置供应商也有，模型来自已保存的配置）', async () => {
    render(<ProvidersSettings />);
    await screen.findByTestId('prov-item-openai');

    const dock = screen.getByTestId('prov-diagnostics');
    expect(dock.previousElementSibling?.contains(screen.getByTestId('prov-apikey'))).toBe(true);
    // 测活层默认收起，先点开
    if (!screen.queryByTestId('prov-diag-body')) fireEvent.click(screen.getByTestId('prov-diag-toggle'));
    await waitFor(() => expect((screen.getByTestId('prov-diag-run') as HTMLButtonElement).disabled).toBe(false));
    expect(dock.querySelector('.ant-select')?.textContent).toContain('gpt-5');

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-new' } });
    expect(screen.getByText('有未保存的改动，测活使用的是已保存的配置。')).toBeTruthy();
  }, 30000);

  it('saves a changed built-in API key through the credential command, not a generated auth.json', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('prov-item-openai')).toBeTruthy();

    const key = screen.getByPlaceholderText('sk-...') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByTestId('prov-save'));

    await waitFor(() => expect(setProviderApiKey).toHaveBeenCalledWith('openai', 'sk-test'));
    const lastCall = setProviderConfig.mock.calls.at(-1) as unknown as [string];
    expect(lastCall).toHaveLength(1);
  }, 30000);

  it('does not write any credential when the saved API key matches the loaded value', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('prov-item-openai')).toBeTruthy();

    // 先 touch 让保存按钮可用，再把凭据改回原值：保存仍应只提交 models.json。
    const key = screen.getByPlaceholderText('sk-...') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'temp' } });
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('prov-save'));

    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    expect(setProviderApiKey).not.toHaveBeenCalled();
  }, 30000);

  it('migrates legacy OPENAI_API_KEY into the official credential store and strips it from settings', async () => {
    getSettings.mockResolvedValueOnce({ OPENAI_API_KEY: 'sk-legacy' });
    render(<ProvidersSettings />);

    await waitFor(() => expect(setProviderApiKey).toHaveBeenCalledWith('openai', 'sk-legacy'));

    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const arg = (setSettings.mock.calls.at(-1) as unknown as [Record<string, string>])[0];
    expect(arg.OPENAI_API_KEY).toBeUndefined();
  }, 30000);

  it('shows the subscription entry only for providers with runtime OAuth capability', async () => {
    getProviderOAuthCapabilities.mockResolvedValueOnce([openaiCapability]);
    render(<ProvidersSettings />);
    expect(await screen.findByTestId('prov-oauth-mode')).toBeTruthy();

    fireEvent.click(await screen.findByTestId('prov-item-xai'));
    expect(screen.queryByTestId('prov-oauth-mode')).toBeNull();
    expect(screen.getByPlaceholderText('sk-...')).toBeTruthy();
  }, 30000);

  it('shows a logged-in account card and marks the provider configured without an API key', async () => {
    getProviderOAuthCapabilities.mockResolvedValueOnce([openaiCapability]);
    getProviderCredentials.mockResolvedValueOnce([oauthCredential]);
    render(<ProvidersSettings />);

    expect(await screen.findByTestId('prov-oauth-card')).toBeTruthy();
    expect(screen.getByText('已登录（OAuth）')).toBeTruthy();
    expect(screen.getByTestId('prov-oauth-logout')).toBeTruthy();
    const dot = screen.getByTestId('prov-item-openai').querySelectorAll('span')[1];
    expect(dot?.getAttribute('style')).toContain('success');
  }, 30000);

  it('confirms before switching from OAuth to API key', async () => {
    getProviderOAuthCapabilities.mockResolvedValueOnce([openaiCapability]);
    getProviderCredentials.mockResolvedValueOnce([oauthCredential]);
    render(<ProvidersSettings />);
    expect(await screen.findByTestId('prov-oauth-card')).toBeTruthy();

    fireEvent.click(screen.getByText('API Key'));
    expect(screen.getByTestId('prov-oauth-switch-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prov-oauth-switch-ok'));
    expect(await screen.findByPlaceholderText('sk-...')).toBeTruthy();
  }, 30000);

  it('keeps the account card after saving unrelated model config', async () => {
    getProviderOAuthCapabilities.mockResolvedValueOnce([openaiCapability]);
    getProviderCredentials.mockResolvedValueOnce([oauthCredential]);
    setProviderApiKey.mockClear();
    logoutProvider.mockClear();
    render(<ProvidersSettings />);
    expect(await screen.findByTestId('prov-oauth-card')).toBeTruthy();

    fireEvent.click(screen.getByTestId('prov-add-model'));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), { target: { value: 'new-model' } });
    fireEvent.click(screen.getByTestId('prov-save'));

    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    expect(setProviderApiKey).not.toHaveBeenCalled();
    expect(logoutProvider).not.toHaveBeenCalled();
    expect(screen.getByTestId('prov-oauth-card')).toBeTruthy();
  }, 30000);

  it('adds a custom provider', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('prov-add-provider'));
    expect(await screen.findByTestId('prov-name', undefined, { timeout: 10000 })).toBeTruthy();
    expect(screen.getByText(/\{sessionId\}/)).toBeTruthy();
  }, 30000);

  it('persists a custom contextWindow typed into the input', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model', undefined, { timeout: 10000 }));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), {
      target: { value: 'my-model' },
    });

    const ctxOf = (raw: string) => {
      const models = JSON.parse(raw) as {
        providers: Record<string, { models?: { id: string; contextWindow?: number }[] }>;
      };
      return Object.values(models.providers)
        .flatMap((p) => p.models ?? [])
        .find((m) => m.id === 'my-model')?.contextWindow;
    };
    const lastModelsJson = () =>
      (setProviderConfig.mock.calls.at(-1) as unknown as [string, string])[0];

    // 输入任意上下文窗口 → 原样落盘（不再被 1M / 200k 二选一限制）
    const ctxWrap = screen.getByTestId('prov-model-context-0');
    const ctxInput = (ctxWrap.querySelector('input') ?? ctxWrap) as HTMLInputElement;
    fireEvent.change(ctxInput, { target: { value: '128000' } });
    fireEvent.blur(ctxInput);
    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalledTimes(1));
    expect(ctxOf(lastModelsJson())).toBe(128000);
  }, 30000);

  it('saves per-model image input and a default thinking map, and exposes thinkingFormat when expanded', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model', undefined, { timeout: 10000 }));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), { target: { value: 'glm-5.2' } });
    fireEvent.click(screen.getByTestId('prov-model-image-0'));
    fireEvent.click(screen.getByTestId('prov-model-reasoning-0'));
    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    const raw = JSON.parse((setProviderConfig.mock.calls.at(-1) as unknown as [string, string])[0]);
    const model = Object.values(raw.providers as Record<string, { models?: Array<Record<string, unknown>> }>)
      .flatMap((p) => p.models ?? [])
      .find((m) => m.id === 'glm-5.2');
    expect(model?.input).toEqual(['text', 'image']);
    expect(model?.thinkingLevelMap).toBeTruthy();

    fireEvent.click(screen.getByTestId('prov-model-expand-0'));
    expect(screen.getByTestId('prov-model-format-0')).toBeTruthy();
    expect(screen.getByTestId('prov-compat-supportsReasoningEffort-0')).toBeTruthy();
  }, 30000);

  it('saves cache prices and a cost tier typed into the model card', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model', undefined, { timeout: 10000 }));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), { target: { value: 'claude-haiku-5-5' } });
    fireEvent.click(screen.getByTestId('prov-model-expand-0'));

    const typeInto = (testId: string, value: string) => {
      const wrap = screen.getByTestId(testId);
      const input = (wrap.querySelector('input') ?? wrap) as HTMLInputElement;
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };
    typeInto('prov-model-cost-in-0', '0.1');
    typeInto('prov-model-cost-out-0', '0.5');
    typeInto('prov-model-cost-cache-read-0', '0.01');
    typeInto('prov-model-cost-cache-write-0', '0.125');

    // 新加的一档默认阈值 100000、四价抄基础价；改成长上下文档的价格。
    fireEvent.click(screen.getByTestId('prov-model-cost-tier-add-0'));
    const above = screen.getByTestId('prov-model-cost-tier-0-0-above');
    expect((above.querySelector('input') ?? (above as HTMLInputElement)).value).toBe('100,000');
    typeInto('prov-model-cost-tier-0-0-in', '0.5');
    typeInto('prov-model-cost-tier-0-0-out', '2.5');
    typeInto('prov-model-cost-tier-0-0-cr', '0.05');
    typeInto('prov-model-cost-tier-0-0-cw', '0.625');

    // 第二档阈值改成和第一档相同 → 提示重复；删掉后提示消失。
    fireEvent.click(screen.getByTestId('prov-model-cost-tier-add-0'));
    typeInto('prov-model-cost-tier-0-1-above', '100000');
    expect(screen.getByText('阈值重复：保存时同一阈值只留最后一行。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prov-model-cost-tier-0-1-remove'));
    expect(screen.queryByText('阈值重复：保存时同一阈值只留最后一行。')).toBeNull();

    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    const raw = JSON.parse((setProviderConfig.mock.calls.at(-1) as unknown as [string, string])[0]);
    const model = Object.values(raw.providers as Record<string, { models?: Array<Record<string, unknown>> }>)
      .flatMap((p) => p.models ?? [])
      .find((m) => m.id === 'claude-haiku-5-5');
    expect(model?.cost).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
  }, 30000);

  it('re-maps reasoning models to the new protocol ladder when the API type changes', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model', undefined, { timeout: 10000 }));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), { target: { value: 'claude-x' } });
    fireEvent.click(screen.getByTestId('prov-model-reasoning-0'));
    fireEvent.click(screen.getByTestId('prov-model-expand-0'));
    expectLadder('openai-completions');

    // 档位对照跟着 API 类型走：切到哪家就换成哪家的原生档位，保存时落盘的也是新协议的映射。
    await pickApiType('Anthropic Messages');
    await waitFor(() => expectLadder('anthropic-messages'));
    await pickApiType('Google Generative AI');
    await waitFor(() => expectLadder('google-generative-ai'));

    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    const raw = JSON.parse((setProviderConfig.mock.calls.at(-1) as unknown as [string, string])[0]);
    const provider = Object.values(raw.providers as Record<string, { api?: string; models?: Array<Record<string, unknown>> }>)
      .find((p) => p.models?.some((m) => m.id === 'claude-x'));
    expect(provider?.api).toBe('google-generative-ai');
    expect(provider?.models?.[0].thinkingLevelMap).toEqual(defaultThinkingLevelMap('google-generative-ai', 'claude-x'));
  }, 30000);

  it('blocks saving a model card with an empty ID and marks it red', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model', undefined, { timeout: 10000 }));
    fireEvent.change(await screen.findByTestId('prov-model-id-0'), { target: { value: 'kept-model' } });
    // 第二张卡片不填 ID：落盘后 pi 会拒绝整份 models.json，所有自定义供应商都会从模型列表消失。
    fireEvent.click(screen.getByTestId('prov-add-model'));
    const blank = (await screen.findByTestId('prov-model-id-1')).closest('.ant-input-affix-wrapper, .ant-input')!;
    expect(blank.className).not.toContain('status-error');

    fireEvent.click(screen.getByTestId('prov-save'));
    expect(await screen.findByText(/有模型 ID 为空/)).toBeTruthy();
    expect(setProviderConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('prov-model-id-1').closest('.ant-input-affix-wrapper, .ant-input')!.className).toContain('status-error');
    expect(screen.getByTestId('prov-model-id-0').closest('.ant-input-affix-wrapper, .ant-input')!.className).not.toContain('status-error');

    // 删掉空卡片后能正常保存。
    fireEvent.click(screen.getByTestId('prov-model-del-1'));
    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalledTimes(1));
    const raw = JSON.parse((setProviderConfig.mock.calls.at(-1) as unknown as [string, string])[0]);
    const ids = Object.values(raw.providers as Record<string, { models?: Array<{ id: string }> }>)
      .flatMap((p) => p.models ?? [])
      .map((m) => m.id);
    expect(ids).toEqual(['kept-model']);
  }, 30000);

  it('deletes a custom provider and scrubs linked model settings', async () => {
    getProviderConfig.mockResolvedValue({
      modelsJson: JSON.stringify({
        providers: {
          gone: { name: 'Gone', api: 'openai-completions', apiKey: 'k', models: [{ id: 'flash' }] },
        },
      }),
      authJson: '{}',
      agentDir: '/a',
    });
    getSettings.mockResolvedValue({
      titleModel: 'gone/flash',
      IMAGE_PROVIDER: 'gone',
      IMAGE_MODEL: 'img',
      SUBAGENT_MODEL_ALLOWLIST: JSON.stringify(['gone/flash', 'openai/gpt-4o']),
    });

    render(<ProvidersSettings />);
    fireEvent.click(await screen.findByTestId('prov-item-gone'));
    fireEvent.click(screen.getByTestId('prov-del-confirm'));

    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const arg = (setSettings.mock.calls.at(-1) as unknown as [Record<string, string>])[0];
    expect(arg.titleModel).toBe('');
    expect(arg.IMAGE_PROVIDER).toBe('');
    expect(arg.IMAGE_MODEL).toBe('');
    expect(arg.SUBAGENT_MODEL_ALLOWLIST).toBe(JSON.stringify(['openai/gpt-4o']));
  }, 30000);
});

it('advanced JSON keeps invalid drafts, rejects save, uses model protocol and preserves fields across provider protocol switches',async()=>{
 getProviderConfig.mockResolvedValueOnce({modelsJson:JSON.stringify({providers:{relay:{name:'Relay',api:'anthropic-messages',models:[{id:'m',api:'openai-completions',samplingParams:{top_p:0},promptCache:{short:0.5},future:'keep'}]}}}),authJson:'{}',agentDir:'/a'});
 render(<ProvidersSettings/>);fireEvent.click(await screen.findByTestId('prov-item-relay'));fireEvent.click(screen.getByTestId('prov-model-expand-0'));
 expect(screen.queryByTestId('advanced-0')).toBeNull();
 const toggle = screen.getByTestId('prov-model-advanced-toggle-0');
 expect(toggle.closest('[role="button"]')?.getAttribute('aria-expanded')).toBe('false');
 fireEvent.click(toggle);
 let input=await screen.findByTestId('advanced-0-samplingParams');
 fireEvent.change(input,{target:{value:'[1]'}});
 fireEvent.click(toggle);
 await waitFor(()=>expect(screen.queryByTestId('advanced-0')).toBeNull());
 fireEvent.click(screen.getByTestId('prov-save'));
 await screen.findAllByText(/必须是 JSON 对象/);expect(setProviderConfig).not.toHaveBeenCalled();
 fireEvent.click(toggle);
 input=await screen.findByTestId('advanced-0-samplingParams');
 expect((input as HTMLTextAreaElement).value).toBe('[1]');
 fireEvent.change(input,{target:{value:'{"top_p":0.8,"flag":false}'}});
 fireEvent.click(toggle);
 await waitFor(()=>expect(screen.queryByTestId('advanced-0')).toBeNull());
 fireEvent.click(toggle);
 input=await screen.findByTestId('advanced-0-samplingParams');
 expect(JSON.parse((input as HTMLTextAreaElement).value)).toEqual({top_p:0.8,flag:false});
 await pickApiType('OpenAI Responses');fireEvent.click(screen.getByTestId('prov-save'));
 await waitFor(()=>expect(setProviderConfig).toHaveBeenCalled());const saved=JSON.parse(setProviderConfig.mock.calls.at(-1)![0]);
 expect(saved.providers.relay.models[0]).toMatchObject({api:'openai-completions',samplingParams:{top_p:0.8,flag:false},promptCache:{short:0.5},future:'keep'});
 expect(setProviderApiKey).not.toHaveBeenCalled();
});

it('edits built-in metadata as a sparse override and resets only that model without touching OAuth', async () => {
  const other = { maxTokens: 42, future: 'keep' };
  getProviderConfig.mockResolvedValueOnce({ modelsJson: JSON.stringify({ providers: { openai: {
    modelOverrides: { 'gpt-other': other }, future: 'provider',
  } } }), authJson: JSON.stringify({ openai: { type: 'oauth' } }), agentDir: '/a' });
  listBuiltinModels.mockResolvedValueOnce([{ id: 'gpt-5', name: 'GPT fixture', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 16000, input: ['text', 'image'], compat: { supportsFastMode: true } }]);
  render(<ProvidersSettings />);
  await screen.findByTestId('prov-builtin-row-gpt-5');
  const id = screen.getByTestId('prov-model-id-builtin-gpt-5') as HTMLInputElement;
  expect(id.readOnly).toBe(true);
  expect(screen.queryByTestId('prov-model-del-builtin-gpt-5')).toBeNull();
  fireEvent.change(screen.getByTestId('prov-model-context-builtin-gpt-5'), { target: { value: '100000' } });
  fireEvent.click(screen.getByTestId('prov-model-fast-builtin-gpt-5'));
  fireEvent.click(screen.getByTestId('prov-save'));
  await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
  let saved = JSON.parse(setProviderConfig.mock.calls.at(-1)![0]);
  expect(saved.providers.openai.modelOverrides).toEqual({ 'gpt-5': { contextWindow: 100000, compat: { supportsFastMode: false } }, 'gpt-other': other });
  expect(saved.providers.openai.models).toBeUndefined();
  expect(setProviderApiKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('prov-builtin-reset-gpt-5'));
  fireEvent.click(screen.getByTestId('prov-save'));
  await waitFor(() => expect(setProviderConfig).toHaveBeenCalledTimes(2));
  saved = JSON.parse(setProviderConfig.mock.calls.at(-1)![0]);
  expect(saved.providers.openai.modelOverrides).toEqual({ 'gpt-other': other });
  expect(saved.providers.openai.future).toBe('provider');
  expect(setProviderApiKey).not.toHaveBeenCalled();
});

it('retries a failed built-in directory read without losing custom model editing', async () => {
  listBuiltinModels.mockRejectedValueOnce(new Error('目录读取失败')).mockResolvedValueOnce([{ id: 'gpt-fixture', api: 'openai-responses' }]);
  render(<ProvidersSettings />);
  await screen.findByTestId('prov-builtin-retry');
  fireEvent.click(screen.getByTestId('prov-add-model'));
  fireEvent.change(screen.getByTestId('prov-model-id-0'), { target: { value: 'custom' } });
  fireEvent.click(screen.getByTestId('prov-builtin-retry'));
  await screen.findByTestId('prov-builtin-row-gpt-fixture');
  expect((screen.getByTestId('prov-model-id-0') as HTMLInputElement).value).toBe('custom');
});

it('preserves saved overrides when another provider is edited',async()=>{
 const override={compat:{supportsFastMode:true},future:'keep',samplingParams:{top_p:0}};
 getProviderConfig.mockResolvedValueOnce({modelsJson:JSON.stringify({providers:{openai:{modelOverrides:{'gpt-5':override}},relay:{name:'Relay',api:'openai-completions',models:[{id:'m'}]}}}),authJson:'{}',agentDir:'/a'});
 render(<ProvidersSettings/>);await screen.findByTestId('prov-apikey');
 expect(screen.queryByTestId('builtin-advanced')).toBeNull();
 fireEvent.click(screen.getByTestId('prov-item-relay'));
 fireEvent.change(screen.getByTestId('prov-name'),{target:{value:'Renamed'}});fireEvent.click(screen.getByTestId('prov-save'));
 await waitFor(()=>expect(setProviderConfig).toHaveBeenCalled());const saved=JSON.parse(setProviderConfig.mock.calls.at(-1)![0]);
 expect(saved.providers.openai.modelOverrides['gpt-5']).toEqual(override);expect(saved.providers.openai.models).toBeUndefined();expect(setProviderApiKey).not.toHaveBeenCalled();
});
