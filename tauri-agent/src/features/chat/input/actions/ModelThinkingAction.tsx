import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Popover } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx, useThemeMode } from 'antd-style';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useThinkingMemoryStore } from '../../../../stores/thinkingMemoryStore';
import { pi } from '../../../../lib/pi';
import { loadProviderList } from '../../../settings/providerListCache';
import {
  useAvailableModelsState,
  loadAvailableModels,
  getCachedAvailableModels,
} from '../../../settings/availableModelsCache';
import { modelKey, parseModelKey, type ModelInfo } from '../modelUtils';
import { levelOptions, resolveLevelForModel, type RpcModel } from '../thinkingLevels';

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
 * 底层行为与拆分时一致：模型按 workspace 记忆、档位按模型记忆、切模型自动套用「记忆/默认」档位。
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
    padding: 0 8px;
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
    border: 1px solid transparent;
    background: ${cssVar.colorFillTertiary};
    &:hover:not(:disabled) {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  // 浅色默认档：outlined（容器底 + 次级边框，hover 边框加深）。
  triggerOutlined: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
    &:hover:not(:disabled) {
      border-color: ${cssVar.colorBorder};
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
  chevron: css`
    flex: none;
    opacity: 0.5;
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
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  check: css`
    flex: none;
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
  seg: css`
    display: flex;
    align-items: stretch;
    width: 100%;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
  `,
  segItem: css`
    flex: 1 1 0;
    min-width: 0;
    height: 24px;
    padding: 0 2px;
    border: none;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    line-height: 24px;
    text-align: center;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s;
    &:first-of-type {
      border-inline-start: none;
    }
    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
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

// 每个 workspace 缓存「模型 key + 档位 + 模型元数据 + 是否已读后端」：切对话时同步回显，消除「先显示上一个
// 对话的值、再异步跳到新值」的闪动（合并自原 ModelAction.lastModelByWorkspace 与 ThinkingAction.thinkingByWorkspace）。
interface WsCache {
  modelKey: string;
  level: string;
  model: RpcModel | null;
  loaded: boolean;
}
const cacheByWorkspace = new Map<string, WsCache>();

function writeCache(workspace: string, patch: Partial<WsCache>): void {
  const prev = cacheByWorkspace.get(workspace) ?? { modelKey: '', level: 'off', model: null, loaded: false };
  cacheByWorkspace.set(workspace, { ...prev, ...patch });
}

export default function ModelThinkingAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  // isDarkMode 与 base-ui 同源（antd-style）：trigger 据此切 filled/outlined，和左侧 Mode/Approval 一致。
  const { isDarkMode } = useThemeMode();
  // 选中态用「中性提亮」而非品牌主色（主色在深灰主题里太跳）：底用中性半透明填充，文字用正文色。
  // 走 cssVar 的 var() 引用即可 —— ThemeBridge 已把 --ant-* 变量表挂到 <html>，portal 里同样能继承。
  const selBg = cssVar.colorFillSecondary;
  const selFg = cssVar.colorText;

  const { models: polledModels, loading: modelsLoading } = useAvailableModelsState(
    workspaceReady ? workspace : undefined,
  );
  const [models, setModels] = useState<ModelInfo[]>(() => getCachedAvailableModels(workspace) ?? []);
  const [providerNames, setProviderNames] = useState<Map<string, string>>(new Map());

  const [value, setValue] = useState(() => cacheByWorkspace.get(workspace)?.modelKey ?? '');
  const [level, setLevel] = useState(() => cacheByWorkspace.get(workspace)?.level ?? 'off');
  const [model, setModel] = useState<RpcModel | null>(() => cacheByWorkspace.get(workspace)?.model ?? null);
  const [ready, setReady] = useState(() => cacheByWorkspace.get(workspace)?.loaded ?? false);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadSeq = useRef(0);
  const switchSeq = useThinkingMemoryStore((s) => s.switchSeq[workspace] ?? 0);

  // 切换对话（workspace 变化）时 render 期对齐 state：不闪上一个对话的值。
  const prevWorkspaceRef = useRef(workspace);
  if (prevWorkspaceRef.current !== workspace) {
    prevWorkspaceRef.current = workspace;
    const cached = cacheByWorkspace.get(workspace);
    setValue(cached?.modelKey ?? '');
    setLevel(cached?.level ?? 'off');
    setModel(cached?.model ?? null);
    setReady(cached?.loaded ?? false);
    setModels(getCachedAvailableModels(workspace) ?? []);
  }

  useEffect(() => {
    if (polledModels && polledModels.length > 0) setModels(polledModels);
  }, [polledModels]);

  // 一次 getState 同时回读「当前模型 + 推理档位」。
  const loadState = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const state = (await pi.getState(workspace)) as RpcSessionState;
      if (seq !== loadSeq.current) return;
      const nextModel = state?.model ?? null;
      let key: string | undefined;
      if (nextModel?.provider && nextModel?.id) {
        key = modelKey(nextModel.provider, nextModel.id);
        setValue(key);
      }
      if (state?.thinkingLevel) setLevel(state.thinkingLevel);
      setModel(nextModel);
      setReady(true);
      const prev = cacheByWorkspace.get(workspace);
      writeCache(workspace, {
        modelKey: key ?? prev?.modelKey ?? '',
        level: state?.thinkingLevel ?? prev?.level ?? 'off',
        model: nextModel,
        loaded: true,
      });
    } catch {
      setReady(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspaceReady) {
      setReady(false);
      return;
    }
    void loadState();
  }, [workspace, workspaceReady, loadState, switchSeq]);

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

  // 打开下拉时聚焦搜索框。
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  // 选模型：setModel → 按「该模型记忆 / 模型默认」设推理档位 → bumpSwitch 重读刷新。不关面板（可接着调档位）。
  const onChangeModel = (key: string) => {
    if (!key) return;
    const { provider, id } = parseModelKey(key);
    loadSeq.current++;
    setValue(key);
    writeCache(workspace, { modelKey: key });
    void (async () => {
      await pi.setModel(workspace, provider, id);
      try {
        const state = (await pi.getState(workspace)) as RpcSessionState;
        const remembered = useThinkingMemoryStore.getState().byModel[modelKey(provider, id)];
        const target = resolveLevelForModel(state.model ?? null, remembered);
        if (target !== state.thinkingLevel) await pi.setThinkingLevel(workspace, target);
      } catch {
        /* 保持后端现状 */
      }
      useThinkingMemoryStore.getState().bumpSwitch(workspace);
    })();
  };

  // 选档位：setThinkingLevel + 按模型记忆。不关面板。
  const onPickLevel = (next: string) => {
    if (!next) return;
    loadSeq.current++;
    setLevel(next);
    writeCache(workspace, { level: next });
    void pi.setThinkingLevel(workspace, next);
    if (model?.provider && model?.id) {
      useThinkingMemoryStore.getState().remember(modelKey(model.provider, model.id), next);
    }
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
    void loadState();
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

  const currentLevels = levelOptions(model);
  const isReasoning = currentLevels.length > 1;
  const currentLevelLabel = currentLevels.find((o) => o.value === level)?.label;
  const selectedModelName = (() => {
    if (!value) return '';
    const { provider, id } = parseModelKey(value);
    return models.find((m) => m.provider === provider && m.id === id)?.name ?? id;
  })();

  const loading = modelsLoading && models.length === 0;
  const disabled = !workspaceReady || models.length === 0;

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
                    style={isCurrent ? { color: selFg, fontWeight: 600 } : undefined}
                    onClick={() => onChangeModel(key)}
                  >
                    <span className={styles.itemName}>{m.name ?? m.id}</span>
                    {isCurrent ? <Icon className={styles.check} icon={Check} size={14} /> : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      {isReasoning ? (
        <div className={styles.footer}>
          <span className={styles.footerLabel}>推理档位</span>
          <div className={styles.seg}>
            {currentLevels.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                disabled={!ready}
                className={styles.segItem}
                // 当前档位高亮用内联 style：优先级最高，绕开 createStaticStyles 原子类注入顺序不定导致的覆盖。
                style={
                  o.value === level
                    ? { background: selBg, color: selFg, fontWeight: 600 }
                    : undefined
                }
                onClick={() => onPickLevel(String(o.value))}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
        disabled={disabled}
        title={selectedModelName || undefined}
      >
        <span className={styles.triggerName}>{loading ? '加载模型…' : selectedModelName || '模型'}</span>
        {isReasoning && level !== 'off' && currentLevelLabel ? (
          <span className={styles.triggerLevel}>· {currentLevelLabel}</span>
        ) : null}
        <Icon className={styles.chevron} icon={ChevronDown} size={12} />
      </button>
    </Popover>
  );
}
