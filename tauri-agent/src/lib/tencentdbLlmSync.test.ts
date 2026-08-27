import { describe, expect, it, vi } from 'vitest';
import { syncPiModelToTencentdb } from './tencentdbLlmSync';

describe('syncPiModelToTencentdb', () => {
  it('sends the selected Pi provider and model to TencentDB', async () => {
    const syncLlm = vi.fn().mockResolvedValue({ ok: true });
    await syncPiModelToTencentdb(
      {
        provider: 'openai',
        id: 'gpt-5',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        modelsJson: JSON.stringify({ providers: { openai: {} } }),
        authJson: JSON.stringify({ openai: { key: 'secret' } }),
      },
      syncLlm,
    );
    expect(syncLlm).toHaveBeenCalledWith({
      provider: 'openai',
      modelId: 'gpt-5',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
    });
  });

  it('swallows binding failures so model switching can continue', async () => {
    const syncLlm = vi.fn().mockRejectedValue(new Error('Knowledge unavailable'));
    await expect(
      syncPiModelToTencentdb(
        { provider: 'openai', id: 'gpt-5', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
        { modelsJson: null, authJson: JSON.stringify({ openai: { key: 'secret' } }) },
        syncLlm,
      ),
    ).resolves.toEqual({ synced: false, reason: 'Knowledge unavailable' });
  });

  it('does not write an incomplete independent LLM configuration', async () => {
    const syncLlm = vi.fn();
    await expect(
      syncPiModelToTencentdb(
        { provider: 'google', id: 'gemini-2.5', api: 'google-generative-ai' },
        { modelsJson: null, authJson: null },
        syncLlm,
      ),
    ).resolves.toEqual({ synced: false, reason: 'unsupported-provider' });
    expect(syncLlm).not.toHaveBeenCalled();
  });
});
