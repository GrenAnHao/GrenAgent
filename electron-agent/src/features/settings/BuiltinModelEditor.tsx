import { Button, Tooltip } from 'antd';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useState } from 'react';
import { pi, type BuiltinModelInfo } from '../../lib/pi';
import { parseModelKey } from '../chat/input/modelUtils';
import { isModelHidden, useModelVisibilityStore } from '../../stores/modelVisibilityStore';
import { advancedOverrideKeys, builtinModelDraft, patchBuiltinModel, type BuiltinOverride } from './builtinModelOverrides';
import { ProviderModelCard } from './ProviderModelCard';
import type { UiModel, UiProvider } from './providerConfigAdapter';

const styles = createStaticStyles(({ css }) => ({
  root: css`margin-block-end:22px;min-width:0;`,
  title: css`font-size:14px;font-weight:600;margin-block-end:8px;`,
  help: css`font-size:12px;line-height:1.6;color:${cssVar.colorTextDescription};margin-block:6px 12px;`,
  toolbar: css`display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-block:6px;`,
  status: css`font-size:12px;color:${cssVar.colorTextDescription};margin-inline-end:auto;`,
  actions: css`display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;`,
  modified: css`font-size:11px;color:${cssVar.colorTextTertiary};white-space:nowrap;margin-inline-end:4px;`,
}));

/** One stable row owns its expansion and transient input text; committed fields remain in provider state. */
function BuiltinModelRow({ base, current, hidden, onChange, onVisibility }: {
  base: BuiltinModelInfo;
  current: BuiltinOverride;
  hidden: boolean;
  onChange: (override: BuiltinOverride | undefined) => void;
  onVisibility: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState<Partial<UiModel>>({});
  const encodedId = encodeURIComponent(base.id);
  const index = `builtin-${encodedId}`;
  const effective = builtinModelDraft(base, current);
  const model = { ...effective, ...raw,
    ...(raw.cost ? { cost: { ...effective.cost, ...raw.cost } } : {}),
    ...(raw.compat ? { compat: { ...effective.compat, ...raw.compat } } : {}),
  };
  const advancedValue = Object.fromEntries(advancedOverrideKeys.filter((key) => Object.hasOwn(current, key)).map((key) => [key, current[key]]));
  const updateModel = (patch: Partial<UiModel>) => {
    // Cache only actual text/number input leaves, never booleans, maps or derived aliases.
    const fields: Partial<UiModel> = { ...raw };
    for (const key of ['name', 'contextWindow', 'maxTokens'] as const) {
      if (Object.hasOwn(patch, key)) Object.assign(fields, { [key]: patch[key] });
    }
    if (patch.cost) {
      const changed = Object.fromEntries(Object.entries(patch.cost).filter(([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(model.cost?.[key as keyof NonNullable<UiModel['cost']>])));
      fields.cost = { ...fields.cost, ...changed };
    }
    if (Object.hasOwn(patch, 'compat')) {
      const inputs = { ...fields.compat };
      for (const key of new Set([...Object.keys(model.compat ?? {}), ...Object.keys(patch.compat ?? {})])) {
        const value = patch.compat?.[key];
        const previous = model.compat?.[key];
        if (key === 'thinkingFormat' || value === previous) continue;
        if (typeof value === 'string' || typeof value === 'number' ||
          (value === undefined && (typeof previous === 'string' || typeof previous === 'number'))) inputs[key] = value;
      }
      fields.compat = inputs;
    }
    setRaw(fields);
    onChange(patchBuiltinModel(base, current, patch));
  };

  const visibilityLabel = hidden ? '显示模型' : '隐藏模型';
  const actions = <span className={styles.actions}>
    {Object.keys(current).some((key) => !key.startsWith('_')) ?
      <span className={styles.modified} data-testid={`prov-builtin-status-${encodedId}`}>已修改</span> : null}
    <Tooltip title={visibilityLabel}>
      <Button type="text" size="small" shape="circle" data-testid={`prov-builtin-visibility-${encodedId}`}
        aria-label={visibilityLabel} aria-pressed={hidden} onClick={onVisibility}
        icon={hidden ? <EyeOff size={15} /> : <Eye size={15} />} />
    </Tooltip>
    {Object.keys(current).length || Object.keys(raw).length ? <Tooltip title="恢复参数默认值">
      <Button type="text" size="small" shape="circle" data-testid={`prov-builtin-reset-${encodedId}`}
        aria-label="恢复默认" icon={<RotateCcw size={14} />}
        onClick={() => { setRaw({}); onChange(undefined); }} />
    </Tooltip> : null}
  </span>;

  return <div data-testid={`prov-builtin-row-${encodedId}`} data-model-id={base.id} data-hidden={hidden}>
    <ProviderModelCard index={index} model={model} api={base.api} expanded={expanded}
      onToggle={() => setExpanded((value) => !value)} lockedIdentity headerActions={actions}
      advancedValue={advancedValue} inherited={base} onChange={updateModel} />
  </div>;
}

export function BuiltinModelEditor({ provider, onChange }: {
  provider: Omit<UiProvider, 'headers'>;
  onChange: (overrides: NonNullable<UiProvider['modelOverrides']>) => void;
}) {
  const [catalog, setCatalog] = useState<BuiltinModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const hidden = useModelVisibilityStore((state) => state.hidden);
  const setHidden = useModelVisibilityStore((state) => state.setHidden);
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setError(null);
    void pi.listBuiltinModels(provider.id).then((models) => {
      if (alive) setCatalog(models);
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [provider.id, revision]);

  const replacements = new Set(provider.models.map((model) => model.id.trim()));
  const models = (catalog ?? []).filter((model) => !replacements.has(model.id));
  const unlistedHidden = hidden.map(parseModelKey).filter((model) =>
    model.provider === provider.id && !models.some((entry) => entry.id === model.id));
  const changeVisibility = (id: string, value: boolean) => {
    try { setHidden(provider.id, id, value); setVisibilityError(null); }
    catch (reason) { setVisibilityError(`无法保存模型显示偏好：${reason instanceof Error ? reason.message : String(reason)}`); }
  };

  return <section className={styles.root} data-testid="prov-builtin-models">
    <div className={styles.title}>内置模型</div>
    <p className={styles.help}>直接编辑模型参数，未修改的字段继承 Pi 默认值。</p>
    <p className={styles.help}>眼睛图标控制选模列表中的显示，立即保存；参数修改仍需点击页面「保存」。</p>
    {visibilityError ? <div role="alert" className={styles.help}>{visibilityError}</div> : null}
    {error ? <div role="alert" className={styles.help}>{error} <Button size="small" data-testid="prov-builtin-retry" onClick={() => setRevision((value) => value + 1)}>重试加载目录</Button></div> : null}
    {!error && catalog === null ? <div className={styles.help}>加载内置目录…</div> : null}
    {!error && catalog !== null && !models.length ? <div className={styles.help}>{replacements.size ? '当前目录模型已由同 ID 自定义条目替换，请在下方编辑。' : '当前供应商没有 SDK 内置聊天模型。'}</div> : null}
    {!error ? models.map((base) => <BuiltinModelRow key={`${provider.id}\0${base.id}`} base={base}
      current={provider.modelOverrides?.[base.id] ?? {}} hidden={isModelHidden(hidden, provider.id, base.id)}
      onVisibility={() => changeVisibility(base.id, !isModelHidden(hidden, provider.id, base.id))}
      onChange={(override) => {
        const next = { ...provider.modelOverrides };
        if (override === undefined) delete next[base.id];
        else next[base.id] = override;
        onChange(next);
      }} />) : null}
    {unlistedHidden.map((model) => <div key={model.id} className={styles.toolbar}>
      <span className={styles.status}>{model.id} · 已隐藏（同 ID 替换或不在当前目录）</span>
      <Button size="small" data-testid={`prov-builtin-restore-${encodeURIComponent(model.id)}`} onClick={() => changeVisibility(model.id, false)}>恢复显示</Button>
    </div>)}
    <p className={styles.help}>目录为 SDK 内置基线，可能与运行时更新后的目录不同，不代表账号权限。恢复参数不改变显示偏好；隐藏不会切换当前会话。</p>
  </section>;
}
