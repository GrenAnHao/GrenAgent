import { create } from 'zustand';
import { canonicalOwnerKey, isDraftOwnerKey, isSessionOwnerKey } from '../lib/sessionPreferences';

/**
 * 会话视图展开状态（上下文工具组、工具卡详情、codemode 展开体、思考正文）。
 *
 * 归属是「会话视图」而不是组件实例：以 owner key（会话 JSONL 原路径，或未落盘草稿的
 * `draft:<uuid>`）为第一层，稳定内容 ID 为第二层。这样 A 展开过的项切到 B 不出现，
 * 切回 A / 组件卸载重挂 / 页面重载都能恢复；A、B 恰好共用同一个 toolCallId 也不会串。
 *
 * 只持久化有身份（会话路径或 draft id）的 owner：workspace 兜底键没有会话身份，
 * 写进去会让同项目的所有未落盘草稿共享一份展开状态，因此直接忽略。
 *
 * 浏览器安全：只依赖 localStorage 与 zustand，不碰 window.gren / preload 桥。
 *
 * 落盘按 owner 分键（`pi-session-view-state:<canonical owner>`）：一次点击只写这一个 owner 的键，
 * 不整表回写。否则两个窗口分别看 A、B 时，B 窗口刚写的展开项会被 A 窗口手里的旧整表盖回去。
 */
export type SessionViewExpanded = Record<string, boolean>;

interface SessionViewState {
  /** canonical owner key → (内容 ID → 是否展开)。 */
  byOwner: Record<string, SessionViewExpanded>;
  /** 该会话里这个内容是否展开；没有记录返回 undefined（调用方用自己的默认值）。 */
  isExpanded: (ownerKey: string, viewId: string) => boolean | undefined;
  setExpanded: (ownerKey: string, viewId: string, expanded: boolean) => void;
  /** 翻转并返回新值。 */
  toggle: (ownerKey: string, viewId: string) => boolean;
  /**
   * 草稿首发落盘：把 `fromOwnerKey`（通常是 `draft:<uuid>`）名下的展开项过户给新会话路径。
   * 同一内容 ID 以来源草稿为准；过户后删除来源键。
   */
  adopt: (fromOwnerKey: string, toSessionPath: string) => void;
  /** 删除会话 / 丢弃草稿时清掉它名下的展开项。 */
  remove: (ownerKey: string) => void;
  /** 从 localStorage 重新读回（页面重载；测试里用来模拟另一个窗口的写入/重挂）。 */
  hydrateFromStorage: () => void;
}

const STORAGE_KEY = 'pi-session-view-state';
/** 旧版本（整表存盘）的键：只读兼容，新写入一律走逐 owner 键。 */
const LEGACY_STORAGE_KEY = STORAGE_KEY;
const OWNER_KEY_PREFIX = `${STORAGE_KEY}:`;

/** 存储前缀键（旧版本整表键名）；逐 owner 键见 sessionViewStateKeyFor。 */
export function sessionViewStateStorageKey(): string {
  return STORAGE_KEY;
}

/** 某个 owner 的落盘键。 */
export function sessionViewStateKeyFor(ownerKey: string): string {
  return `${OWNER_KEY_PREFIX}${canonicalViewOwner(ownerKey)}`;
}

/** 只有会话路径 / `draft:<uuid>` 这种有身份的 owner 才允许读写（不落 workspace 兜底键）。 */
export function isPersistableViewOwnerKey(key: string | null | undefined): boolean {
  if (typeof key !== 'string' || !key) return false;
  return isDraftOwnerKey(key) || isSessionOwnerKey(key);
}

function canonicalViewOwner(key: string): string {
  return canonicalOwnerKey(key);
}

/**
 * 已删除会话 / 已丢弃草稿的墓碑。删除是异步的（App 先乐观隐藏，后台清理），期间可能还有
 * 迟到的 setExpanded / adopt 回调。没有墓碑时，这些回调会把刚删掉的会话重新写回展开表。
 * 会话文件名唯一、删后不会再生，草稿 id 也是 uuid，所以墓碑只在本次运行内有效，不落盘。
 */
const removedOwners = new Set<string>();

function isRemoved(ownerKey: string): boolean {
  return removedOwners.has(canonicalViewOwner(ownerKey));
}

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function sanitizeViews(value: unknown): SessionViewExpanded {
  const views: SessionViewExpanded = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return views;
  for (const [viewId, expanded] of Object.entries(value as Record<string, unknown>)) {
    if (!viewId || typeof expanded !== 'boolean') continue;
    views[viewId] = expanded;
  }
  return views;
}

/** 读全部 owner 的存档：逐 owner 键 + 旧版整表键（兼容一次）。 */
function readStored(): Record<string, SessionViewExpanded> {
  if (!storageAvailable()) return {};
  const out: Record<string, SessionViewExpanded> = {};
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [ownerKey, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!isPersistableViewOwnerKey(ownerKey)) continue;
          const views = sanitizeViews(value);
          if (Object.keys(views).length > 0) out[canonicalViewOwner(ownerKey)] = views;
        }
      }
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(OWNER_KEY_PREFIX)) continue;
      const ownerKey = key.slice(OWNER_KEY_PREFIX.length);
      if (!isPersistableViewOwnerKey(ownerKey)) continue;
      const views = sanitizeViews(JSON.parse(localStorage.getItem(key) ?? 'null'));
      if (Object.keys(views).length > 0) out[canonicalViewOwner(ownerKey)] = views;
    }
  } catch {
    /* 损坏的存档按空处理。 */
  }
  return out;
}

function readOwnerStored(ownerKey: string): SessionViewExpanded {
  if (!storageAvailable()) return {};
  try {
    return sanitizeViews(JSON.parse(localStorage.getItem(sessionViewStateKeyFor(ownerKey)) ?? 'null'));
  } catch {
    return {};
  }
}

/** 只提交这一个 owner 的键；别的 owner（可能是另一个窗口刚写的）原样留在磁盘上。 */
function writeOwnerStored(ownerKey: string, views: SessionViewExpanded): void {
  if (!storageAvailable()) return;
  try {
    const key = sessionViewStateKeyFor(ownerKey);
    if (Object.keys(views).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(views));
  } catch {
    /* 落盘失败不阻断交互：展开状态只在本次运行内有效。 */
  }
}

function clearOwnerStored(ownerKey: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(sessionViewStateKeyFor(ownerKey));
  } catch {
    /* 忽略清理失败。 */
  }
}

/** 把本地存档并进内存：内存里的值更新（本次运行已发生过点击），存档只补缺。 */
function mergeStored(
  stored: Record<string, SessionViewExpanded>,
  current: Record<string, SessionViewExpanded>,
): Record<string, SessionViewExpanded> {
  const next: Record<string, SessionViewExpanded> = { ...current };
  for (const [ownerKey, views] of Object.entries(stored)) {
    next[ownerKey] = { ...views, ...(next[ownerKey] ?? {}) };
  }
  return next;
}

export const useSessionViewStateStore = create<SessionViewState>((set, get) => {
  /** changed：这次真正改到的 owner，只有它们需要写盘。 */
  const commit = (next: Record<string, SessionViewExpanded>, changed: string[]) => {
    set({ byOwner: next });
    for (const ownerKey of changed) writeOwnerStored(ownerKey, next[ownerKey] ?? {});
  };

  return {
    byOwner: readStored(),

    isExpanded: (ownerKey, viewId) => {
      if (!isPersistableViewOwnerKey(ownerKey) || !viewId) return undefined;
      return get().byOwner[canonicalViewOwner(ownerKey)]?.[viewId];
    },

    setExpanded: (ownerKey, viewId, expanded) => {
      if (!isPersistableViewOwnerKey(ownerKey) || !viewId) return;
      if (isRemoved(ownerKey)) return;
      const key = canonicalViewOwner(ownerKey);
      const prev = get().byOwner[key] ?? {};
      if (prev[viewId] === expanded) return;
      commit({ ...get().byOwner, [key]: { ...prev, [viewId]: expanded } }, [key]);
    },

    toggle: (ownerKey, viewId) => {
      if (isRemoved(ownerKey)) return false;
      const current = get().isExpanded(ownerKey, viewId) === true;
      const next = !current;
      get().setExpanded(ownerKey, viewId, next);
      return next;
    },

    adopt: (fromOwnerKey, toSessionPath) => {
      if (!isPersistableViewOwnerKey(fromOwnerKey) || !isPersistableViewOwnerKey(toSessionPath)) return;
      // 目标会话已经被删除：这次过户整体丢弃，迟到回调不能把它复活。
      if (isRemoved(toSessionPath)) return;
      const fromKey = canonicalViewOwner(fromOwnerKey);
      const toKey = canonicalViewOwner(toSessionPath);
      const byOwner = { ...get().byOwner };
      const source = byOwner[fromKey];
      delete byOwner[fromKey];
      clearOwnerStored(fromKey);
      if (!source || Object.keys(source).length === 0) {
        set({ byOwner });
        return;
      }
      // 来源草稿是这次首发真正在看的视图：同一内容 ID 以它为准；
      // 磁盘上别的窗口已写进新会话的值作为底，保住它们新开的项。
      byOwner[toKey] = { ...readOwnerStored(toKey), ...(byOwner[toKey] ?? {}), ...source };
      commit(byOwner, [toKey]);
    },

    remove: (ownerKey) => {
      if (!isPersistableViewOwnerKey(ownerKey)) return;
      const key = canonicalViewOwner(ownerKey);
      removedOwners.add(key);
      const byOwner = { ...get().byOwner };
      const had = key in byOwner;
      if (had) delete byOwner[key];
      set({ byOwner });
      clearOwnerStored(key);
    },

    hydrateFromStorage: () => {
      const stored = readStored();
      for (const ownerKey of Object.keys(stored)) {
        // 已删除的会话不能被旧存档复活。
        if (removedOwners.has(ownerKey)) delete stored[ownerKey];
      }
      set({ byOwner: mergeStored(stored, get().byOwner) });
    },
  };
});

/** 测试用：清内存与（默认）localStorage。keepStorage 模拟「整页重载但存档还在」。 */
export function resetSessionViewStateForTests(opts?: { keepStorage?: boolean }): void {
  removedOwners.clear();
  useSessionViewStateStore.setState({ byOwner: {} });
  if (opts?.keepStorage || !storageAvailable()) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && (key === LEGACY_STORAGE_KEY || key.startsWith(OWNER_KEY_PREFIX))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* 忽略清理失败 */
  }
}
