import { create } from 'zustand';
import {
  SESSION_PREFERENCE_FIELDS,
  canonicalOwnerKey,
  emptyPreferences,
  isDraftOwnerKey,
  pickDefinedPreferences,
  pickPreferencesPatch,
  readPreferencesRevision,
  type SessionPreferenceField,
  type SessionPreferences,
} from '../lib/sessionPreferences';

/**
 * 会话四项偏好的渲染侧缓存。
 *
 * 权威记录在会话 JSONL；这里只做投影与草稿本地存档：
 *  - 会话条目：加载/回执后写入，重载丢失没关系（会重新读后端）；
 *  - 草稿条目（`draft:<uuid>`）：用户点选只写本地，落盘正文一样存 localStorage，
 *    首发落盘时用 adopt() 过户到新会话；
 *  - 项目默认单独存在 defaultsByWorkspace，只有显式「设为项目默认」才写。
 *
 * 所有异步结果都按 owner key + 字段 seq 应用：A 的迟到回执不会盖掉 B，旧回执不会盖掉新点击。
 */
export interface SessionPreferenceEntry {
  /** 原始 owner key（会话 JSONL 原路径，或 `draft:<uuid>`）：回后端/路由时必须用它。 */
  ownerKey: string;
  /** 当前展示值（乐观写后即新值）。 */
  preferences: SessionPreferences;
  /** 最近一次被确认的值：失败回滚的基准。 */
  confirmed: SessionPreferences;
  loading: boolean;
  error: 'load' | 'save' | 'unavailable' | null;
  /** 只有加载/写入真正落到过一份快照才算有数据；单纯的 loading/error 占位不算。 */
  hasData: boolean;
  /** 权威加载（后端快照/草稿默认初始化）已完成；只有 status 推送的条目还不算。 */
  hydrated: boolean;
}

interface SessionPreferencesState {
  byOwner: Record<string, SessionPreferenceEntry>;
  defaultsByWorkspace: Record<string, SessionPreferences>;
  /** 已删除/已过户的 owner（canonical key）：迟到结果不得把它们复活。 */
  removedOwners: Record<string, true>;
  get: (ownerKey: string) => SessionPreferenceEntry | undefined;
  peek: (ownerKey: string) => SessionPreferences | undefined;
  applyServer: (
    ownerKey: string,
    preferences: SessionPreferences,
    opts?: { fields?: SessionPreferenceField[] },
  ) => void;
  patchOptimistic: (ownerKey: string, field: SessionPreferenceField, value: unknown) => number;
  applyReceipt: (
    ownerKey: string,
    field: SessionPreferenceField,
    seq: number,
    preferences?: Partial<SessionPreferences>,
    revision?: number,
  ) => boolean;
  failWrite: (ownerKey: string, field: SessionPreferenceField, seq: number) => boolean;
  adopt: (draftOwnerKey: string, sessionOwnerKey: string, preferences?: SessionPreferences) => void;
  remove: (ownerKey: string) => void;
  setLoading: (ownerKey: string, loading: boolean) => void;
  setError: (ownerKey: string, error: 'load' | 'save' | 'unavailable' | null) => void;
  /** 从磁盘读回这个 owner 的草稿条目（其它窗口可能刚建了同一 draft 或同机不同 draft）。 */
  hydrateFromStorage: (ownerKey: string) => void;
  /** 宿主 setStatus 推送的单字段投影（mode/approval）：没有 revision，也不整份替换。 */
  applyStatus: (ownerKey: string, field: SessionPreferenceField, value: unknown) => void;
  /** 同上的项目默认版：只改 defaults，不碰任何会话。 */
  applyDefaultStatus: (workspace: string, field: SessionPreferenceField, value: unknown) => void;
  setDefaults: (workspace: string, preferences: SessionPreferences) => void;
}

const STORAGE_KEY = 'pi-session-preferences';

/**
 * 草稿偏好逐 owner 单独存一个 key。
 *
 * 不能把一个渲染进程内存里的整表写回同一个 key：两个窗口各建各的草稿时，后写的窗口会把
 * 另一窗口新建的 draftId 整行抹掉。逐 key 写／逐 key 删只影响本 owner，会话条目不落盘。
 */
function storageKeyFor(ownerKey: string): string {
  return `${STORAGE_KEY}:${ownerKey}`;
}

type StoredEntry = Pick<SessionPreferenceEntry, 'ownerKey' | 'preferences'>;

function parseStoredEntry(raw: string | null, fallbackOwnerKey: string): StoredEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEntry> & { ownerKey?: string };
    const ownerKey = typeof parsed.ownerKey === 'string' && isDraftOwnerKey(parsed.ownerKey)
      ? parsed.ownerKey
      : fallbackOwnerKey;
    if (!isDraftOwnerKey(ownerKey)) return null;
    const prefs = pickDefinedPreferences(parsed.preferences);
    return { ownerKey, preferences: { ...prefs, revision: prefs.revision ?? 0 } };
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function readStoredDrafts(): Record<string, StoredEntry> {
  const store = storage();
  if (!store) return {};
  const out: Record<string, StoredEntry> = {};
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(`${STORAGE_KEY}:`)) continue;
    const ownerKey = key.slice(STORAGE_KEY.length + 1);
    const entry = parseStoredEntry(store.getItem(key), ownerKey);
    if (!entry) continue;
    out[canonicalOwnerKey(entry.ownerKey)] = entry;
  }
  return out;
}

/** 只写本 owner 这一条：其它窗口/其它草稿的键一律不碰。 */
function writeStoredDraft(ownerKey: string, preferences: SessionPreferences | null): void {
  const store = storage();
  if (!store || !isDraftOwnerKey(ownerKey)) return;
  try {
    if (!preferences) {
      store.removeItem(storageKeyFor(ownerKey));
      return;
    }
    store.setItem(storageKeyFor(ownerKey), JSON.stringify({ ownerKey, preferences }));
  } catch {
    /* localStorage 不可用（隐私模式/配额）：草稿偏好只在本次运行内有效，不阻断操作。 */
  }
}

function entryFrom(ownerKey: string, preferences?: SessionPreferences): SessionPreferenceEntry {
  return {
    ownerKey,
    preferences: preferences ? { ...preferences } : emptyPreferences(),
    confirmed: preferences ? { ...preferences } : emptyPreferences(),
    loading: false,
    error: null,
    hasData: preferences !== undefined,
    hydrated: preferences !== undefined,
  };
}

/** 每个 owner 每个字段的写入序号：只有最后一次点击的回执/失败能落到展示值。 */
const seqByOwner = new Map<string, Partial<Record<SessionPreferenceField, number>>>();
/** 已有点击但回执/失败还没回来的字段：宿主 status 推送不能盖掉用户这次的意图。 */
const pendingByOwner = new Map<string, Set<SessionPreferenceField>>();
let seqCounter = 0;

function markPending(key: string, field: SessionPreferenceField): void {
  const set = pendingByOwner.get(key) ?? new Set<SessionPreferenceField>();
  set.add(field);
  pendingByOwner.set(key, set);
}

function clearPending(key: string, field: SessionPreferenceField): void {
  pendingByOwner.get(key)?.delete(field);
}

function isPendingWrite(key: string, field: SessionPreferenceField): boolean {
  return pendingByOwner.get(key)?.has(field) === true;
}

function nextSeq(key: string, field: SessionPreferenceField): number {
  const seq = ++seqCounter;
  const current = seqByOwner.get(key) ?? {};
  seqByOwner.set(key, { ...current, [field]: seq });
  return seq;
}

function currentSeq(key: string, field: SessionPreferenceField): number {
  return seqByOwner.get(key)?.[field] ?? 0;
}

function withoutUndefined(preferences: SessionPreferences, field: SessionPreferenceField): SessionPreferences {
  if (preferences[field] !== undefined) return preferences;
  const next = { ...preferences };
  delete next[field];
  return next;
}

/** 把 store 里这个草稿的当前值写回它自己的 key。 */
function persistOwner(ownerKey: string): void {
  const entry = useSessionPreferencesStore.getState().byOwner[canonicalOwnerKey(ownerKey)];
  writeStoredDraft(ownerKey, entry?.preferences ?? null);
}

const storedDrafts = readStoredDrafts();
const initialByOwner: Record<string, SessionPreferenceEntry> = {};
for (const [key, stored] of Object.entries(storedDrafts)) {
  initialByOwner[key] = entryFrom(stored.ownerKey, stored.preferences);
}

export const useSessionPreferencesStore = create<SessionPreferencesState>((set, get) => ({
  byOwner: initialByOwner,
  defaultsByWorkspace: {},
  removedOwners: {},

  get: (ownerKey) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return undefined;
    return get().byOwner[key];
  },
  peek: (ownerKey) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return undefined;
    const entry = get().byOwner[key];
    return entry?.hasData ? entry.preferences : undefined;
  },

  applyServer: (ownerKey, preferences, opts) => {
    const key = canonicalOwnerKey(ownerKey);
    // 已删除/已过户：迟到的加载或回执不能把条目重新建出来。
    if (get().removedOwners[key]) return;
    const defined = pickDefinedPreferences(preferences);
    const revision = readPreferencesRevision(preferences);
    const fields = opts?.fields;
    set((s) => {
      const prev = s.byOwner[key] ?? entryFrom(ownerKey);
      // 跨窗口/迟到的整份快照：比自己已确认的版本旧就整包丢弃（字段级 merge 会让旧值混进新版本）。
      if (
        revision !== undefined
        && prev.hasData
        && revision < prev.preferences.revision
        && !fields
      ) {
        return s;
      }
      const patch: Partial<Omit<SessionPreferences, 'revision'>> = {};
      for (const field of fields ?? SESSION_PREFERENCE_FIELDS) {
        const value = defined[field];
        if (value === undefined) continue;
        // 本字段有尚未回执的本地点击：整份快照不能盖掉它。
        if (isPendingWrite(key, field)) continue;
        (patch as Record<string, unknown>)[field] = value;
      }
      const nextPrefs: SessionPreferences = { ...prev.preferences, ...patch };
      // 旧版本快照不能把 revision 退回去。
      if (revision !== undefined && revision >= prev.preferences.revision) nextPrefs.revision = revision;
      // 会话回执里的未知字段不删：缺字段的历史会话只补已知项，不整组重置。
      const nextConfirmed: SessionPreferences = { ...prev.confirmed, ...patch };
      if (revision !== undefined && revision >= prev.confirmed.revision) nextConfirmed.revision = revision;
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ownerKey,
            preferences: nextPrefs,
            confirmed: nextConfirmed,
            loading: false,
            error: null,
            hasData: true,
            hydrated: true,
          },
        },
      };
    });
    if (isDraftOwnerKey(ownerKey)) persistOwner(ownerKey);
  },

  patchOptimistic: (ownerKey, field, value) => {
    const key = canonicalOwnerKey(ownerKey);
    if (field === 'mode' && value !== undefined && !pickPreferencesPatch({ mode: value }).mode) {
      return currentSeq(key, field);
    }
    const seq = nextSeq(key, field);
    if (get().removedOwners[key]) return seq;
    // 会话写要等回执：期间不算已确认。草稿是本地写，立即生效。
    if (!isDraftOwnerKey(ownerKey)) markPending(key, field);
    set((s) => {
      const prev = s.byOwner[key] ?? entryFrom(ownerKey);
      const nextPrefs = { ...prev.preferences };
      if (value === undefined) delete nextPrefs[field];
      else (nextPrefs as Record<string, unknown>)[field] = value;
      // 草稿没有后端确认阶段；本地值就是确认值，删/改都不会「回滚」。
      const nextConfirmed = isDraftOwnerKey(ownerKey) ? { ...nextPrefs } : prev.confirmed;
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ownerKey,
            preferences: nextPrefs,
            confirmed: nextConfirmed,
            loading: prev.loading,
            error: prev.error,
            hasData: true,
            hydrated: prev.hydrated,
          },
        },
      };
    });
    if (isDraftOwnerKey(ownerKey)) persistOwner(ownerKey);
    return seq;
  },

  applyReceipt: (ownerKey, field, seq, preferences, revision) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return false;
    const entry = get().byOwner[key];
    // 已删除的会话：迟到的成功回执不能把它放回来。
    if (!entry) return false;
    if (seq !== currentSeq(key, field)) return false;
    clearPending(key, field);
    const defined = pickDefinedPreferences(preferences ?? {});
    const nextRevision = revision ?? readPreferencesRevision(preferences);
    set((s) => {
      const prev = s.byOwner[key];
      if (!prev) return s;
      const patch: Partial<Omit<SessionPreferences, 'revision'>> = {};
      for (const name of SESSION_PREFERENCE_FIELDS) {
        const value = defined[name];
        if (value === undefined) continue;
        // 回执带的是写入瞬间的整份快照；别的字段若已有更新的在途点击，不能被这份旧快照盖掉。
        if (currentSeq(key, name) > seq) continue;
        (patch as Record<string, unknown>)[name] = value;
      }
      // 回执是「该次写入之后」的投影：字段值以它为准，其它字段的本地在途值保持不变。
      const nextPrefs = withoutUndefined({ ...prev.preferences, ...patch }, field);
      const nextConfirmed = { ...prev.confirmed, ...patch };
      if (nextRevision !== undefined) {
        nextPrefs.revision = nextRevision;
        nextConfirmed.revision = nextRevision;
      }
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ownerKey: prev.ownerKey,
            preferences: nextPrefs,
            confirmed: nextConfirmed,
            loading: false,
            error: null,
            hasData: prev.hasData,
            hydrated: prev.hydrated,
          },
        },
      };
    });
    if (isDraftOwnerKey(entry.ownerKey)) persistOwner(entry.ownerKey);
    return true;
  },

  failWrite: (ownerKey, field, seq) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return false;
    const entry = get().byOwner[key];
    if (!entry) return false;
    if (seq !== currentSeq(key, field)) return false;
    clearPending(key, field);
    set((s) => {
      const prev = s.byOwner[key];
      if (!prev) return s;
      const nextPrefs = { ...prev.preferences };
      const confirmedValue = prev.confirmed[field];
      if (confirmedValue === undefined) delete nextPrefs[field];
      else (nextPrefs as Record<string, unknown>)[field] = confirmedValue;
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ownerKey: prev.ownerKey,
            preferences: nextPrefs,
            confirmed: prev.confirmed,
            loading: false,
            error: 'save',
            hasData: prev.hasData,
            hydrated: prev.hydrated,
          },
        },
      };
    });
    return true;
  },

  adopt: (draftOwnerKey, sessionOwnerKey, preferences) => {
    const draftKey = canonicalOwnerKey(draftOwnerKey);
    const sessionKey = canonicalOwnerKey(sessionOwnerKey);
    const draft = get().byOwner[draftKey];
    const next: SessionPreferences = preferences
      ? pickDefinedPreferences(preferences)
      : { ...(draft?.preferences ?? emptyPreferences()) };
    set((s) => {
      const byOwner = { ...s.byOwner };
      delete byOwner[draftKey];
      byOwner[sessionKey] = entryFrom(sessionOwnerKey, next);
      const removedOwners = { ...s.removedOwners };
      // 草稿已过户：它自己的迟到回执不能把草稿键重新建出来。
      if (draftKey !== sessionKey) removedOwners[draftKey] = true as const;
      delete removedOwners[sessionKey];
      return { byOwner, removedOwners };
    });
    seqByOwner.delete(draftKey);
    seqByOwner.delete(sessionKey);
    pendingByOwner.delete(draftKey);
    pendingByOwner.delete(sessionKey);
    // 只删草稿自己那一条：其它窗口的其它 draft 键原样保留。
    if (isDraftOwnerKey(draftOwnerKey)) writeStoredDraft(draftOwnerKey, null);
  },

  remove: (ownerKey) => {
    const key = canonicalOwnerKey(ownerKey);
    set((s) => {
      const removedOwners = { ...s.removedOwners, [key]: true as const };
      if (!(key in s.byOwner)) return { removedOwners };
      const byOwner = { ...s.byOwner };
      delete byOwner[key];
      return { byOwner, removedOwners };
    });
    seqByOwner.delete(key);
    pendingByOwner.delete(key);
    if (isDraftOwnerKey(ownerKey)) writeStoredDraft(ownerKey, null);
  },

  setLoading: (ownerKey, loading) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return;
    set((s) => {
      const prev = s.byOwner[key] ?? entryFrom(ownerKey);
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ...prev,
            ownerKey,
            loading,
            error: loading ? null : prev.error,
          },
        },
      };
    });
  },

  setError: (ownerKey, error) => {
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return;
    set((s) => {
      const prev = s.byOwner[key] ?? entryFrom(ownerKey);
      return {
        byOwner: { ...s.byOwner, [key]: { ...prev, ownerKey, error } },
      };
    });
  },

  setDefaults: (workspace, preferences) => {
    set((s) => ({
      defaultsByWorkspace: {
        ...s.defaultsByWorkspace,
        [canonicalOwnerKey(workspace)]: pickDefinedPreferences(preferences),
      },
    }));
  },

  applyStatus: (ownerKey, field, value) => {
    if (field !== 'mode' && field !== 'approval') return;
    const parsedValue = pickDefinedPreferences({ [field]: value })[field];
    if (parsedValue === undefined) return;
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return;
    set((s) => {
      const prev = s.byOwner[key];
      // 还没加载出快照：先把这一项当作临时展示值（hydrated=false），
      // 后续 ensure 的后端快照仍然会加载并覆盖，不会因为有 status 就跳过读取。
      if (!prev) {
        const preferences: SessionPreferences = { revision: 0, [field]: parsedValue } as SessionPreferences;
        return {
          byOwner: {
            ...s.byOwner,
            [key]: {
              ownerKey,
              preferences,
              confirmed: { revision: 0 },
              loading: false,
              error: null,
              hasData: true,
              hydrated: false,
            },
          },
        };
      }
      if (!prev.hasData) return s;
      // 本字段有更新未曾回执的点击：以用户点击为准，不让旧 status 盖回去。
      if (isPendingWrite(key, field)) return s;
      return {
        byOwner: {
          ...s.byOwner,
          [key]: {
            ...prev,
            // 只改这一个字段，其它三项和 revision 原样保留。
            preferences: { ...prev.preferences, [field]: parsedValue },
            confirmed: { ...prev.confirmed, [field]: parsedValue },
          },
        },
      };
    });
  },

  applyDefaultStatus: (workspace, field, value) => {
    if (field !== 'mode' && field !== 'approval') return;
    const parsedValue = pickDefinedPreferences({ [field]: value })[field];
    if (parsedValue === undefined) return;
    const key = canonicalOwnerKey(workspace);
    set((s) => {
      const prev = s.defaultsByWorkspace[key] ?? emptyPreferences();
      return {
        defaultsByWorkspace: {
          ...s.defaultsByWorkspace,
          [key]: { ...prev, [field]: parsedValue },
        },
      };
    });
  },

  hydrateFromStorage: (ownerKey) => {
    if (!isDraftOwnerKey(ownerKey)) return;
    const key = canonicalOwnerKey(ownerKey);
    if (get().removedOwners[key]) return;
    const store = storage();
    if (!store) return;
    const parsed = parseStoredEntry(store.getItem(storageKeyFor(ownerKey)), ownerKey);
    // 只合入这一个 owner：读不到（另一窗口删了）就保持内存值，不用别的草稿覆盖。
    if (!parsed) return;
    set((s) => {
      const prev = s.byOwner[key];
      // 本地已有更新的改动（有 seq 在途/草稿本地值）时不拿磁盘旧值盖回。
      const pending = Object.values(seqByOwner.get(key) ?? {}).some((value) => (value ?? 0) > 0);
      if (prev?.hasData && pending) return s;
      return {
        byOwner: { ...s.byOwner, [key]: entryFrom(parsed.ownerKey, parsed.preferences) },
      };
    });
  },
}));

export function peekSessionPreferences(ownerKey: string): SessionPreferences | undefined {
  return useSessionPreferencesStore.getState().peek(ownerKey);
}

export function readProjectDefaults(workspace: string): SessionPreferences | undefined {
  return useSessionPreferencesStore.getState().defaultsByWorkspace[canonicalOwnerKey(workspace)];
}

export function resetSessionPreferencesForTests(): void {
  seqByOwner.clear();
  pendingByOwner.clear();
  seqCounter = 0;
  useSessionPreferencesStore.setState({ byOwner: {}, defaultsByWorkspace: {}, removedOwners: {} });
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && (key === STORAGE_KEY || key.startsWith(`${STORAGE_KEY}:`))) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    /* 忽略清理失败 */
  }
}
