import { useSessionStore } from '../../store/session';
import { useAvailableModels } from './availableModelsCache';
import { useProviderList } from './providerListCache';

export interface ProviderModelOption {
  label: string;
  value: string;
}

export interface ProviderModelData {
  /** 是否已拿到可用模型（决定 chat 模型字段是否回退手填）。 */
  ready: boolean;
  /** 仅「当前可用（已成功添加并有可用模型）」的供应商，label 为显示名。 */
  providerOptions: ProviderModelOption[];
  /** 供应商 id → 显示名（取不到回落 id）。 */
  nameOf: (providerId: string) => string;
  /** 取某供应商当前可用的模型（label 显示名 / value 模型 id）。 */
  modelsFor: (providerId: string) => ProviderModelOption[];
}

/**
 * 设置里各「选模型」字段共用的数据源：
 * - 供应商：取自 getAvailableModels 中出现过的 provider（即已配置且有可用模型＝成功添加），显示名来自供应商库。
 * - 模型：按 provider 过滤 getAvailableModels。
 * 这样下拉只列「当前可用供应商」与「该供应商拥有的模型」，无需手填。
 */
export function useProviderModelData(): ProviderModelData {
  const workspace = useSessionStore((s) => s.activeWorkspace);
  const models = useAvailableModels(workspace);
  const providers = useProviderList();

  const list = models ?? [];
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const providerOptions = Array.from(new Set(list.map((m) => m.provider))).map((id) => ({
    label: nameOf(id),
    value: id,
  }));
  const modelsFor = (providerId: string) =>
    list
      .filter((m) => m.provider === providerId)
      .map((m) => ({ label: m.name ?? m.id, value: m.id }));

  return { ready: list.length > 0, providerOptions, nameOf, modelsFor };
}
