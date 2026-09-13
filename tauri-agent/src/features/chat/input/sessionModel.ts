import { modelKey, parseModelKey, type ModelInfo } from './modelUtils';

export function sessionModelKey(model: { provider?: string; id?: string } | null | undefined): string {
  return model?.provider && model?.id ? modelKey(model.provider, model.id) : '';
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
