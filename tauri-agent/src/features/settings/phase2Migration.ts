import { loadState, serializeState, type UiProvider } from './providerConfigAdapter';
import { PROVIDER_PRESETS } from './providerPresets';

interface CapKeys {
  keyPrefix: string;
  provider: string;
  model: string;
}

const CAPS: CapKeys[] = [
  { keyPrefix: 'IMAGE', provider: 'IMAGE_PROVIDER', model: 'IMAGE_MODEL' },
  { keyPrefix: 'TTS', provider: 'TTS_PROVIDER', model: 'TTS_MODEL' },
  { keyPrefix: 'KB_EMBED', provider: 'KB_EMBED_PROVIDER', model: 'KB_EMBED_MODEL' },
  { keyPrefix: 'MEMORY_EMBED', provider: 'MEMORY_EMBED_PROVIDER', model: 'MEMORY_EMBED_MODEL' },
];

export interface Phase2MigrationResult {
  nextSettings: Record<string, string>;
  modelsJson: string;
  authJson: string;
  changed: boolean;
}

/**
 * 把旧的 *_API_KEY / *_BASE_URL / *_MODEL 迁移为 *_PROVIDER + *_MODEL。
 * - openai/空 base → openai；命中预设 baseUrlHint → 该预设；
 * - 其它自定义端点 → 新建 legacy-<cap> 自定义供应商并指向它。
 * 幂等：无旧 key 或新 provider 已设则跳过该能力。
 */
export function migratePhase2(
  settings: Record<string, string>,
  modelsJson: string | null,
  authJson: string | null,
): Phase2MigrationResult {
  let providers = loadState(modelsJson, authJson, PROVIDER_PRESETS);
  const next = { ...settings };
  let changed = false;

  for (const cap of CAPS) {
    const oldKey = (settings[`${cap.keyPrefix}_API_KEY`] ?? '').trim();
    const oldBase = (settings[`${cap.keyPrefix}_BASE_URL`] ?? '').replace(/\/+$/, '').trim();
    const oldModel = (settings[cap.model] ?? '').trim();
    if (!oldKey || (settings[cap.provider] ?? '').trim()) continue;

    let providerId = 'openai';
    const isOpenai = !oldBase || /api\.openai\.com/.test(oldBase);
    if (!isOpenai) {
      const preset = PROVIDER_PRESETS.find(
        (p) => p.baseUrlHint && oldBase === p.baseUrlHint.replace(/\/+$/, ''),
      );
      if (preset) {
        providerId = preset.id;
      } else {
        providerId = `legacy-${cap.keyPrefix.toLowerCase()}`;
        if (!providers.some((p) => p.id === providerId)) {
          const legacy: UiProvider = {
            id: providerId,
            name: providerId,
            builtIn: false,
            api: 'openai-completions',
            baseUrl: oldBase,
            apiKey: oldKey,
            models: oldModel ? [{ id: oldModel }] : [],
          };
          providers = [...providers, legacy];
        }
      }
    }

    const target = providers.find((p) => p.id === providerId);
    if (target && target.builtIn && !target.apiKey) {
      providers = providers.map((p) => (p.id === providerId ? { ...p, apiKey: oldKey } : p));
    }

    next[cap.provider] = providerId;
    if (oldModel) next[cap.model] = oldModel;
    delete next[`${cap.keyPrefix}_API_KEY`];
    delete next[`${cap.keyPrefix}_BASE_URL`];
    changed = true;
  }

  const ser = serializeState(providers);
  return { nextSettings: next, modelsJson: ser.modelsJson, authJson: ser.authJson, changed };
}
