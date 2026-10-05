import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Popover } from '@lobehub/ui';
import { Segmented } from 'antd';
import { createStaticStyles, cssVar, cx, useThemeMode } from 'antd-style';
import { Check, Cpu, Search } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useThinkingMemoryStore } from '../../../../stores/thinkingMemoryStore';
import { useSessionStore } from '../../../../store/session';
import { pathsEquivalent } from '../../../../lib/pathUtils';
import { pi } from '../../../../lib/pi';
import { loadProviderList } from '../../../settings/providerListCache';
import {
  useAvailableModelsState,
  loadAvailableModels,
  getCachedAvailableModels,
} from '../../../settings/availableModelsCache';
import { modelKey, parseModelKey, type ModelInfo } from '../modelUtils';
import { pickFallbackModelKey, selectedModelLabel, sessionModelKey, settingsModelToKey } from '../sessionModel';
import { coerceVisibleLevel, levelDisplayLabel, levelOptions, mergeModelCatalog, resolveLevelForModel, type RpcModel } from '../thinkingLevels';
import { useComposerCompact } from '../composerCompact';

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
 * 底层行为：模型按会话记忆（草稿默认只写输入栏，不覆盖已有会话）、档位按模型记忆、切模型自动套用「记忆/默认」档位。
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
  levelSeg: css`
    width: 100%;
    font-size: 12px;
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
  /** 用户在本轮草稿点过模型；发送中的 loadState 不得再用设置默认盖掉。 */
  userPicked?: boolean;
}
const cacheByWorkspace = new Map<string, WsCache>();
const memoryBySession = new Map<string, WsCache>();
let lastGlobalModelKey = '';

export function resetModelThinkingCacheForTests(): void {
  cacheByWorkspace.clear();
  memoryBySession.clear();
  lastGlobalModelKey = '';
}

function readMapByPath(map: Map<string, WsCache>, path: string | null | undefined): WsCache | undefined {
  if (!path) return undefined;
  const direct = map.get(path);
  if (direct) return direct;
  for (const [key, value] of map) {
    if (pathsEquivalent(key, path)) return value;
  }
  return undefined;
}

function readSessionMemory(path: string | null | undefined): WsCache | undefined {
  return readMapByPath(memoryBySession, path);
}

function writeSessionMemory(path: string, patch: Partial<WsCache>): void {
  if (!path) return;
  const prev = readSessionMemory(path) ?? { modelKey: '', level: 'off', model: null, loaded: false };
  memoryBySession.set(path, { ...prev, ...patch });
}

function readWorkspaceCache(workspace: string): WsCache | undefined {
  return readMapByPath(cacheByWorkspace, workspace);
}

export function peekComposerModel(workspace: string): { provider: string; id: string } | null {
  const key = readWorkspaceCache(workspace)?.modelKey;
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed.provider || !parsed.id) return null;
  return parsed;
}

/** 草稿首发前读输入栏推理档位。必须在 openWorkspace/newSession 之前读，避免 loadState 中途改缓存。 */
export function peekComposerLevel(workspace: string): string | null {
  const level = readWorkspaceCache(workspace)?.level;
  return level ? level : null;
}

/** 点「新建对话」时清掉上一轮草稿的点选，让新草稿重新套设置默认。 */
export function clearComposerUserPick(workspace: string): void {
  if (!workspace || !readWorkspaceCache(workspace)?.userPicked) return;
  writeCache(workspace, { userPicked: false });
}

/** 草稿首发落盘前把输入栏选型钉进该会话，避免 getState 的设置默认盖掉点选。 */
export function commitComposerModelToSession(
  workspace: string,
  sessionPath: string,
  selected?: { provider: string; id: string } | null,
  level?: string | null,
): void {
  if (!workspace || !sessionPath) return;
  if (selected?.provider && selected.id) {
    const prev = readWorkspaceCache(workspace);
    const key = modelKey(selected.provider, selected.id);
    const model =
      prev?.model && prev.model.provider === selected.provider && prev.model.id === selected.id
        ? prev.model
        : { provider: selected.provider, id: selected.id };
    writeCache(workspace, {
      modelKey: key,
      model,
      loaded: true,
      userPicked: true,
      ...(level ? { level } : {}),
    });
  } else if (level) {
    writeCache(workspace, { level });
  }
  const cached = readWorkspaceCache(workspace);
  if (!cached?.modelKey) return;
  writeSessionMemory(sessionPath, { ...cached, loaded: true });
}

function writeCache(workspace: string, patch: Partial<WsCache>): void {
  const prev = readWorkspaceCache(workspace) ?? { modelKey: '', level: 'off', model: null, loaded: false };
  const next = { ...prev, ...patch };
  cacheByWorkspace.set(workspace, next);
  for (const key of cacheByWorkspace.keys()) {
    if (key !== workspace && pathsEquivalent(key, workspace)) cacheByWorkspace.set(key, next);
  }
}

export default function ModelThinkingAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const draftConversationCwd = useSessionStore((s) => s.draftConversationCwd);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const isDraftConversation = Boolean(
    draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace),
  );
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

  const [value, setValue] = useState(() => cacheByWorkspace.get(workspace)?.modelKey ?? '');
  const [level, setLevel] = useState(() => cacheByWorkspace.get(workspace)?.level ?? 'off');
  const [model, setModel] = useState<RpcModel | null>(() => cacheByWorkspace.get(workspace)?.model ?? null);
  const [ready, setReady] = useState(() => cacheByWorkspace.get(workspace)?.loaded ?? false);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadSeq = useRef(0);
  // 会话档读回之前不要把缓存里的旧档写回后端，避免和 getState 抢档位。
  const levelSettled = useRef(false);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const canBindSession = useRef(true);
  const wasDraftRef = useRef(false);
  const prevModelsLenRef = useRef(0);
  const switchSeq = useThinkingMemoryStore((s) => s.switchSeq[workspace] ?? 0);
  const prevSwitchSeqRef = useRef(switchSeq);

  const applySelection = useCallback((key: string, nextModel: RpcModel | null, nextLevel?: string, userPicked?: boolean) => {
    lastGlobalModelKey = key;
    setValue(key);
    setModel(nextModel);
    if (nextLevel) setLevel(nextLevel);
    setReady(true);
    levelSettled.current = true;
    const patch: Partial<WsCache> = {
      modelKey: key,
      model: nextModel,
      loaded: true,
      ...(nextLevel ? { level: nextLevel } : {}),
      ...(userPicked !== undefined ? { userPicked } : {}),
    };
    writeCache(workspace, patch);
    const st = useSessionStore.getState();
    const isDraft = Boolean(st.draftConversationCwd && pathsEquivalent(st.draftConversationCwd, workspace));
    if (!isDraft && st.activeSessionPath) writeSessionMemory(st.activeSessionPath, patch);
  }, [workspace]);

  const applyFallback = useCallback((bind: boolean, preferred = lastGlobalModelKey, pickLevel = false): boolean => {
    const fallback = pickFallbackModelKey(modelsRef.current, preferred);
    if (!fallback) {
      setReady(true);
      return false;
    }
    const { provider, id } = parseModelKey(fallback);
    const info = modelsRef.current.find((item) => item.provider === provider && item.id === id);
    const nextModel = mergeModelCatalog({ provider, id, name: info?.name, api: info?.api, reasoning: info?.reasoning, thinkingLevelMap: info?.thinkingLevelMap }, modelsRef.current);
    // 草稿没有会话档位可读。沿用上一个会话的 off 时，分段对不上这个模型的档，看起来像没选。
    const nextLevel = pickLevel
      ? resolveLevelForModel(nextModel, useThinkingMemoryStore.getState().byModel[fallback])
      : undefined;
    applySelection(fallback, nextModel, nextLevel);
    if (bind) void pi.setModel(workspace, provider, id);
    return true;
  }, [applySelection, workspace]);

  // 切换对话（workspace / 会话路径变化）时 render 期对齐 state：不闪上一个对话的值。
  const prevWorkspaceRef = useRef(workspace);
  const prevPathRef = useRef(activeSessionPath);
    if (prevWorkspaceRef.current !== workspace) {
    prevWorkspaceRef.current = workspace;
    wasDraftRef.current = false;
    levelSettled.current = false;
    const mem = activeSessionPath ? readSessionMemory(activeSessionPath) : undefined;
    const cached = mem ?? cacheByWorkspace.get(workspace);
    setValue(cached?.modelKey ?? '');
    setLevel(cached?.level ?? 'off');
    setModel(cached?.model ?? null);
    setReady(cached?.loaded ?? false);
    const nextModels = getCachedAvailableModels(workspace) ?? [];
    setModels(nextModels);
    prevModelsLenRef.current = nextModels.length;
    canBindSession.current = true;
  }
  if (prevPathRef.current !== activeSessionPath) {
    prevPathRef.current = activeSessionPath;
    levelSettled.current = false;
    if (activeSessionPath) {
      const mem = readSessionMemory(activeSessionPath);
      if (mem?.modelKey) {
        setValue(mem.modelKey);
        setLevel(mem.level);
        setModel(mem.model);
        setReady(mem.loaded);
        writeCache(workspace, mem);
      } else {
        // 没记过这份会话：不沿用上一个会话的模型 / 档位，等 loadState 读回它自己的。
        setValue('');
        setModel(null);
        setReady(false);
      }
    }
  }

  useEffect(() => {
    if (polledModels && polledModels.length > 0) setModels(polledModels);
  }, [polledModels]);

  // 一次 getState 同时回读「当前模型 + 推理档位」。空会话常还没挂上默认模型：有列表就回退第一项并写回会话。
  const loadState = useCallback(async (): Promise<'ok' | 'empty' | 'error'> => {
    const seq = ++loadSeq.current;
    const draft = useSessionStore.getState().draftConversationCwd;
    const isDraft = Boolean(draft && pathsEquivalent(draft, workspace));
    if (isDraft) {
      canBindSession.current = false;
      if (readWorkspaceCache(workspace)?.userPicked) return 'ok';
      try {
        const settings = await pi.getSettings();
        if (seq !== loadSeq.current) return 'ok';
        if (modelsRef.current.length === 0) {
          setReady(false);
          return 'empty';
        }
        const fromSettings = settingsModelToKey(settings.defaultSessionModel ?? '');
        const inList = Boolean(
          fromSettings && modelsRef.current.some((item) => modelKey(item.provider, item.id) === fromSettings),
        );
        const preferred = inList ? fromSettings : fromSettings ? '' : lastGlobalModelKey;
        return applyFallback(false, preferred, true) ? 'ok' : 'empty';
      } catch {
        if (seq !== loadSeq.current) return 'ok';
        if (modelsRef.current.length === 0) {
          setReady(false);
          return 'empty';
        }
        return applyFallback(false, lastGlobalModelKey, true) ? 'ok' : 'empty';
      }
    }
    try {
      const viewing = useSessionStore.getState().activeSessionPath || null;
      const state = (await pi.getState(workspace, viewing)) as RpcSessionState;
      if (seq !== loadSeq.current) return 'ok';
      const nextModel = mergeModelCatalog(state?.model ?? null, modelsRef.current);
      const key = sessionModelKey(nextModel);
      const sessionFile = typeof (state as { sessionFile?: unknown })?.sessionFile === 'string'
        ? (state as { sessionFile: string }).sessionFile
        : '';
      const viewingPath = useSessionStore.getState().activeSessionPath || '';
      const mismatched = Boolean(sessionFile && viewingPath && !pathsEquivalent(sessionFile, viewingPath));
      canBindSession.current = Boolean(sessionFile) && !mismatched;
      const mem = readSessionMemory(viewingPath || sessionFile);
      const bindRemembered = (remembered: WsCache) => {
        const catalog = mergeModelCatalog(remembered.model, modelsRef.current);
        const level = coerceVisibleLevel(catalog, remembered.level) ?? remembered.level;
        applySelection(remembered.modelKey, remembered.model, level);
        if (canBindSession.current && level && level !== remembered.level) {
          void pi.setThinkingLevel(workspace, level);
        }
        if (!canBindSession.current || !remembered.modelKey) return;
        const parsed = parseModelKey(remembered.modelKey);
        if (parsed.provider && parsed.id) void pi.setModel(workspace, parsed.provider, parsed.id);
      };
      if (mismatched) {
        // 后端还停在上一个会话（switchSession 未完成）：先显示记忆，再重试，不能把上一个会话的模型当成这份的。
        if (mem?.modelKey) applySelection(mem.modelKey, mem.model, mem.level);
        return 'error';
      }
      if (mem?.modelKey && mem.modelKey !== key) {
        bindRemembered(mem);
        return 'ok';
      }
      if (key) {
        const visibleLevel = coerceVisibleLevel(nextModel, state?.thinkingLevel) ?? state?.thinkingLevel;
        applySelection(key, nextModel, visibleLevel);
        if (sessionFile) {
          writeSessionMemory(sessionFile, {
            modelKey: key,
            level: visibleLevel ?? mem?.level ?? 'off',
            model: nextModel,
            loaded: true,
          });
        }
        if (
          canBindSession.current &&
          visibleLevel &&
          state?.thinkingLevel &&
          visibleLevel !== state.thinkingLevel
        ) {
          void pi.setThinkingLevel(workspace, visibleLevel);
        }
        return 'ok';
      }
      if (mem?.modelKey) {
        bindRemembered(mem);
        return 'ok';
      }
      if (state?.thinkingLevel) setLevel(state.thinkingLevel);
      return applyFallback(canBindSession.current, '') ? 'ok' : 'empty';
    } catch (error) {
      if (String(error).includes('SESSION_WORKSPACE_MISMATCH')) {
        canBindSession.current = false;
        return applyFallback(false) ? 'ok' : 'empty';
      }
      setReady(false);
      return 'error';
    }
  }, [applyFallback, applySelection, workspace]);

  useEffect(() => {
    if (!workspaceReady) {
      setReady(false);
      return;
    }
    const isDraftNow = Boolean(
      draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace),
    );
    const enteredDraft = !wasDraftRef.current && isDraftNow;
    const leftDraft = wasDraftRef.current && !isDraftNow;
    const switchSeqChanged = prevSwitchSeqRef.current !== switchSeq;
    prevSwitchSeqRef.current = switchSeq;
    const modelsJustArrived = prevModelsLenRef.current === 0 && models.length > 0;
    wasDraftRef.current = isDraftNow;
    prevModelsLenRef.current = models.length;
    // 首发落盘清草稿时保留输入栏（即将 setModel）；点开已有会话会 bumpSwitch，必须重读该会话模型。
    if (leftDraft && !switchSeqChanged) return;
    if (isDraftNow && !enteredDraft && !modelsJustArrived && models.length > 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (left: number) => {
      void loadState().then((result) => {
        if (cancelled) return;
        if (result === 'error' && left > 0) {
          timer = setTimeout(() => attempt(left - 1), 1000);
        }
      });
    };
    attempt(12);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspace, workspaceReady, loadState, switchSeq, draftConversationCwd, models.length]);

  useEffect(() => {
    if (!ready || models.length === 0) return;
    const inList = Boolean(value) && models.some((item) => modelKey(item.provider, item.id) === value);
    if (inList) return;
    if (!applyFallback(canBindSession.current) && value) applySelection('', null);
  }, [applyFallback, applySelection, models, ready, value]);

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

  // 选模型：先用列表里的档位配置立刻刷新底部，再 setModel → 按「该模型记忆 / 模型默认」写推理档位。
  const onChangeModel = (key: string) => {
    if (!key) return;
    const { provider, id } = parseModelKey(key);
    const info = models.find((item) => item.provider === provider && item.id === id);
    const nextModel = mergeModelCatalog(
      {
        provider,
        id,
        name: info?.name,
        api: info?.api,
        reasoning: info?.reasoning,
        thinkingLevelMap: info?.thinkingLevelMap,
      },
      models,
    );
    const remembered = useThinkingMemoryStore.getState().byModel[modelKey(provider, id)];
    const target = resolveLevelForModel(nextModel, remembered);
    loadSeq.current++;
    applySelection(key, nextModel, target, true);
    if (isDraftConversation) return;
    void (async () => {
      try {
        await pi.setModel(workspace, provider, id);
        const state = (await pi.getState(workspace)) as RpcSessionState;
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
    // 档位跟会话走：记到当前会话，切走再切回来还是它自己的档。
    const st = useSessionStore.getState();
    const isDraft = Boolean(st.draftConversationCwd && pathsEquivalent(st.draftConversationCwd, workspace));
    if (!isDraft && st.activeSessionPath) writeSessionMemory(st.activeSessionPath, { level: next });
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
    if (!isDraftConversation) void loadState();
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

  // 档位跟当前模型列表走，不跟会话里那份选中时的快照。保存「关闭 / 显示」后列表一刷新，分段立刻带上。
  // 只露出一档也要显示并锁在这一档；「多于一档才算推理」会把这一档整段藏掉。
  const catalogModel = mergeModelCatalog(model, models);
  const currentLevels = levelOptions(catalogModel);
  const showsThinking = currentLevels.some((o) => o.value !== 'off');
  const activeLevel = coerceVisibleLevel(catalogModel, level) ?? level;
  const currentLevelLabel = levelDisplayLabel(activeLevel);
  const selectedModelName = selectedModelLabel(value, models);
  const loading = !value && (!ready || (modelsLoading && models.length === 0));
  const disabled = !workspaceReady || models.length === 0;

  const visibleLevelKey = currentLevels.map((o) => String(o.value)).join('\0');
  // 列表把档收窄后，会话里留下的档可能已经不可见。锁到仍露出的默认档，分段才不会空着。
  useEffect(() => {
    if (!levelSettled.current || !ready || !model || !level || activeLevel === level) return;
    setLevel(activeLevel);
    writeCache(workspace, { level: activeLevel });
    const st = useSessionStore.getState();
    const isDraft = Boolean(st.draftConversationCwd && pathsEquivalent(st.draftConversationCwd, workspace));
    if (!isDraft && st.activeSessionPath) writeSessionMemory(st.activeSessionPath, { level: activeLevel });
    if (!isDraft && canBindSession.current) void pi.setThinkingLevel(workspace, activeLevel);
  }, [activeLevel, level, model, ready, visibleLevelKey, workspace]);

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
      {showsThinking ? (
        <div className={styles.footer}>
          <span className={styles.footerLabel}>推理档位</span>
          <Segmented
            block
            size="small"
            className={styles.levelSeg}
            disabled={!ready}
            value={activeLevel}
            options={currentLevels.map((o) => {
              const value = String(o.value);
              const display = levelDisplayLabel(value);
              const vendor = o.label && o.label !== value && o.label !== display ? o.label : '';
              return {
                label: <span title={vendor ? `${display} · ${vendor}` : display}>{display}</span>,
                value,
              };
            })}
            onChange={(v) => onPickLevel(String(v))}
          />
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
        data-testid="model-trigger"
        disabled={disabled}
        title={compact ? (loading ? '加载模型…' : selectedModelName || '模型') : selectedModelName || undefined}
      >
        {compact ? <Icon icon={Cpu} size={14} /> : (
          <>
            <span className={styles.triggerName}>{loading ? '加载模型…' : selectedModelName || '模型'}</span>
            {showsThinking && activeLevel !== 'off' && currentLevelLabel ? (
              <span className={styles.triggerLevel}>· {currentLevelLabel}</span>
            ) : null}
          </>
        )}
      </button>
    </Popover>
  );
}
