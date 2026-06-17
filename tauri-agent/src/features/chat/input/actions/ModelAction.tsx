import { useCallback, useEffect, useState } from 'react';
import { Select } from '@lobehub/ui/base-ui';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import { loadProviderList } from '../../../settings/providerListCache';
import { modelKey, parseModelKey, parseModels, type ModelInfo } from '../modelUtils';

interface RpcSessionState {
  model?: { id?: string; name?: string; provider?: string };
}

export default function ModelAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providerNames, setProviderNames] = useState<Map<string, string>>(new Map());
  const [value, setValue] = useState('');
  const [failed, setFailed] = useState(false);

  const loadModels = useCallback(async () => {
    const [modelsRes, stateRes, provRes] = await Promise.allSettled([
      pi.getAvailableModels(workspace),
      pi.getState(workspace),
      loadProviderList(true),
    ]);

    if (provRes.status === 'fulfilled') {
      setProviderNames(new Map(provRes.value.map((p) => [p.id, p.name])));
    }

    if (stateRes.status === 'fulfilled') {
      const model = (stateRes.value as RpcSessionState)?.model;
      if (model?.provider && model?.id) setValue(modelKey(model.provider, model.id));
    }

    if (modelsRes.status === 'fulfilled') {
      const parsed = parseModels(modelsRes.value);
      if (parsed.length > 0) {
        setModels(parsed);
        setFailed(false);
        return true;
      }
    }
    setFailed(true);
    return false;
  }, [workspace]);

  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    void (async () => {
      const ok = await loadModels();
      if (!cancelled && !ok) setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady, loadModels]);

  const onChange = (key: string) => {
    const { provider, id } = parseModelKey(key);
    setValue(key);
    void pi.setModel(workspace, provider, id);
  };

  // 每次打开下拉都重新拉取：供应商配置在设置里保存后，已打开的对话也能看到新模型。
  const onOpenChange = (open: boolean) => {
    if (open) void loadModels();
  };

  // 按供应商分组（保留出现顺序）；组名优先用供应商显示名，缺失时回退 provider id。
  const groups: { provider: string; items: ModelInfo[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const m of models) {
    let gi = groupIndex.get(m.provider);
    if (gi === undefined) {
      gi = groups.length;
      groupIndex.set(m.provider, gi);
      groups.push({ provider: m.provider, items: [] });
    }
    groups[gi].items.push(m);
  }
  const options = groups.map((g) => ({
    label: providerNames.get(g.provider) ?? g.provider,
    options: g.items.map((m) => ({ label: m.name ?? m.id, value: modelKey(m.provider, m.id) })),
  }));

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady || (failed && options.length === 0)}
      value={value || undefined}
      options={options}
      placeholder="模型"
      style={{ width: 'auto', maxWidth: 140 }}
      onChange={onChange}
      onOpenChange={onOpenChange}
    />
  );
}
