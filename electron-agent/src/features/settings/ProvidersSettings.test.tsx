import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { getProviderConfig, setProviderConfig, getSettings, setSettings } = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{}', agentDir: '/a' })),
  setProviderConfig: vi.fn(() => Promise.resolve({ refreshed: ['/ws'], failed: [] })),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  setSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getProviderConfig, setProviderConfig, getSettings, setSettings },
}));
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
  it('loads providers and saves a built-in key to auth.json', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('prov-item-openai')).toBeTruthy();

    const key = screen.getByPlaceholderText('sk-...') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByTestId('prov-save'));

    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    const lastCall = setProviderConfig.mock.calls.at(-1) as unknown as [string, string];
    expect(JSON.parse(lastCall[1]).openai).toEqual({ type: 'api_key', key: 'sk-test' });
  }, 30000);

  it('migrates legacy OPENAI_API_KEY into auth.json and strips it from settings', async () => {
    getSettings.mockResolvedValueOnce({ OPENAI_API_KEY: 'sk-legacy' });
    render(<ProvidersSettings />);

    await waitFor(() => expect(setProviderConfig).toHaveBeenCalled());
    const lastCall = setProviderConfig.mock.calls.at(-1) as unknown as [string, string];
    expect(JSON.parse(lastCall[1]).openai.key).toBe('sk-legacy');

    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const arg = (setSettings.mock.calls.at(-1) as unknown as [Record<string, string>])[0];
    expect(arg.OPENAI_API_KEY).toBeUndefined();
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
