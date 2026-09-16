import { parseModelList } from './ModelListField';
import { SETTINGS_SCHEMA, type SettingField } from './settingsSchema';

function allSettingFields(): SettingField[] {
  return SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
}

/** 约定值 "provider/id"：按首个 '/' 切开，首段为供应商。 */
export function providerOfModelValue(value: string): string {
  const idx = value.indexOf('/');
  return idx === -1 ? '' : value.slice(0, idx);
}

function refersToRemovedProvider(value: string, removed: Set<string>): boolean {
  const provider = providerOfModelValue(value);
  return Boolean(provider) && removed.has(provider);
}

export interface ScrubLinkedModelSettingsResult {
  next: Record<string, string>;
  changed: boolean;
  clearedKeys: string[];
}

/**
 * 删除供应商后清掉仍指向它的联动配置：
 * - type=model："provider/id"
 * - type=capability：供应商 env + 对应模型 env
 * - type=model-list：JSON 数组里的 "provider/id"
 */
export function scrubLinkedModelSettings(
  settings: Record<string, string>,
  removedProviderIds: Iterable<string>,
): ScrubLinkedModelSettingsResult {
  const removed = new Set([...removedProviderIds].map((id) => id.trim()).filter(Boolean));
  if (removed.size === 0) return { next: settings, changed: false, clearedKeys: [] };

  const next = { ...settings };
  const clearedKeys: string[] = [];
  const clear = (key: string) => {
    if (!key || !(key in next) || next[key] === '') return;
    next[key] = '';
    clearedKeys.push(key);
  };

  for (const field of allSettingFields()) {
    if (field.type === 'model') {
      const value = next[field.key] ?? '';
      if (value && refersToRemovedProvider(value, removed)) clear(field.key);
      continue;
    }
    if (field.type === 'capability') {
      const provider = (next[field.key] ?? '').trim();
      if (provider && removed.has(provider)) {
        clear(field.key);
        if (field.modelKey) clear(field.modelKey);
      }
      continue;
    }
    if (field.type === 'model-list') {
      const list = parseModelList(next[field.key] ?? '');
      const kept = list.filter((item) => !refersToRemovedProvider(item, removed));
      if (kept.length !== list.length) {
        next[field.key] = kept.length ? JSON.stringify(kept) : '';
        clearedKeys.push(field.key);
      }
    }
  }

  return { next, changed: clearedKeys.length > 0, clearedKeys };
}
