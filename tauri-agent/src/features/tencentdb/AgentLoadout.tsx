import { Alert, Button, Checkbox, Empty, InputNumber, Select, Spin } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tencentdbApi, useTencentdbConnection, type TencentdbAsset, type TencentdbFixedAsset } from './tencentdbApi';

const MANAGED_TYPES = new Set(['skill', 'llm_wiki', 'code_graph']);
const INJECTION_MODES = ['direct', 'summary', 'tool', 'reference'] as const;
const FIXED_ASSET_PAGE_SIZE = 100;

export function AgentLoadout() {
  const { config, status } = useTencentdbConnection();
  const agentId = config?.agentId ?? '';
  const enabled = Boolean(agentId) && (status?.state === 'ready' || status?.state === 'restart_required');
  const [assets, setAssets] = useState<TencentdbAsset[]>([]);
  const [bindings, setBindings] = useState<TencentdbFixedAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAgentId, setLoadedAgentId] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const scope = useRef({ agentId, enabled });
  scope.current = { agentId, enabled };

  const reload = useCallback(async () => {
    if (scope.current.agentId !== agentId || scope.current.enabled !== enabled) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => (
      requestGeneration.current === generation
      && scope.current.agentId === agentId
      && scope.current.enabled === enabled
    );
    setAssets([]);
    setBindings([]);
    setSelected(new Set());
    setLoadedAgentId(null);
    if (!enabled) {
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const assetRequest = (async () => {
        const nextAssets: TencentdbAsset[] = [];
        let offset = 0;
        while (true) {
          const page = await tencentdbApi.coreRequest<{ items?: TencentdbAsset[]; total?: number }>('/v3/meta/asset/list-accessible', {
            limit: FIXED_ASSET_PAGE_SIZE,
            offset,
          });
          if (!isCurrent()) return [];
          const pageItems = page.items ?? [];
          nextAssets.push(...pageItems);
          offset += pageItems.length;
          if (pageItems.length === 0 || offset >= (page.total ?? offset)) break;
        }
        return nextAssets;
      })();
      const bindingRequest = (async () => {
        const nextBindings: TencentdbFixedAsset[] = [];
        let offset = 0;
        while (true) {
          const page = await tencentdbApi.coreRequest<{ items?: TencentdbFixedAsset[]; total?: number }>('/v3/meta/agent-fixed-asset/list-with-detail', {
            limit: FIXED_ASSET_PAGE_SIZE,
            offset,
          });
          if (!isCurrent()) return [];
          const pageItems = page.items ?? [];
          nextBindings.push(...pageItems);
          offset += pageItems.length;
          if (pageItems.length === 0 || offset >= (page.total ?? offset)) break;
        }
        return nextBindings;
      })();
      const [nextAssets, nextBindings] = await Promise.all([
        assetRequest,
        bindingRequest,
      ]);
      if (!isCurrent()) return;
      const assetById = new Map(
        nextAssets
          .filter((item) => MANAGED_TYPES.has(item.asset_type))
          .map((item) => [item.asset_id, item]),
      );
      for (const binding of nextBindings) {
        if (MANAGED_TYPES.has(binding.asset_type) && !assetById.has(binding.asset_id)) {
          assetById.set(binding.asset_id, binding);
        }
      }
      const managedAssets = [...assetById.values()];
      setAssets(managedAssets);
      setBindings(nextBindings);
      setSelected(new Set(nextBindings.map((binding) => binding.asset_id)));
      setLoadedAgentId(agentId);
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [agentId, enabled]);

  useEffect(() => {
    saveGeneration.current += 1;
    setSaving(false);
    void reload();
    return () => {
      requestGeneration.current += 1;
      saveGeneration.current += 1;
    };
  }, [reload]);

  const bindingByAsset = useMemo(() => new Map(bindings.map((binding) => [binding.asset_id, binding])), [bindings]);
  const readyForAgent = enabled && loadedAgentId === agentId;
  const visibleAssets = readyForAgent ? assets : [];

  const updateBinding = (assetId: string, patch: Partial<TencentdbFixedAsset>) => {
    setBindings((current) => {
      const asset = assets.find((item) => item.asset_id === assetId);
      if (!asset) return current;
      const existing = current.find((binding) => binding.asset_id === assetId);
      if (existing) {
        return current.map((binding) => binding.asset_id === assetId ? { ...binding, ...patch } : binding);
      }
      return [...current, {
        ...asset,
        injection_mode: asset.asset_type === 'skill' ? 'direct' : 'tool',
        priority: 0,
        ...patch,
      }];
    });
  };

  const save = async () => {
    if (!readyForAgent) return;
    const generation = ++saveGeneration.current;
    const isCurrent = () => (
      saveGeneration.current === generation
      && scope.current.agentId === agentId
      && scope.current.enabled === enabled
    );
    setSaving(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/meta/agent-fixed-asset/set', {
        bindings: [
          ...assets.filter((asset) => selected.has(asset.asset_id)).map((asset) => {
            const existing = bindingByAsset.get(asset.asset_id);
            return {
              asset_id: asset.asset_id,
              asset_type: asset.asset_type,
              injection_mode: existing?.injection_mode ?? (asset.asset_type === 'skill' ? 'direct' : 'tool'),
              priority: existing?.priority ?? 0,
            };
          }),
          ...bindings
            .filter((binding) => !MANAGED_TYPES.has(binding.asset_type))
            .map((binding) => ({
              asset_id: binding.asset_id,
              asset_type: binding.asset_type,
              injection_mode: binding.injection_mode,
              priority: binding.priority,
          })),
        ],
      });
      if (!isCurrent()) return;
      await tencentdbApi.reloadSkills();
      if (!isCurrent()) return;
      await reload();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  return (
    <Flexbox gap={12} data-testid="tencentdb-agent-loadout">
      <Flexbox horizontal justify="space-between" align="center">
        <div>
          <h3>知识注入规则</h3>
          <p>Skill、Wiki、CodeGraph 可注入知识；direct / summary / tool / reference 决定注入方式，priority 决定顺序。本页不负责模型、供应商或密钥。</p>
          <p>当前连接配置的 Agent：<strong>{agentId || '未配置'}</strong></p>
        </div>
        <Flexbox horizontal gap={8}>
          <Button size="small" aria-label="重试" onClick={() => void reload()} loading={loading} disabled={!enabled}>重试</Button>
          <Button size="small" type="primary" onClick={() => void save()} loading={saving} disabled={!readyForAgent}>保存注入规则</Button>
        </Flexbox>
      </Flexbox>
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {loading ? <Spin size="small" /> : null}
      {!loading && visibleAssets.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可配置的知识注入资产" /> : null}
      {visibleAssets.map((asset) => {
        const existing = bindingByAsset.get(asset.asset_id);
        const checked = selected.has(asset.asset_id);
        return (
          <Flexbox key={asset.asset_id} horizontal gap={10} align="center" style={{ borderBottom: '1px solid var(--ant-color-border)', padding: '8px 0' }}>
            <Checkbox
              checked={checked}
              disabled={!readyForAgent}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) {
                  next.add(asset.asset_id);
                  updateBinding(asset.asset_id, {});
                } else {
                  next.delete(asset.asset_id);
                }
                return next;
              })}
            >
              {asset.name || asset.asset_id}
            </Checkbox>
            <span>{asset.asset_type}</span>
            {checked ? (
              <>
                <Select
                  aria-label={`${asset.name || asset.asset_id} 注入模式`}
                  size="small"
                  disabled={!readyForAgent}
                  value={existing?.injection_mode ?? (asset.asset_type === 'skill' ? 'direct' : 'tool')}
                  options={INJECTION_MODES.map((mode) => ({ value: mode, label: mode }))}
                  onChange={(value) => updateBinding(asset.asset_id, { injection_mode: value })}
                  style={{ width: 110 }}
                />
                <InputNumber
                  aria-label={`${asset.name || asset.asset_id} 优先级`}
                  size="small"
                  min={0}
                  disabled={!readyForAgent}
                  value={existing?.priority ?? 0}
                  onChange={(value) => updateBinding(asset.asset_id, { priority: value ?? 0 })}
                  style={{ width: 85 }}
                />
              </>
            ) : null}
          </Flexbox>
        );
      })}
    </Flexbox>
  );
}
