import { useCallback, useEffect, useState } from 'react';
import { Select } from '@lobehub/ui/base-ui';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import { modelKey, parseModelKey, parseModels, type ModelInfo } from '../modelUtils';

interface RpcSessionState {
  model?: { id?: string; name?: string; provider?: string };
}

export default function ModelAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [value, setValue] = useState('');
  const [failed, setFailed] = useState(false);

  const loadModels = useCallback(async () => {
    const [modelsRes, stateRes] = await Promise.allSettled([
      pi.getAvailableModels(workspace),
      pi.getState(workspace),
    ]);

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

  const onOpenChange = (open: boolean) => {
    if (open && failed) void loadModels();
  };

  const options = models.map((m) => ({ label: m.name ?? m.id, value: modelKey(m.provider, m.id) }));

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady || (failed && options.length === 0)}
      value={value || undefined}
      options={options}
      placeholder="模型"
      onChange={onChange}
      onOpenChange={onOpenChange}
    />
  );
}
