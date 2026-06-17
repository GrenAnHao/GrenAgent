import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getProviderConfig, setProviderConfig, getSettings, setSettings } = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{}', agentDir: '/a' })),
  setProviderConfig: vi.fn(() => Promise.resolve({ refreshed: ['/ws'], failed: [] })),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  setSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getProviderConfig, setProviderConfig, getSettings, setSettings },
}));

import { ProvidersSettings } from './ProvidersSettings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
  }, 30000);

  it('checking 1M persists contextWindow=1000000; unchecking falls back to 200000', async () => {
    render(<ProvidersSettings />);
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('prov-add-provider'));
    fireEvent.click(await screen.findByTestId('prov-add-model'));
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

    // 勾选 1M → contextWindow 落盘 1,000,000
    fireEvent.click(await screen.findByTestId('prov-model-context1m-0'));
    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalledTimes(1));
    expect(ctxOf(lastModelsJson())).toBe(1_000_000);

    // 取消勾选 → 回落默认 200,000
    fireEvent.click(await screen.findByTestId('prov-model-context1m-0'));
    fireEvent.click(screen.getByTestId('prov-save'));
    await waitFor(() => expect(setProviderConfig).toHaveBeenCalledTimes(2));
    expect(ctxOf(lastModelsJson())).toBe(200_000);
  }, 30000);
});
