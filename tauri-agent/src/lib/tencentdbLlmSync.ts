import type { ModelInfo } from '../features/chat/input/modelUtils';
import { tencentdbApi, type TencentdbLlmSyncInput } from './tencentdb';

type ProviderConfig = { modelsJson: string | null; authJson: string | null };
type SyncFn = (input: TencentdbLlmSyncInput) => Promise<unknown>;

export async function syncPiModelToTencentdb(
  model: ModelInfo,
  config: ProviderConfig,
  sync: SyncFn = tencentdbApi.syncLlm,
): Promise<{ synced: boolean; reason?: string }> {
  if (!model.api || !model.baseUrl || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api)) {
    return { synced: false, reason: 'unsupported-provider' };
  }
  let auth: Record<string, { key?: string; access?: string; accessToken?: string; token?: string }> = {};
  let providers: Record<string, { apiKey?: string }> = {};
  try {
    auth = config.authJson ? JSON.parse(config.authJson) as typeof auth : {};
  } catch {
    auth = {};
  }
  try {
    const parsed = config.modelsJson ? JSON.parse(config.modelsJson) as { providers?: typeof providers } : {};
    providers = parsed.providers ?? {};
  } catch {
    providers = {};
  }
  const credential = auth[model.provider];
  const apiKey = (credential?.key ?? credential?.access ?? credential?.accessToken ?? credential?.token ?? providers[model.provider]?.apiKey ?? '').trim();
  if (!apiKey) return { synced: false, reason: 'missing-api-key' };
  try {
    await sync({
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey,
    });
    return { synced: true };
  } catch (error) {
    return { synced: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
