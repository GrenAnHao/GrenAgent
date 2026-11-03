import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import { Icon, Popover } from '@lobehub/ui';
import { Segmented, Tooltip } from 'antd';
import { FastModeToggle, FastModeError } from './FastModeToggle';
import { useModelMessages } from '../../../../lib/modelMessages';
import { createStaticStyles, cssVar, cx, useThemeMode } from 'antd-style';
import { Brain, Check, Cpu, Image, Search, Zap } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { loadProviderList } from '../../../settings/providerListCache';
import {
  useAvailableModelsState,
  loadAvailableModels,
  getCachedAvailableModels,
} from '../../../settings/availableModelsCache';
import { modelKey, parseModelKey, type ModelInfo } from '../modelUtils';
import { selectedModelLabel } from '../sessionModel';
import { coerceVisibleLevel, levelDisplayLabel, levelOptions, mergeModelCatalog, type RpcModel } from '../thinkingLevels';
import { useComposerCompact } from '../composerCompact';
import { readComposerOwnerKey, useComposerOwnerKey, useComposerOwnerPreferences } from '../composerOwner';
import { useSessionPreferencesStore } from '../../../../stores/sessionPreferencesStore';
import { ensureComposerPreferences, saveProjectDefaults, writeComposerPreference } from './composerPreferences';
import { emptyPreferences, type SessionPreferences } from '../../../../lib/sessionPreferences';

/**
 * ModelThinkingAction —「模型 + 推理档位」合并控件（替代原先并列的 ModelAction + ThinkingAction）。
 *
 * 完全自定义的下拉（base-ui Popover + 自绘面板），不用 base-ui Select —— Select 的单选 + 搜索会
 * 「输入即跳/选错」、且把选中项过滤掉时回调 null 崩溃。这里全自控：
 *  - 顶部搜索框：自己按 名字/id/供应商 过滤，输入只筛列表、绝不动当前选中；
 *  - 分组模型列表：当前模型主色 + 对勾；
 *  - 底部档位分段：当前推理模型的档位，点选即切、面板不关；
 *  - 选模型也不关面板，可接着调档位，一次打开搞定（对齐 Cursor）。
 *
 * 数据来源：会话/草稿的 `session-preferences` 快照（见 stores/sessionPreferencesStore）。
 *   - 恢复只读：显示快照里的保存值，绝不调用 setter 写回；
 *   - 换模型只改模型字段，不动思考/模式/审查的保存偏好；
 *   - 保存值是用户请求的档位；有效档位按当前模型能力单独计算（非推理 → off），切回推理模型恢复原值；
 *   - 草稿只写本地偏好，不动项目默认、不碰任何已落盘会话；
 *   - 面板底部有明确的「设为项目默认」入口，只写 workspace 默认，失败可见。
 */

const styles = createStaticStyles(({ css }) => ({
  // 与左侧 Mode / Approval（@lobehub/ui base-ui Select）完全同源：base-ui Select 默认 variant 是
  // isDarkMode ? 'filled' : 'outlined'（实测自其 Select.mjs）。这里照搬同一套尺寸/边框/背景/hover
  // token，base 只放通用尺寸，明暗两档由 triggerFilled / triggerOutlined 按主题切，深浅都对齐。
  trigger: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    max-width: 240px;
    min-height: 24px;
    padding: 0 2px;
    border-radius: ${cssVar.borderRadius};
    color: ${cssVar.colorText};
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
    transition: all 0.15s;
    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  `,
  // 深色默认档：filled（灰底、透明边，hover 加深背景）。
  triggerFilled: css`
    border: none;
    background: transparent;
    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  triggerOutlined: css`
    border: none;
    background: transparent;
    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  triggerName: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  triggerLevel: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
  `,
  panel: css`
    width: 300px;
    max-width: calc(100vw - 24px);
  `,
  searchBar: css`
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px;
    padding: 5px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextTertiary};
  `,
  searchInput: css`
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    color: ${cssVar.colorText};
    font-size: 13px;
    &::placeholder {
      color: ${cssVar.colorTextQuaternary};
    }
  `,
  list: css`
    max-height: 300px;
    overflow-y: auto;
    padding: 0 6px 6px;
  `,
  groupLabel: css`
    padding: 6px 6px 2px;
    font-size: 10px;
    font-weight: 600;
    color: ${cssVar.colorTextTertiary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorText};
    font-size: 13px;
    text-align: start;
    cursor: pointer;
    transition: background 0.12s;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  itemName: css`
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  capabilities: css`
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: ${cssVar.colorTextTertiary};
    & > span { display: inline-flex; }
  `,
  levelRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    & .ant-segmented { flex: 1; min-width: 0; width: 0; }
    & .ant-segmented-item-label { min-width: 0; padding-inline: 3px; }
  `,
  check: css`
    flex: none;
    margin-inline-start: auto;
    color: ${cssVar.colorText};
  `,
  empty: css`
    padding: 18px 8px;
    text-align: center;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  footer: css`
    margin: 0 6px;
    padding: 8px 6px 6px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  footerLabel: css`
    display: block;
    margin-block-end: 6px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  levelSeg: css`
    width: 100%;
    font-size: 12px;
  `,
  defaults: css`
    display: block;
    width: 100%;
    margin-block-start: 8px;
    padding: 4px 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    text-align: start;
    cursor: pointer;
    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
    }
    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  `,
}));

interface RpcSessionState {
  thinkingLevel?: string;
  model?: RpcModel | null;
}

export function resetModelThinkingCacheForTests(): void {
  // 旧的 ws/session 缓存已移除；保留导出供现有 UI 场景的「重载」按钮调用（现在只清偏好缓存）。
  useSessionPreferencesStore.setState({ byOwner: {}, defaultsByWorkspace: {} });
}

/** 当前输入栏 owner 的模型（草稿读本地偏好，会话读快照缓存）。 */
export function peekComposerModel(workspace: string): { provider: string; id: string } | null {
  const ownerKey = readComposerOwnerKey(workspace);
  const model = useSessionPreferencesStore.getState().peek(ownerKey)?.model;
  if (!model?.provider || !model.id) return null;
  return { provider: model.provider, id: model.id };
}

/** 草稿首发前读输入栏推理档位（保存值）。 */
export function peekComposerLevel(workspace: string): string | null {
  const ownerKey = readComposerOwnerKey(workspace);
  return useSessionPreferencesStore.getState().peek(ownerKey)?.thinkingLevel ?? null;
}

/** 首发送之后保留兼容导出：偏好过户由 sessionPreferencesStore.adopt 负责，这里不再改缓存。 */
export function commitComposerModelToSession(
  _workspace: string,
  _sessionPath: string,
  _selected?: { provider: string; id: string } | null,
  _level?: string | null,
): void {}

/** 点「新建对话」时无需清理：新草稿有独立 owner key，自带默认快照。 */
export function clearComposerUserPick(_workspace: string): void {}

export default function ModelThinkingAction() {
  const messages = useModelMessages();
  const { workspace, workspaceReady } = useAgentStoreContext();
  const ownerKey = useComposerOwnerKey(workspace);
  const { preferences, loading: preferencesLoading, error: preferencesError } = useComposerOwnerPreferences(workspace);
  const { message } = App.useApp();
  // isDarkMode 与 base-ui 同源（antd-style）：trigger 据此切 filled/outlined，和左侧 Mode/Approval 一致。
  const { isDarkMode } = useThemeMode();
  const compact = useComposerCompact();
  // 选中态用「中性提亮」而非品牌主色（主色在深灰主题里太跳）：底用中性半透明填充，文字用正文色。
  // 走 cssVar 的 var() 引用即可 —— ThemeBridge 已把 --ant-* 变量表挂到 <html>，portal 里同样能继承。
  const selFg = cssVar.colorText;

  const { models: polledModels, loading: modelsLoading } = useAvailableModelsState(
    workspaceReady ? workspace : undefined,
  );
  const [models, setModels] = useState<ModelInfo[]>(() => getCachedAvailableModels(workspace) ?? []);
  const [providerNames, setProviderNames] = useState<Map<string, string>>(new Map());

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [savingDefaults, setSavingDefaults] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);
  const [localReady, setLocalReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const savedModel = preferences.model ?? null;
  const value = savedModel ? modelKey(savedModel.provider, savedModel.id) : '';
  // 列表里没有当前模型时，保留保存值（失效模型不能被静默清掉）。
  const displayModel: RpcModel | null = useMemo(() => {
    if (!savedModel) return null;
    const info = models.find((item) => item.provider === savedModel.provider && item.id === savedModel.id);
    return mergeModelCatalog(
      {
        provider: savedModel.provider,
        id: savedModel.id,
        name: info?.name,
        api: info?.api,
        reasoning: info?.reasoning,
        thinkingLevelMap: info?.thinkingLevelMap,
      },
      models,
    );
  }, [models, savedModel?.provider, savedModel?.id]);

  const [fastSaving, setFastSaving] = useState(false);
  const [fastFailed, setFastFailed] = useState(false);
  // 每次 Fast 写入一个 attempt；只有「仍属于当前 owner 且仍是最后一次点击」的回执能改本地态。
  // A 写 pending → 切 B → B 写 pending 时，A 迟到的失败不能清掉 B 的 saving、也不能在 B 弹错。
  const fastAttempt = useRef(0);
  const fastOwner = useRef(ownerKey);

  // 进入 owner / 工作区就绪时加载快照。只读，不写会话。
  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    setLocalReady(false);
    setLoadFailed(false);
    void ensureComposerPreferences(workspace, ownerKey).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadFailed(true);
        message.error(result.message ? `无法读取会话偏好：${result.message}` : '无法读取会话偏好，请重试');
        return;
      }
      setLocalReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady, ownerKey]);

  useEffect(() => {
    if (polledModels && polledModels.length > 0) setModels(polledModels);
  }, [polledModels]);

  // 供应商显示名：与模型列表/会话状态分开加载。
  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    void loadProviderList(true)
      .then((list) => {
        if (!cancelled) setProviderNames(new Map(list.map((p) => [p.id, p.name])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady]);

  // 换 owner：作废在途 attempt，旧的失败提示/loading 不能跟着显示在另一个会话上。
  // 卸载同样作废：布局切换会整块卸下输入栏，迟到的失败不能 toast 到新页面。
  useEffect(() => {
    fastOwner.current = ownerKey;
    fastAttempt.current++;
    setFastFailed(false);
    setFastSaving(false);
    return () => {
      fastAttempt.current++;
    };
  }, [ownerKey]);

  // 打开下拉时聚焦搜索框。
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const onWriteError = useCallback(
    (result: { message?: string; error?: string }) => {
      if (result.message) message.error(result.message);
      else message.error('会话偏好保存失败，已保留原值');
    },
    [message],
  );

  // 选模型：只改模型字段；不改其它三项保存偏好，也不顺手改思考档位。
  const onChangeModel = (key: string) => {
    if (!key) return;
    loadSeq.current++;
    const { provider, id } = parseModelKey(key);
    if (!provider || !id) return;
    void writeComposerPreference(workspace, ownerKey, 'model', { provider, id }).then((result) => {
      if (result.ok) return;
      if (result.error === 'unavailable') onWriteError({ message: '该模型当前不可用，请选择其它模型' });
      else if (result.error !== 'loading') onWriteError(result);
    });
  };

  // 会话 Fast：只改本 owner 的 fastMode。保存失败可见回滚，不动其它四项。
  const onToggleFast = (next: boolean) => {
    if (fastSaving) return;
    const attempt = ++fastAttempt.current;
    const owner = ownerKey;
    setFastSaving(true);
    setFastFailed(false);
    void writeComposerPreference(workspace, ownerKey, 'fastMode', next).then((result) => {
      // 已切走（含 A→B→A 的旧 attempt）或已有更新点击：这次结果只留在数据层。
      if (fastOwner.current !== owner || fastAttempt.current !== attempt) return;
      setFastSaving(false);
      if (result.ok) return;
      setFastFailed(true);
      if (result.error !== 'loading') onWriteError(result);
    });
  };

  // 选档位：只改思考偏好（保存值）。不关面板。
  const onPickLevel = (next: string) => {
    if (!next) return;
    loadSeq.current++;
    void writeComposerPreference(workspace, ownerKey, 'thinkingLevel', next).then((result) => {
      if (!result.ok && result.error !== 'loading') onWriteError(result);
      // effectiveOnly：模型钳制了有效档位，保存值不变，不弹错。
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setQuery('');
    if (!next) return;
    void loadAvailableModels(workspace, true).then((m) => {
      if (m.length > 0) setModels(m);
    });
    void loadProviderList(true)
      .then((list) => setProviderNames(new Map(list.map((p) => [p.id, p.name]))))
      .catch(() => {});
  };

  const onSaveDefaults = () => {
    if (savingDefaults) return;
    setSavingDefaults(true);
    void saveProjectDefaults(workspace, preferences).then((result) => {
      setSavingDefaults(false);
      if (result.ok) {
        message.success('已设为项目默认（只影响新对话）');
        return;
      }
      message.error(result.message ? `保存项目默认失败：${result.message}` : '保存项目默认失败，请重试');
    });
  };

  // 搜索过滤：按 模型名 / id / 供应商名 匹配（输入只筛列表，不动当前选中）。
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: ModelInfo) => {
      if (!q) return true;
      const name = (m.name ?? m.id).toLowerCase();
      const prov = (providerNames.get(m.provider) ?? m.provider).toLowerCase();
      return name.includes(q) || m.id.toLowerCase().includes(q) || prov.includes(q);
    };
    const groups: { provider: string; items: ModelInfo[] }[] = [];
    const index = new Map<string, number>();
    for (const m of models) {
      if (!match(m)) continue;
      let gi = index.get(m.provider);
      if (gi === undefined) {
        gi = groups.length;
        index.set(m.provider, gi);
        groups.push({ provider: m.provider, items: [] });
      }
      groups[gi].items.push(m);
    }
    return groups;
  }, [models, providerNames, query]);

  // 档位跟当前模型列表走，不跟会话里那份选中时的快照。
  const catalogModel = mergeModelCatalog(displayModel, models);
  const currentLevels = levelOptions(catalogModel);
  // 保存值是用户请求的档位；有效档位按当前模型能力算（非推理模型 → off），但不覆盖保存值。
  const savedLevel = preferences.thinkingLevel;
  const effectiveLevel = coerceVisibleLevel(catalogModel, savedLevel) ?? savedLevel ?? 'off';
  // 模型失效（目录里没有）时避免把有效档位算成 off 而误导用户。
  const modelMissing = Boolean(savedModel) && models.length > 0 && !models.some(
    (item) => item.provider === savedModel?.provider && item.id === savedModel?.id,
  );
  const activeLevel = modelMissing ? savedLevel ?? effectiveLevel : effectiveLevel;
  const showsThinking = !modelMissing && currentLevels.some((o) => o.value !== 'off');
  const selectedInfo = models.find((item) => modelKey(item.provider, item.id) === value);
  const showsFast = selectedInfo?.fast === true;
  // Fast 是第五项会话偏好：绑定当前 owner 的保存值，不再看按模型共享的全局 store。
  const fastSaved = preferences.fastMode === true;
  const activeFast = showsFast && fastSaved;

  const currentLevelLabel = levelDisplayLabel(String(activeLevel));
  // 保存值与有效值分开：模型不支持 / 映射隐藏时，档位控件会显示回退值（或整段隐藏）。
  // 这里只派生一句说明，不调用 setter、不改保存值。
  const levelFallback = Boolean(savedLevel) && !modelMissing && String(savedLevel) !== String(activeLevel);
  const levelFallbackText = levelFallback
    ? `已保存「${levelDisplayLabel(String(savedLevel))}」；当前模型仅生效「${levelDisplayLabel(String(activeLevel))}」，切回支持的模型会恢复`
    : '';
  const selectedModelName = value ? selectedModelLabel(value, models) || parseModelKey(value).id : '';
  const triggerTitle = selectedModelName + (activeFast ? ` · ${messages.fastActive}` : '');
  const loading = !localReady || preferencesLoading || (!value && modelsLoading && models.length === 0);
  const disabled = !workspaceReady || loadFailed || loading || models.length === 0;

  const panel = (
    <div className={styles.panel}>
      <div className={styles.searchBar}>
        <Icon icon={Search} size={14} />
        <input
          ref={searchRef}
          className={styles.searchInput}
          value={query}
          placeholder="搜索模型"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      <div className={styles.list}>
        {filteredGroups.length === 0 ? (
          <div className={styles.empty}>无匹配模型</div>
        ) : (
          filteredGroups.map((g) => (
            <div key={g.provider}>
              <div className={styles.groupLabel}>{providerNames.get(g.provider) ?? g.provider}</div>
              {g.items.map((m) => {
                const key = modelKey(m.provider, m.id);
                const isCurrent = key === value;
                return (
                  <button
                    key={key}
                    type="button"
                    className={styles.item}
                    data-model-id={m.id}
                    data-provider={m.provider}
                    style={isCurrent ? { color: selFg, fontWeight: 600 } : undefined}
                    onClick={() => onChangeModel(key)}
                  >
                    <span className={styles.itemName}>{m.name ?? m.id}</span>
                    {m.input?.includes('image') || m.reasoning === true || m.fast === true ? <span className={styles.capabilities} data-testid="model-capabilities">
                      {([
                        { capability: 'image', show: m.input?.includes('image') === true, icon: Image, label: messages.image },
                        { capability: 'reasoning', show: m.reasoning === true, icon: Brain, label: messages.reasoning },
                        { capability: 'fast', show: m.fast === true, icon: Zap, label: messages.fastCapability },
                      ] as const).filter((item) => item.show).map((item) => (
                        <Tooltip key={item.capability} title={item.label}>
                          <span aria-label={item.label} data-capability={item.capability}><Icon icon={item.icon} size={14} /></span>
                        </Tooltip>
                      ))}
                    </span> : null}
                    {isCurrent ? <Icon className={styles.check} icon={Check} size={14} /> : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className={styles.footer}>
        {modelMissing ? (
          <span className={styles.footerLabel} data-testid="model-unavailable-hint">
            已保存的模型当前不可用，请选择其它模型
          </span>
        ) : null}
        {preferencesError === 'unavailable' ? (
          <span className={styles.footerLabel} data-testid="model-unavailable-error">
            模型保存后不可用，请重新选择
          </span>
        ) : null}
        {showsThinking || showsFast ? (
          <>
            <span className={styles.footerLabel}>{showsThinking ? '推理档位' : messages.fast}</span>
            <div className={showsFast ? styles.levelRow : undefined} data-testid="model-level-row">
              {showsThinking ? <Segmented
                block
                size="small"
                className={styles.levelSeg}
                data-testid="model-level-segmented"
                disabled={!localReady}
                value={String(activeLevel)}
                options={currentLevels.map((o) => {
                  const optionValue = String(o.value);
                  const display = levelDisplayLabel(optionValue);
                  const vendor = o.label && o.label !== optionValue && o.label !== display ? o.label : '';
                  return {
                    // data-level 给 UI 场景/自动化一个稳定的档位选择器（显示文案是本地化的）。
                    label: <span data-level={optionValue} title={vendor ? `${display} · ${vendor}` : display}>{display}</span>,
                    value: optionValue,
                  };
                })}
                onChange={(v) => onPickLevel(String(v))}
              /> : null}
              {showsFast ? (
                <FastModeToggle
                  enabled={fastSaved}
                  disabled={!localReady || preferencesLoading || loadFailed || fastSaving}
                  onToggle={onToggleFast}
                />
              ) : null}
            </div>
            {showsFast && fastFailed ? <FastModeError /> : null}
          </>
        ) : null}
        {levelFallback ? (
          <span className={styles.footerLabel} data-testid="thinking-effective-hint">
            {levelFallbackText}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.defaults}
          data-testid="save-project-defaults"
          // 加载失败或模型不可用时不能把当前四项当成有效默认写出去。
          disabled={savingDefaults || !localReady || preferencesError === 'load' || preferencesError === 'unavailable'}
          onClick={onSaveDefaults}
        >
          设为项目默认（只影响新对话）
        </button>
      </div>
    </div>
  );

  return (
    <Popover
      arrow={false}
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={handleOpenChange}
      disabled={disabled}
      content={panel}
      styles={{ content: { padding: 0 } }}
    >
      <button
        type="button"
        className={cx(styles.trigger, isDarkMode ? styles.triggerFilled : styles.triggerOutlined)}
        data-testid="model-trigger"
        disabled={disabled}
        title={compact ? (loading ? '加载模型…' : triggerTitle || '模型') : triggerTitle || undefined}
      >
        {compact ? <Icon icon={Cpu} size={14} /> : (
          <>
            <span className={styles.triggerName}>{loading ? '加载模型…' : selectedModelName || '模型'}</span>
            {showsThinking && activeLevel !== 'off' && currentLevelLabel ? (
              <span className={styles.triggerLevel}>· {currentLevelLabel}</span>
            ) : null}
          </>
        )}
        {activeFast ? <span className={styles.triggerLevel} data-testid="model-trigger-fast">· {messages.fastActive}</span> : null}
      </button>
    </Popover>
  );
}

/** 已保存的四项偏好（供显式默认入口与测试读取）。 */
export function readComposerPreferences(workspace: string): SessionPreferences {
  return useSessionPreferencesStore.getState().peek(readComposerOwnerKey(workspace)) ?? emptyPreferences();
}
