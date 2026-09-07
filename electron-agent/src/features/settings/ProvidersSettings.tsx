import { Icon } from '@lobehub/ui';
import { Checkbox, Input, InputNumber, Popconfirm, Select } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { invalidateAvailableModels } from './availableModelsCache';
import { defaultThinkingLevelMap, loadState, serializeState, withDefaultUserAgent, type UiModel, type UiProvider } from './providerConfigAdapter';
import { invalidateProviderList } from './providerListCache';
import { PROVIDER_PRESETS, type ApiType } from './providerPresets';
import { ProviderDiagnostics } from './ProviderDiagnostics';
import { ModelSyncModal } from './ModelSyncModal';

const API_OPTIONS: { value: ApiType; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Completions 兼容' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  `,
  layout: css`
    display: flex;
    flex: 1;
    min-height: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
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
  list: css`
    display: flex;
    flex-direction: column;
    width: 220px;
    flex: 0 0 220px;
    min-height: 0;
    padding: 8px;
    background: ${cssVar.colorFillQuaternary};
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  listBuiltinScroll: css`
    min-height: 0;
    max-height: 280px;
    overflow-y: auto;
    margin-block-end: 4px;
  `,
  listCustomScroll: css`
    flex: 1;
    min-height: 0;
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
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `,
  detailBar: css`
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  detailScroll: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 20px;
  `,
  barMsg: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
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
  modelContext: css`
    flex: 0 0 auto;
    width: 132px;
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

/** 模型行 / 请求头行需要稳定的 React key：id/键可空可重复，故用客户端临时 uid（不落盘，保存前剥离）。 */
type EditModel = UiModel & { _uid: string };
/** 请求头在编辑态用有序数组表示（对象按键编辑时改键会乱序/丢焦点）；保存时转回 Record。 */
type HeaderRow = { key: string; value: string; _uid: string };
type EditProvider = Omit<UiProvider, 'models' | 'headers'> & { models: EditModel[]; headers: HeaderRow[] };

let rowUidSeq = 0;
const nextRowUid = (prefix: string) => `${prefix}-${(rowUidSeq++).toString(36)}`;
const attachUid = (m: UiModel): EditModel => ({ ...m, _uid: nextRowUid('mk') });
const toHeaderRows = (headers: Record<string, string> | undefined): HeaderRow[] =>
  Object.entries(headers ?? {}).map(([key, value]) => ({ key, value, _uid: nextRowUid('hk') }));
/** 编辑态请求头数组 → Record（跳过空键；同名后者覆盖）。同步模型探测请求与保存落盘共用此规则。 */
const headerRowsToRecord = (rows: HeaderRow[]): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const h of rows) {
    const key = h.key.trim();
    if (key) headers[key] = h.value;
  }
  return headers;
};
const withModelUids = (ps: UiProvider[]): EditProvider[] =>
  ps.map((p) => ({ ...p, models: p.models.map(attachUid), headers: toHeaderRows(p.headers) }));
const stripModelUids = (ps: EditProvider[]): UiProvider[] =>
  ps.map((p) => {
    const headers = headerRowsToRecord(p.headers);
    return {
      ...p,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      models: p.models.map((m) => {
        const copy: Partial<EditModel> = { ...m };
        delete copy._uid;
        return copy as UiModel;
      }),
    };
  });

/** 供应商 ID 合法字符：字母、数字、连字符、下划线（用作 models.json 的 provider 键）。 */
const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** 保存前校验所有供应商 ID：非空、字符合法、互不重复。返回首个错误信息，全部合法返回 null。 */
function validateProviderIds(ps: EditProvider[]): string | null {
  const seen = new Set<string>();
  for (const p of ps) {
    const id = p.id.trim();
    if (!id) return `供应商「${p.name || '未命名'}」的 Provider ID 不能为空`;
    if (!PROVIDER_ID_RE.test(id)) return `Provider ID「${id}」非法：仅允许字母、数字、连字符（-）、下划线（_）`;
    if (seen.has(id)) return `Provider ID「${id}」重复，请改为唯一值`;
    seen.add(id);
  }
  return null;
}

export function ProvidersSettings() {
  const [providers, setProviders] = useState<EditProvider[]>([]);
  const [activeId, setActiveId] = useState('openai');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
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
      if (alive) setProviders(withModelUids(ps));
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
    };
  }, []);

  const active = providers.find((p) => p.id === activeId) ?? providers[0];

  // 当前自定义供应商的 ID 是否非法（空 / 含非法字符 / 与其它供应商重复）——用于输入框实时标红。
  const activeIdInvalid =
    !!active &&
    !active.builtIn &&
    ((): boolean => {
      const id = active.id.trim();
      if (!id || !PROVIDER_ID_RE.test(id)) return true;
      return providers.filter((p) => p.id.trim() === id).length > 1;
    })();

  // 任意改动 → 标记未保存。
  const touch = () => {
    setDirty(true);
    setSaved(false);
    setSyncInfo(null);
  };

  const patchActive = (patch: Partial<EditProvider>) => {
    touch();
    setProviders((ps) => ps.map((p) => (p.id === active?.id ? { ...p, ...patch } : p)));
  };

  const renameActiveId = (nextId: string) => {
    touch();
    const from = active?.id;
    setProviders((ps) => ps.map((p) => (p.id === from ? { ...p, id: nextId } : p)));
    setActiveId(nextId);
  };

  const addModel = () => patchActive({ models: [...(active?.models ?? []), attachUid({ id: '' })] });
  const updateModel = (i: number, patch: Partial<UiModel>) =>
    patchActive({ models: (active?.models ?? []).map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const removeModel = (i: number) =>
    patchActive({ models: (active?.models ?? []).filter((_, idx) => idx !== i) });

  const addHeader = () =>
    patchActive({ headers: [...(active?.headers ?? []), { key: '', value: '', _uid: nextRowUid('hk') }] });
  const updateHeader = (i: number, patch: Partial<HeaderRow>) =>
    patchActive({ headers: (active?.headers ?? []).map((h, idx) => (idx === i ? { ...h, ...patch } : h)) });
  const removeHeader = (i: number) =>
    patchActive({ headers: (active?.headers ?? []).filter((_, idx) => idx !== i) });

  const addCustomProvider = () => {
    touch();
    const id = `custom-${Date.now().toString(36)}`;
    setProviders((ps) => [...ps, { id, name: '新供应商', builtIn: false, api: 'openai-completions', models: [], headers: [] }]);
    setActiveId(id);
  };

  // 持久化给定供应商列表：写 models.json/auth.json + 热更各 workspace（switch_session 重建 runtime）。
  // 接收显式 list（而非读 state）以便删除后用「删除后的列表」立即落盘，绕开 setState 的异步。
  const persist = async (list: EditProvider[]) => {
    const idErr = validateProviderIds(list);
    if (idErr) {
      setError(idErr);
      setSaved(false);
      setSyncInfo(null);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    setSyncInfo(null);
    try {
      const { modelsJson, authJson } = serializeState(stripModelUids(list));
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

  const removeProvider = () => {
    const from = active?.id;
    const next = providers.filter((p) => p.id !== from);
    setProviders(next);
    setActiveId('openai');
    // 删除是明确的破坏性动作（已二次确认），直接落盘 + 热更，无需再手动点保存。
    void persist(next);
  };

  // 同步模型弹窗确认后：把勾选且尚未存在的模型 id 追加进列表（去重，保留已有项）。
  const addSyncedModels = (ids: string[]) => {
    const existing = new Set((active?.models ?? []).map((m) => m.id));
    const added = ids.filter((id) => id && !existing.has(id)).map((id) => attachUid({ id }));
    if (added.length === 0) {
      setSyncInfo('所选模型均已在列表');
      return;
    }
    patchActive({ models: [...(active?.models ?? []), ...added] });
    setSyncInfo(`已添加 ${added.length} 个模型，记得保存`);
  };

  const save = () => persist(providers);

  const builtIns = providers.filter((p) => p.builtIn);
  const customs = providers.filter((p) => !p.builtIn);
  const preset = PROVIDER_PRESETS.find((p) => p.id === active?.id);
  const models = active?.models ?? [];
  const modelIds = models.map((m) => m.id.trim()).filter(Boolean);

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

  const renderItem = (p: EditProvider) => (
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
      <div className={styles.layout}>
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
          <div className={styles.detailBar}>
            <span className={styles.barMsg} style={{ color: footerColor }}>
              {footerText}
            </span>
            {active && !active.builtIn ? (
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
            ) : null}
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
          <div className={styles.detailScroll}>
            {!active ? (
              <span className={styles.desc}>加载中…</span>
            ) : (
              <>
                {!active.builtIn && (
                  <div className={styles.group}>
                    <div className={styles.groupTitle}>供应商</div>
                    <div className={styles.field}>
                      <div className={styles.label}>名称</div>
                      <Input data-testid="prov-name" variant="filled" value={active.name} onChange={(e) => patchActive({ name: e.target.value })} />
                    </div>
                    <div className={styles.field}>
                      <div className={styles.label}>Provider ID</div>
                      <div className={styles.desc}>唯一标识，用于 models.json 的 provider 键</div>
                      <Input
                        data-testid="prov-id"
                        status={activeIdInvalid ? 'error' : undefined}
                        value={active.id}
                        variant="filled"
                        onChange={(e) => renameActiveId(e.target.value)}
                      />
                    </div>
                    <div className={styles.field}>
                      <div className={styles.label}>API 类型</div>
                      <Select
                        data-testid="prov-api"
                        value={active.api}
                        options={API_OPTIONS}
                        style={{ width: '100%' }}
                        variant="filled"
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
                      variant="filled"
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
                        variant="filled"
                        onChange={(e) => patchActive({ baseUrl: e.target.value })}
                      />
                      {active.baseUrl &&
                        (active.api === 'openai-completions' || active.api === 'openai-responses') &&
                        !/\/v\d+[a-z]*\/?$/i.test(active.baseUrl) && (
                          <div style={{ fontSize: 12, color: cssVar.colorWarning, marginTop: 4 }}>
                            OpenAI 兼容接口通常需要以 /v1 结尾，例如 {active.baseUrl.replace(/\/+$/, '')}/v1
                          </div>
                        )}
                    </div>
                  )}
                </div>

                {!active.builtIn && (
                  <div className={styles.group}>
                    <div className={styles.groupTitle}>自定义请求头</div>
                    <div className={styles.desc}>
                      附加到该供应商的所有请求；留空则仅自动注入中性 User-Agent（规避代理 WAF 按官方 SDK UA 拦截）
                    </div>
                    {active.headers.map((h, i) => (
                      <div key={h._uid} className={styles.modelRow}>
                        <Input
                          className={styles.modelInput}
                          data-testid={`prov-header-key-${i}`}
                          value={h.key}
                          placeholder="Header 名（如 X-Api-Key）"
                          variant="filled"
                          onChange={(e) => updateHeader(i, { key: e.target.value })}
                        />
                        <Input
                          className={styles.modelInput}
                          data-testid={`prov-header-value-${i}`}
                          value={h.value}
                          placeholder="值"
                          variant="filled"
                          onChange={(e) => updateHeader(i, { value: e.target.value })}
                        />
                        <button
                          type="button"
                          data-testid={`prov-header-del-${i}`}
                          className={styles.iconBtn}
                          onClick={() => removeHeader(i)}
                        >
                          <Icon icon={Trash2} size={14} />
                        </button>
                      </div>
                    ))}
                    <button type="button" data-testid="prov-add-header" className={styles.addBtn} onClick={addHeader}>
                      <Icon icon={Plus} size={14} />
                      添加请求头
                    </button>
                  </div>
                )}

                <div className={styles.group}>
                  <div className={styles.groupTitle}>{active.builtIn ? '自定义追加模型' : '模型'}</div>
                  <div className={styles.desc}>
                    {active.builtIn
                      ? '内置模型由 Pi 提供（配 Key 后自动出现在对话）；此处仅添加额外模型'
                      : '至少添加一个模型；ID 需与服务端一致'}
                  </div>
                  {models.map((m, i) => (
                    <div key={m._uid} className={styles.modelRow}>
                      <Input
                        className={styles.modelInput}
                        data-testid={`prov-model-id-${i}`}
                        value={m.id}
                        placeholder="模型 ID"
                        variant="filled"
                        onChange={(e) => updateModel(i, { id: e.target.value })}
                      />
                      <Input
                        className={styles.modelInput}
                        data-testid={`prov-model-name-${i}`}
                        value={m.name ?? ''}
                        placeholder="显示名（可选）"
                        variant="filled"
                        onChange={(e) => updateModel(i, { name: e.target.value })}
                      />
                      <Checkbox
                        className={styles.modelCheckbox}
                        data-testid={`prov-model-reasoning-${i}`}
                        checked={!!m.reasoning}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          updateModel(i, {
                            reasoning: checked ? true : undefined,
                            thinkingLevelMap: checked ? defaultThinkingLevelMap(active.api, m.id) : undefined,
                            // anthropic 推理模型默认开启自适应思考（发 effort）；其余 API 用不到此字段。
                            forceAdaptiveThinking:
                              checked && active.api === 'anthropic-messages' ? true : undefined,
                          });
                        }}
                      >
                        推理
                      </Checkbox>
                      {active.api === 'anthropic-messages' && m.reasoning ? (
                        <Checkbox
                          className={styles.modelCheckbox}
                          data-testid={`prov-model-adaptive-${i}`}
                          checked={m.forceAdaptiveThinking ?? true}
                          onChange={(e) => updateModel(i, { forceAdaptiveThinking: e.target.checked })}
                          title="开启后向 Anthropic 发送 effort(推理强度)；老模型 claude 3.7/4.0/4.5 不支持自适应思考，请关闭改用预算思考"
                        >
                          自适应
                        </Checkbox>
                      ) : null}
                      <InputNumber
                        className={styles.modelContext}
                        data-testid={`prov-model-context-${i}`}
                        value={m.contextWindow}
                        placeholder="上下文窗口"
                        min={0}
                        step={1000}
                        controls={false}
                        variant="filled"
                        title="上下文窗口（tokens），如 200000 / 1000000"
                        formatter={(v) => (v ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '')}
                        parser={(v) => (v ? Number(v.replace(/,/g, '')) : 0)}
                        onChange={(v) =>
                          updateModel(i, { contextWindow: typeof v === 'number' ? v : undefined })
                        }
                      />
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
                        onClick={() => setSyncOpen(true)}
                      >
                        <Icon icon={RefreshCw} size={14} />
                        同步模型
                      </button>
                    )}
                  </div>
                </div>

                {!active.builtIn && (
                  <ProviderDiagnostics
                    hasApiKey={Boolean(active.apiKey?.trim())}
                    modelIds={modelIds}
                    providerId={active.id}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {active && !active.builtIn ? (
        <ModelSyncModal
          open={syncOpen}
          baseUrl={active.baseUrl ?? ''}
          apiKey={active.apiKey ?? ''}
          api={active.api ?? 'openai-completions'}
          // 同步模型是探测请求，需带上与真实对话请求一致的自定义 headers（含中性 User-Agent 兜底），
          // 否则代理站 WAF 可能因请求「不像真实客户端」拒绝，表现为看似密钥无效的 401。
          headers={withDefaultUserAgent(headerRowsToRecord(active.headers))}
          existingIds={models.map((m) => m.id).filter(Boolean)}
          onClose={() => setSyncOpen(false)}
          onConfirm={addSyncedModels}
        />
      ) : null}
    </div>
  );
}
