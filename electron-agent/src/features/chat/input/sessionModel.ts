import { modelKey, parseModelKey, type ModelInfo } from './modelUtils';

export function sessionModelKey(model: { provider?: string; id?: string } | null | undefined): string {
  return model?.provider && model?.id ? modelKey(model.provider, model.id) : '';
}

/** 设置盘上的 "provider/id"（第一个 '/' 切开）→ 输入栏 modelKey；非法当留空。 */
export function settingsModelToKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return '';
  return modelKey(trimmed.slice(0, idx), trimmed.slice(idx + 1));
}

/** 会话还没回出当前模型时，用上次选中或列表第一项顶上，避免空会话停在「模型」占位。 */
export function pickFallbackModelKey(models: ModelInfo[], preferred = ''): string {
  if (preferred && models.some((item) => modelKey(item.provider, item.id) === preferred)) return preferred;
  const first = models[0];
  return first ? modelKey(first.provider, first.id) : '';
}

export function selectedModelLabel(value: string, models: ModelInfo[]): string {
  if (!value) return '';
  const { provider, id } = parseModelKey(value);
  return models.find((item) => item.provider === provider && item.id === id)?.name ?? id;
}
