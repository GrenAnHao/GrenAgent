import { useEffect, useRef, useState } from 'react';
import { Select } from '@lobehub/ui/base-ui';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useThinkingMemoryStore } from '../../../../stores/thinkingMemoryStore';
import { pi } from '../../../../lib/pi';
import { syncPiModelToTencentdb } from '../../../../lib/tencentdbLlmSync';
import { loadProviderList } from '../../../settings/providerListCache';
import {
  useAvailableModelsState,
  loadAvailableModels,
  getCachedAvailableModels,
} from '../../../settings/availableModelsCache';
import { modelKey, parseModelKey, type ModelInfo } from '../modelUtils';
import { resolveLevelForModel, type RpcModel } from '../thinkingLevels';

interface RpcSessionState {
  model?: { id?: string; name?: string; provider?: string; api?: string; baseUrl?: string };
}

// 记住每个 workspace 上次选中的模型 key：切换对话时同步回显（见组件内 render 期对齐），消除「先显示
// 上一个对话的模型、再异步跳到新值」的闪动。
const lastModelByWorkspace = new Map<string, string>();

export default function ModelAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  // 可用模型复用带缓存 + 冷启动轮询重试的共享 hook：开屏空对话（草稿 / 尚未 open 的 workspace）时
  // getAvailableModels 常返回空，一次性加载会让下拉永久禁用、「无模型可选」。hook 会重试至拿到非空，
  // 并在轮询期间给出 loading，让新建会话的下拉显示加载态而非空禁用。
  const { models: polledModels, loading: modelsLoading } = useAvailableModelsState(
    workspaceReady ? workspace : undefined,
  );
  const [models, setModels] = useState<ModelInfo[]>(() => getCachedAvailableModels(workspace) ?? []);
  const [providerNames, setProviderNames] = useState<Map<string, string>>(new Map());
  const [value, setValue] = useState(() => lastModelByWorkspace.get(workspace) ?? '');

  // 切换对话（workspace 变化）时同步回显该 workspace 上次选中的模型：React「render 期对齐 state」模式，
  // 不会先画出上一个对话的值再跳变，和 ModeAction 的 per-workspace 即时回显一致。
  const prevWorkspaceRef = useRef(workspace);
  if (prevWorkspaceRef.current !== workspace) {
    prevWorkspaceRef.current = workspace;
    setValue(lastModelByWorkspace.get(workspace) ?? '');
    // 模型列表也对齐到新 workspace 的缓存（命中秒显、未命中清空进入 loading），避免沿用上一个对话的模型。
    setModels(getCachedAvailableModels(workspace) ?? []);
  }

  // 轮询 / 缓存命中的非空模型落地（onOpenChange 的强制刷新也写这里）。
  useEffect(() => {
    if (polledModels && polledModels.length > 0) setModels(polledModels);
  }, [polledModels]);

  // 供应商显示名 + 当前选中模型：与模型列表分开加载。
  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    void (async () => {
      const [stateRes, provRes] = await Promise.allSettled([
        pi.getState(workspace),
        loadProviderList(true),
      ]);
      if (cancelled) return;
      if (provRes.status === 'fulfilled') {
        setProviderNames(new Map(provRes.value.map((p) => [p.id, p.name])));
      }
      if (stateRes.status === 'fulfilled') {
        const model = (stateRes.value as RpcSessionState)?.model;
        if (model?.provider && model?.id) {
          const key = modelKey(model.provider, model.id);
          lastModelByWorkspace.set(workspace, key);
          setValue(key);
          if (model.api && model.baseUrl) {
            void pi
              .getProviderConfig()
              .then((config) => syncPiModelToTencentdb(model as ModelInfo, config))
              .catch(() => {});
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady]);

  const onChange = (key: string) => {
    const { provider, id } = parseModelKey(key);
    setValue(key);
    lastModelByWorkspace.set(workspace, key);
    void (async () => {
      await pi.setModel(workspace, provider, id);
      const selected = models.find((item) => item.provider === provider && item.id === id);
      if (selected) {
        void pi
          .getProviderConfig()
          .then((config) => syncPiModelToTencentdb(selected, config))
          .catch(() => {});
      }
      // 切模型后按「该模型记忆 / 模型默认」设推理档位，避免沿用上一个模型的设定。
      try {
        const state = (await pi.getState(workspace)) as { thinkingLevel?: string; model?: RpcModel | null };
        const remembered = useThinkingMemoryStore.getState().byModel[modelKey(provider, id)];
        const target = resolveLevelForModel(state.model ?? null, remembered);
        if (target !== state.thinkingLevel) await pi.setThinkingLevel(workspace, target);
      } catch {
        /* getState/setThinkingLevel 失败则保持后端现状 */
      }
      // 通知 ThinkingAction 重读后端档位刷新显示。
      useThinkingMemoryStore.getState().bumpSwitch(workspace);
    })();
  };

  // 每次打开下拉都强制刷新：供应商配置在设置里保存后，已打开的对话也能看到新模型。
  const onOpenChange = (open: boolean) => {
    if (!open) return;
    void loadAvailableModels(workspace, true).then((m) => {
      if (m.length > 0) setModels(m);
    });
    void loadProviderList(true)
      .then((list) => setProviderNames(new Map(list.map((p) => [p.id, p.name]))))
      .catch(() => {});
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

  // 模型还没回来时（冷启动 / 新建会话 warm pi 期间）显示加载态：转圈 + 「加载模型…」占位，
  // 而不是空的禁用下拉；轮询拿到结果或耗尽（确实无可用模型）后转为正常 / 禁用。
  const loading = modelsLoading && models.length === 0;

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      loading={loading}
      disabled={!workspaceReady || models.length === 0}
      value={value || undefined}
      options={options}
      placeholder={loading ? '加载模型…' : '模型'}
      style={{ width: 'fit-content', minWidth: 88, maxWidth: 240 }}
      onChange={onChange}
      onOpenChange={onOpenChange}
    />
  );
}
