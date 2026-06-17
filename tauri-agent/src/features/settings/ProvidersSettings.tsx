import { Icon } from '@lobehub/ui';
import { Checkbox, Input, Popconfirm, Select } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { invalidateAvailableModels } from './availableModelsCache';
import { defaultThinkingLevelMap, loadState, serializeState, type UiModel, type UiProvider } from './providerConfigAdapter';
import { invalidateProviderList } from './providerListCache';
import { PROVIDER_PRESETS, type ApiType } from './providerPresets';
import { SettingCard } from './SettingCard';

const API_OPTIONS: { value: ApiType; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Completions 兼容' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

/** 「1M」勾选：勾选 → contextWindow 写 1,000,000；不勾选 → 回落默认 200,000。 */
const CONTEXT_WINDOW_1M = 1_000_000;
const CONTEXT_WINDOW_DEFAULT = 200_000;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
  `,
  saveBtn: css`
    flex: 0 0 auto;
    padding: 5px 18px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    cursor: pointer;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
    font-size: 12px;
    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
  box: css`
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 220px);
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
    overflow: hidden;
  `,
  bodyRow: css`
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: 0 0 auto;
    padding: 10px 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  footerMsg: css`
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    width: 240px;
    flex: 0 0 240px;
    min-height: 0;
    padding: 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  listBuiltinScroll: css`
    min-height: 0;
    max-height: 280px;
    overflow-y: auto;
    margin-block-end: 4px;
  `,
  listCustomScroll: css`
    min-height: 0;
    max-height: 160px;
    overflow-y: auto;
    margin-block-end: 4px;
  `,
  listGroup: css`
    padding: 10px 10px 4px;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: ${cssVar.borderRadius};
    cursor: pointer;
    text-align: start;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  itemActive: css`
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
  `,
  itemName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    word-break: break-word;
    line-height: 1.35;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  `,
  detail: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 20px;
  `,
  group: css`
    margin-block-end: 22px;
    &:last-child {
      margin-block-end: 0;
    }
  `,
  groupTitle: css`
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
    margin-block-end: 10px;
  `,
  field: css`
    margin-block-end: 14px;
    max-width: 520px;
  `,
  label: css`
    font-size: 13px;
    color: ${cssVar.colorText};
    margin-block-end: 6px;
  `,
  desc: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    margin-block-end: 8px;
  `,
  modelRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-block-end: 8px;
    max-width: 720px;
  `,
  modelInput: css`
    flex: 1 1 0;
    min-width: 0;
  `,
  modelCheckbox: css`
    flex: 0 0 auto;
    white-space: nowrap;
  `,
  iconBtn: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    &:hover {
      color: ${cssVar.colorError};
      border-color: ${cssVar.colorError};
    }
  `,
  addBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    font-size: 12px;
    &:hover {
      color: ${cssVar.colorText};
      border-color: ${cssVar.colorBorderSecondary};
    }
    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
  modelActions: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,
  addProvider: css`
    flex: 0 0 auto;
    width: 100%;
    justify-content: center;
    margin-block-start: 8px;
  `,
  delBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: ${cssVar.colorError};
    cursor: pointer;
    font-size: 12px;
  `,
}));

export function ProvidersSettings() {
  const [providers, setProviders] = useState<UiProvider[]>([]);
  const [activeId, setActiveId] = useState('openai');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [cfg, settings] = await Promise.all([pi.getProviderConfig(), pi.getSettings()]);
      let ps = loadState(cfg.modelsJson, cfg.authJson, PROVIDER_PRESETS);
      // 一次性迁移：旧的 OPENAI_API_KEY（runtime-settings）→ auth.json，再从 settings 移除。
      const legacy = (settings.OPENAI_API_KEY ?? '').trim();
      if (legacy) {
        const openai = ps.find((p) => p.id === 'openai');
        if (openai && !openai.apiKey) {
          ps = ps.map((p) => (p.id === 'openai' ? { ...p, apiKey: legacy } : p));
          const { modelsJson, authJson } = serializeState(ps);
          await pi.setProviderConfig(modelsJson, authJson);
          invalidateProviderList();
          invalidateAvailableModels();
        }
        const rest = { ...settings };
        delete rest.OPENAI_API_KEY;
        await pi.setSettings(rest);
      }
      if (alive) setProviders(ps);
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
    };
  }, []);

  const active = providers.find((p) => p.id === activeId) ?? providers[0];

  // 任意改动 → 标记未保存。
  const touch = () => {
    setDirty(true);
    setSaved(false);
    setSyncInfo(null);
  };

  const patchActive = (patch: Partial<UiProvider>) => {
    touch();
    setProviders((ps) => ps.map((p) => (p.id === active?.id ? { ...p, ...patch } : p)));
  };

  const renameActiveId = (nextId: string) => {
    touch();
    const from = active?.id;
    setProviders((ps) => ps.map((p) => (p.id === from ? { ...p, id: nextId } : p)));
    setActiveId(nextId);
  };

  const addModel = () => patchActive({ models: [...(active?.models ?? []), { id: '' }] });
  const updateModel = (i: number, patch: Partial<UiModel>) =>
    patchActive({ models: (active?.models ?? []).map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const removeModel = (i: number) =>
    patchActive({ models: (active?.models ?? []).filter((_, idx) => idx !== i) });

  const addCustomProvider = () => {
    touch();
    const id = `custom-${Date.now().toString(36)}`;
    setProviders((ps) => [...ps, { id, name: '新供应商', builtIn: false, api: 'openai-completions', models: [] }]);
    setActiveId(id);
  };

  const removeProvider = () => {
    touch();
    const from = active?.id;
    setProviders((ps) => ps.filter((p) => p.id !== from));
    setActiveId('openai');
  };

  // 调供应商自身的列模型接口，把缺失的模型 id 追加进列表（保留已有项的显示名）。
  const syncModels = async () => {
    if (!active) return;
    setSyncing(true);
    setError(null);
    setSyncInfo(null);
    try {
      const ids = await pi.fetchProviderModels(
        active.baseUrl ?? '',
        active.apiKey ?? '',
        active.api ?? 'openai-completions',
      );
      const existing = new Set((active.models ?? []).map((m) => m.id));
      const added = ids.filter((id) => id && !existing.has(id)).map((id) => ({ id }));
      if (added.length > 0) {
        patchActive({ models: [...(active.models ?? []), ...added] });
        setSyncInfo(`已同步 ${added.length} 个新模型，记得保存`);
      } else {
        setSyncInfo(`未发现新模型（共 ${ids.length} 个，均已在列表）`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setSyncInfo(null);
    try {
      const { modelsJson, authJson } = serializeState(providers);
      const res = await pi.setProviderConfig(modelsJson, authJson);
      // 供应商配置已变更：定向失效缓存，让模型/供应商下拉重新读取。
      invalidateProviderList();
      invalidateAvailableModels();
      if (res.failed.length > 0) {
        setError(`部分工作区刷新失败：${res.failed.map((f) => f.workspace).join(', ')}`);
      } else {
        setSaved(true);
        setDirty(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const builtIns = providers.filter((p) => p.builtIn);
  const customs = providers.filter((p) => !p.builtIn);
  const preset = PROVIDER_PRESETS.find((p) => p.id === active?.id);
  const models = active?.models ?? [];

  const footerText = error
    ? error
    : syncInfo
      ? syncInfo
      : saved
        ? '已保存并生效'
        : dirty
          ? '写入 models.json / auth.json，热生效'
          : '';
  const footerColor = error ? cssVar.colorError : cssVar.colorSuccess;

  const renderItem = (p: UiProvider) => (
    <button
      key={p.id}
      type="button"
      data-testid={`prov-item-${p.id}`}
      title={p.name}
      className={cx(styles.item, p.id === active?.id && styles.itemActive)}
      onClick={() => {
        setActiveId(p.id);
        setError(null);
        setSyncInfo(null);
      }}
    >
      <span className={styles.itemName}>{p.name}</span>
      <span className={styles.dot} style={{ background: p.apiKey ? cssVar.colorSuccess : cssVar.colorFillSecondary }} />
    </button>
  );

  return (
    <div className={styles.root} data-testid="providers-settings">
      <SettingCard title="供应商配置">
        <div className={styles.box}>
          <div className={styles.bodyRow}>
            <nav className={styles.list}>
            <div className={styles.listGroup}>内置</div>
            <div className={styles.listBuiltinScroll} data-testid="prov-list-builtin">
              {builtIns.map(renderItem)}
            </div>
            <div className={styles.listGroup}>自定义</div>
            <div className={styles.listCustomScroll} data-testid="prov-list-custom">
              {customs.map(renderItem)}
            </div>
            <button
              type="button"
              data-testid="prov-add-provider"
              className={cx(styles.addBtn, styles.addProvider)}
              onClick={addCustomProvider}
            >
              <Icon icon={Plus} size={14} />
              添加供应商
            </button>
          </nav>

          <div className={styles.detail}>
            {!active ? (
              <span className={styles.desc}>加载中…</span>
            ) : (
              <>
                {!active.builtIn && (
                  <div className={styles.group}>
                    <div className={styles.groupTitle}>供应商</div>
                    <div className={styles.field}>
                      <div className={styles.label}>名称</div>
                      <Input data-testid="prov-name" value={active.name} onChange={(e) => patchActive({ name: e.target.value })} />
                    </div>
                    <div className={styles.field}>
                      <div className={styles.label}>Provider ID</div>
                      <div className={styles.desc}>唯一标识，用于 models.json 的 provider 键</div>
                      <Input data-testid="prov-id" value={active.id} onChange={(e) => renameActiveId(e.target.value)} />
                    </div>
                    <div className={styles.field}>
                      <div className={styles.label}>API 类型</div>
                      <Select
                        data-testid="prov-api"
                        value={active.api}
                        options={API_OPTIONS}
                        style={{ width: '100%' }}
                        onChange={(v) => patchActive({ api: v })}
                      />
                    </div>
                  </div>
                )}

                <div className={styles.group}>
                  <div className={styles.groupTitle}>凭据</div>
                  <div className={styles.field}>
                    <div className={styles.label}>API Key</div>
                    <Input.Password
                      data-testid="prov-apikey"
                      value={active.apiKey ?? ''}
                      placeholder="sk-..."
                      onChange={(e) => patchActive({ apiKey: e.target.value })}
                    />
                  </div>
                  {active.builtIn ? (
                    <div className={styles.desc}>Base URL 由 Pi 内置管理，无需填写。</div>
                  ) : (
                    <div className={styles.field}>
                      <div className={styles.label}>Base URL</div>
                      <Input
                        data-testid="prov-baseurl"
                        value={active.baseUrl ?? ''}
                        placeholder={preset?.baseUrlHint ?? 'https://...'}
                        onChange={(e) => patchActive({ baseUrl: e.target.value })}
                      />
                    </div>
                  )}
                </div>

                <div className={styles.group}>
                  <div className={styles.groupTitle}>{active.builtIn ? '自定义追加模型' : '模型'}</div>
                  <div className={styles.desc}>
                    {active.builtIn
                      ? '内置模型由 Pi 提供（配 Key 后自动出现在对话）；此处仅添加额外模型'
                      : '至少添加一个模型；ID 需与服务端一致'}
                  </div>
                  {models.map((m, i) => (
                    <div key={i} className={styles.modelRow}>
                      <Input
                        className={styles.modelInput}
                        data-testid={`prov-model-id-${i}`}
                        value={m.id}
                        placeholder="模型 ID"
                        onChange={(e) => updateModel(i, { id: e.target.value })}
                      />
                      <Input
                        className={styles.modelInput}
                        data-testid={`prov-model-name-${i}`}
                        value={m.name ?? ''}
                        placeholder="显示名（可选）"
                        onChange={(e) => updateModel(i, { name: e.target.value })}
                      />
                      <Checkbox
                        className={styles.modelCheckbox}
                        data-testid={`prov-model-reasoning-${i}`}
                        checked={!!m.reasoning}
                        onChange={(e) =>
                          updateModel(i, {
                            reasoning: e.target.checked ? true : undefined,
                            thinkingLevelMap: e.target.checked ? defaultThinkingLevelMap(active.api) : undefined,
                          })
                        }
                      >
                        推理
                      </Checkbox>
                      <Checkbox
                        className={styles.modelCheckbox}
                        data-testid={`prov-model-context1m-${i}`}
                        checked={(m.contextWindow ?? 0) >= CONTEXT_WINDOW_1M}
                        onChange={(e) =>
                          updateModel(i, {
                            contextWindow: e.target.checked
                              ? CONTEXT_WINDOW_1M
                              : CONTEXT_WINDOW_DEFAULT,
                          })
                        }
                      >
                        1M
                      </Checkbox>
                      <button
                        type="button"
                        data-testid={`prov-model-del-${i}`}
                        className={styles.iconBtn}
                        onClick={() => removeModel(i)}
                      >
                        <Icon icon={Trash2} size={14} />
                      </button>
                    </div>
                  ))}
                  <div className={styles.modelActions}>
                    <button type="button" data-testid="prov-add-model" className={styles.addBtn} onClick={addModel}>
                      <Icon icon={Plus} size={14} />
                      添加模型
                    </button>
                    {!active.builtIn && (
                      <button
                        type="button"
                        data-testid="prov-sync-models"
                        className={styles.addBtn}
                        disabled={syncing}
                        onClick={() => void syncModels()}
                      >
                        <Icon icon={RefreshCw} size={14} />
                        {syncing ? '同步中…' : '同步模型'}
                      </button>
                    )}
                  </div>
                </div>

                {!active.builtIn && (
                  <div className={styles.group}>
                    <Popconfirm
                      title="删除供应商"
                      description={`确定删除「${active.name}」吗？此操作不可撤销。`}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={removeProvider}
                    >
                      <button type="button" data-testid="prov-del-provider" className={styles.delBtn}>
                        <Icon icon={Trash2} size={14} />
                        删除供应商
                      </button>
                    </Popconfirm>
                  </div>
                )}
              </>
            )}
          </div>
          </div>
          <div className={styles.footer}>
            <span className={styles.footerMsg} style={{ color: footerColor }}>
              {footerText}
            </span>
            <button
              type="button"
              data-testid="prov-save"
              className={styles.saveBtn}
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
