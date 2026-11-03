import { pi } from '../../../../lib/pi';
import { loadAvailableModels, getCachedAvailableModels } from '../../../settings/availableModelsCache';
import { mergeModelCatalog, defaultLevel, type RpcModel } from '../thinkingLevels';
import { modelKey, type ModelInfo } from '../modelUtils';
import { settingsModelToKey } from '../sessionModel';
import {
  canonicalOwnerKey,
  emptyPreferences,
  isSessionOwnerKey,
  pickDefinedPreferences,
  pickPreferencesPatch,
  readPreferencesRevision,
  sessionPathFromOwnerKey,
  type SessionPreferenceField,
  type SessionPreferences,
} from '../../../../lib/sessionPreferences';
import {
  resetSessionPreferencesForTests as resetStore,
  useSessionPreferencesStore,
} from '../../../../stores/sessionPreferencesStore';

/**
 * 输入栏四项偏好的读写编排。
 *
 * 规则：
 *  - 草稿（`draft:<uuid>` / workspace 兼容键）：只写本地偏好，不调任何 setter，不动项目默认；
 *    首次进入时从项目默认做一次快照，缺的模型再退应用默认与列表首项。
 *  - 会话：读写都带原始 sessionPath；恢复只读（不调 setter），显式修改才写，并把回执按
 *    「owner + 字段 seq」应用。回执指向别的会话时一律丢弃，不能把 A 的结果写给 B。
 *  - 加载失败/命令不可用必须可见（error='load'），不能当有效数据让用户直接发送。
 */
export interface PreferenceWriteResult {
  ok: boolean;
  error?: 'load' | 'save' | 'stale' | 'blocked' | 'unavailable' | 'loading';
  message?: string;
  /** 思考档只落成有效档（模型钳制），保存值仍是用户点的那个。 */
  effectiveOnly?: boolean;
}

function fail(error: NonNullable<PreferenceWriteResult['error']>, message?: string): PreferenceWriteResult {
  return { ok: false, error, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isDraftOwner(ownerKey: string): boolean {
  return !isSessionOwnerKey(ownerKey);
}

function sameOwnerReceipt(ownerKey: string, receipt: unknown): string | null {
  if (!receipt || typeof receipt !== 'object') return null;
  const raw = receipt as { sessionPath?: unknown; sessionFile?: unknown };
  const path = typeof raw.sessionPath === 'string' ? raw.sessionPath : typeof raw.sessionFile === 'string' ? raw.sessionFile : '';
  return path || null;
}

function receiptPreferences(receipt: unknown): Partial<SessionPreferences> | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const raw = (receipt as { preferences?: unknown }).preferences;
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    ...pickDefinedPreferences(raw),
    revision: readPreferencesRevision(raw),
  };
}

function unavailableFields(receipt: unknown): SessionPreferenceField[] {
  if (!receipt || typeof receipt !== 'object') return [];
  const raw = (receipt as { unavailable?: unknown }).unavailable;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SessionPreferenceField =>
    item === 'model' || item === 'thinkingLevel' || item === 'mode' || item === 'approval' || item === 'fastMode');
}

function findModel(models: readonly ModelInfo[], provider: string, id: string): RpcModel | null {
  const info = models.find((item) => item.provider === provider && item.id === id);
  if (!info) return null;
  return mergeModelCatalog(
    { provider, id, name: info.name, api: info.api, reasoning: info.reasoning, thinkingLevelMap: info.thinkingLevelMap },
    models,
  );
}

/**
 * 草稿四项的初始快照：项目默认 → 应用默认模型 → 列表首项；思考默认取模型默认。
 * 只读默认，不写默认、不调 setter；也不会继承其它会话的当前值。
 */
async function initializeDraft(workspace: string, ownerKey: string): Promise<PreferenceWriteResult> {
  const store = useSessionPreferencesStore.getState();
  if (store.peek(ownerKey)) return { ok: true };
  // 先看磁盘上这个 draft 有没有另一个窗口/上次运行留下的值；只读本 owner 的 key。
  store.hydrateFromStorage(ownerKey);
  if (useSessionPreferencesStore.getState().peek(ownerKey)) return { ok: true };

  let defaults: SessionPreferences = emptyPreferences();
  try {
    const raw = await pi.getSessionDefaults(workspace);
    defaults = pickDefinedPreferences(raw);
  } catch (cause) {
    // 显式默认读不到（旧宿主/未注册命令/磁盘失败）：这是加载失败，不是「默认全空」。
    store.setError(ownerKey, 'load');
    store.setLoading(ownerKey, false);
    return fail('load', errorMessage(cause));
  }

  const models = (getCachedAvailableModels(workspace) ?? []).length
    ? (getCachedAvailableModels(workspace) as ModelInfo[])
    : await loadAvailableModels(workspace).catch(() => [] as ModelInfo[]);

  let model = defaults.model;
  if (!model) {
    let fromSettings = '';
    try {
      const settings = await pi.getSettings();
      fromSettings = settingsModelToKey(settings.defaultSessionModel ?? '');
    } catch {
      fromSettings = '';
    }
    const parsed = fromSettings ? fromSettings.split('\0') : [];
    const preferred = parsed.length === 2 && models.some((item) => modelKey(item.provider, item.id) === fromSettings)
      ? { provider: parsed[0], id: parsed[1] }
      : undefined;
    const first = models[0];
    model = preferred ?? (first ? { provider: first.provider, id: first.id } : undefined);
  }

  const modelInfo = model ? findModel(models, model.provider, model.id) : null;
  const thinkingLevel = defaults.thinkingLevel ?? (modelInfo ? defaultLevel(modelInfo) : undefined);

  useSessionPreferencesStore.getState().applyServer(ownerKey, {
    // 模式/审查缺省：项目默认 → agent / auto。这是草稿本地初值，不写默认、不追加会话条目。
    mode: defaults.mode ?? 'agent',
    approval: defaults.approval ?? 'auto',
    // Fast 是第五项会话偏好：缺省关闭，只认显式项目默认；不读旧的按模型共享文件。
    fastMode: defaults.fastMode === true,
    ...defaults,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    revision: defaults.revision ?? 0,
  });
  return { ok: true };
}

/** 同一 owner 的在途会话读取：三个控件同时挂载只打一次后端。 */
const inflightEnsure = new Map<string, Promise<PreferenceWriteResult>>();

/**
 * 保证输入栏有一份可展示的偏好。
 * 会话：带原始路径读 getState（只读，不调用 setter）；草稿：本地快照/默认。
 *
 * 会话每次都重新读后端（切回/重挂都要看到另一个窗口写入的新版本）；缓存只负责先显示，
 * 不能用它短路读取。同一 owner 并发调用会合并成一次。
 */
export async function ensureComposerPreferences(
  workspace: string,
  ownerKey: string,
): Promise<PreferenceWriteResult> {
  if (isDraftOwner(ownerKey)) return initializeDraft(workspace, ownerKey);

  const key = canonicalOwnerKey(ownerKey);
  const inflight = inflightEnsure.get(key);
  if (inflight) return inflight;
  const pending = loadSessionPreferences(workspace, ownerKey).finally(() => {
    if (inflightEnsure.get(key) === pending) inflightEnsure.delete(key);
  });
  inflightEnsure.set(key, pending);
  return pending;
}

async function loadSessionPreferences(
  workspace: string,
  ownerKey: string,
): Promise<PreferenceWriteResult> {
  const store = useSessionPreferencesStore.getState();
  store.setLoading(ownerKey, true);
  try {
    const state = (await pi.getState(workspace, ownerKey)) as
      | (SessionPreferences & {
          sessionFile?: unknown;
          model?: { provider?: string; id?: string } | null;
          thinkingLevel?: unknown;
          preferences?: unknown;
          unavailable?: unknown;
        })
      | null;
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : '';
    if (sessionFile && canonicalOwnerKey(sessionFile) !== canonicalOwnerKey(ownerKey)) {
      // 后端还停在上一个会话：绝不能把别的会话的快照当这份会话的初值。
      store.setLoading(ownerKey, false);
      store.setError(ownerKey, 'load');
      return fail('stale');
    }

    const snapshotRaw = state?.preferences;
    const fromSnapshot = snapshotRaw ? receiptPreferences({ preferences: snapshotRaw }) : undefined;
    // 历史会话没有 preferences 条目：逐字段回退到 state 顶层有效值，不能整组重置成默认。
    const fallback: SessionPreferences = {
      ...(state?.model?.provider && state?.model?.id
        ? { model: { provider: state.model.provider, id: state.model.id } }
        : {}),
      ...(typeof state?.thinkingLevel === 'string' && state.thinkingLevel
        ? { thinkingLevel: state.thinkingLevel }
        : {}),
      revision: 0,
    };
    const next: SessionPreferences = fromSnapshot
      ? { ...fallback, ...fromSnapshot, revision: fromSnapshot.revision ?? 0 }
      : fallback;
    // 历史会话缺 mode / approval：按兼容规则展示 agent / auto，不调用 setter、不追加条目。
    // 缺 model / thinkingLevel 时保持缺省，让模型控件显式报「未就绪」，不用列表首项冒充历史值。
    // 缺 fastMode 的历史会话按关闭展示；显式补 false 是为了让「设为项目默认」把关闭一起写出去，
    // 否则宿主合并旧默认（可能为 true）会让新草稿莫名其妙开着 Fast。不调 setter、不落盘。
    store.applyServer(ownerKey, {
      ...next,
      mode: next.mode ?? 'agent',
      approval: next.approval ?? 'auto',
      fastMode: next.fastMode === true,
    });
    return { ok: true };
  } catch (cause) {
    store.setLoading(ownerKey, false);
    store.setError(ownerKey, 'load');
    return fail('load', errorMessage(cause));
  }
}

/** 会话里的可展示有效档位（模型能力钳制后的值）：与保存偏好分开显示。 */
export function effectiveThinkingLevel(
  preferences: SessionPreferences,
  models: readonly ModelInfo[] | undefined,
): string | undefined {
  if (!preferences.model) return preferences.thinkingLevel;
  const info = findModel(models ?? [], preferences.model.provider, preferences.model.id);
  if (!info) return preferences.thinkingLevel;
  return mergeThinking(preferences.thinkingLevel, info);
}

function mergeThinking(level: string | undefined, model: RpcModel): string | undefined {
  const allowed = new Set<string>([
    'off',
    ...Object.entries(model.thinkingLevelMap ?? {})
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key),
  ]);
  // 没有档位映射的自定义模型保留保存值（能力未知时不假装 off）。
  if (!model.thinkingLevelMap || Object.keys(model.thinkingLevelMap).length === 0) return level;
  if (!level) return defaultLevel(model);
  return allowed.has(level) ? level : defaultLevel(model);
}

/**
 * 写一项偏好。
 * 草稿：只改本地；会话：带原始路径调 setter，按回执更新，失败可见回滚。
 */
export async function writeComposerPreference(
  workspace: string,
  ownerKey: string,
  field: SessionPreferenceField,
  value: unknown,
): Promise<PreferenceWriteResult> {
  const store = useSessionPreferencesStore.getState();
  const entry = store.get(ownerKey);
  if (entry?.loading) return fail('loading');
  if (field === 'mode' && !pickPreferencesPatch({ mode: value }).mode) {
    return fail('save', 'INVALID_AGENT_MODE');
  }
  if (isDraftOwner(ownerKey)) {
    useSessionPreferencesStore.getState().patchOptimistic(ownerKey, field, value);
    return { ok: true };
  }

  const sessionPath = sessionPathFromOwnerKey(ownerKey);
  if (!sessionPath) return fail('stale');
  const seq = useSessionPreferencesStore.getState().patchOptimistic(ownerKey, field, value);
  const rollback = (error: PreferenceWriteResult['error'], message?: string): PreferenceWriteResult => {
    useSessionPreferencesStore.getState().failWrite(ownerKey, field, seq);
    return fail(error ?? 'save', message);
  };

  try {
    let receipt: unknown;
    if (field === 'model') {
      const model = value as { provider?: string; id?: string } | null;
      if (!model?.provider || !model.id) return rollback('save');
      receipt = await pi.setModel(workspace, model.provider, model.id, sessionPath);
    } else if (field === 'thinkingLevel') {
      if (typeof value !== 'string' || !value) return rollback('save');
      receipt = await pi.setThinkingLevel(workspace, value, sessionPath);
    } else if (field === 'mode') {
      if (typeof value !== 'string' || !value) return rollback('save');
      receipt = await pi.setMode(workspace, value, sessionPath);
    } else if (field === 'fastMode') {
      if (typeof value !== 'boolean') return rollback('save');
      receipt = await pi.setFastMode(workspace, value, sessionPath);
    } else {
      if (typeof value !== 'string' || !value) return rollback('save');
      receipt = await pi.setApproval(workspace, value, sessionPath);
    }

    const blocked = receipt && typeof receipt === 'object'
      ? (receipt as { blocked?: unknown; message?: unknown; ok?: unknown })
      : null;
    if (blocked && blocked.ok === false && blocked.blocked) {
      return rollback('blocked', typeof blocked.message === 'string' ? blocked.message : undefined);
    }

    const receiptPath = sameOwnerReceipt(ownerKey, receipt);
    if (receiptPath && canonicalOwnerKey(receiptPath) !== canonicalOwnerKey(ownerKey)) {
      // 回执属于别的会话（例如切换后迟到完成）：不应用、不改写当前 owner。
      return rollback('stale');
    }

    const preferences = receiptPreferences(receipt);
    const revision = readPreferencesRevision(
      receipt && typeof receipt === 'object' ? (receipt as { preferences?: unknown }).preferences : undefined,
    );
    useSessionPreferencesStore.getState().applyReceipt(ownerKey, field, seq, preferences, revision);

    const unavailable = unavailableFields(receipt);
    if (unavailable.includes(field)) {
      // 思考档：保存值不变，只是生效值被模型钳制；模型：保存值保留但当前不可用，要求重选。
      // Fast：能力撤销只影响生效，保存的会话开关留着，换回支持的模型时恢复。
      if (field === 'thinkingLevel') return { ok: true, effectiveOnly: true };
      if (field === 'fastMode') return { ok: true };
      useSessionPreferencesStore.getState().setError(ownerKey, 'unavailable');
      return fail('unavailable');
    }
    return { ok: true };
  } catch (cause) {
    return rollback('save', errorMessage(cause));
  }
}

/** 显式「设为项目默认」：只写 workspace 默认，不改任何现有会话。 */
export async function saveProjectDefaults(
  workspace: string,
  preferences: SessionPreferences,
): Promise<PreferenceWriteResult> {
  const snapshot: SessionPreferences = { ...pickPreferencesPatch(preferences), revision: 0 };
  try {
    const raw = await pi.setSessionDefaults(workspace, snapshot);
    const saved = raw && typeof raw === 'object'
      ? pickDefinedPreferences(raw)
      : snapshot;
    useSessionPreferencesStore.getState().setDefaults(workspace, saved);
    return { ok: true };
  } catch (cause) {
    return fail('save', errorMessage(cause));
  }
}

export function __resetComposerPreferencesForTest(): void {
  inflightEnsure.clear();
  resetStore();
}
