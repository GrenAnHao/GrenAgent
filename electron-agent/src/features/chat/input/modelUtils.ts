import type { ThinkingLevelMap } from '../../settings/providerConfigAdapter';

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

// NUL 分隔，避免 model id 自身含 ':' 时解析歧义。
const SEP = '\0';

export function modelKey(provider: string, id: string): string {
  return `${provider}${SEP}${id}`;
}

export function parseModelKey(key: string): { provider: string; id: string } {
  const idx = key.indexOf(SEP);
  if (idx === -1) return { provider: '', id: key };
  return { provider: key.slice(0, idx), id: key.slice(idx + 1) };
}

/** pi.getAvailableModels 可能返回数组或 { models: [...] }，统一成数组。 */
export function parseModels(raw: unknown): ModelInfo[] {
  if (Array.isArray(raw)) return raw as ModelInfo[];
  if (raw && typeof raw === 'object' && 'models' in raw) {
    const models = (raw as { models?: unknown }).models;
    return Array.isArray(models) ? (models as ModelInfo[]) : [];
  }
  return [];
}
