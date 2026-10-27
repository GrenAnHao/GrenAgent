import { pathsEquivalent } from '../../lib/pathUtils';
import { baseName } from './fileKinds';

/** 文件管理器里打开着的文件标签：按显示顺序的路径 + 当前看的那个。 */
export interface FileTabsState {
  paths: string[];
  active: string | null;
}

export const EMPTY_FILE_TABS: FileTabsState = { paths: [], active: null };

export function findTab(state: FileTabsState, path: string): string | undefined {
  return state.paths.find((p) => pathsEquivalent(p, path));
}

/** 打开一个文件：已有同一路径（含 E:\x / E:/x 这类不同写法）的标签就切过去，否则在末尾新开。 */
export function openFileTab(state: FileTabsState, path: string): FileTabsState {
  const existing = findTab(state, path);
  if (existing) return existing === state.active ? state : { ...state, active: existing };
  return { paths: [...state.paths, path], active: path };
}

export function activateFileTab(state: FileTabsState, path: string): FileTabsState {
  const existing = findTab(state, path);
  return existing && existing !== state.active ? { ...state, active: existing } : state;
}

/**
 * 关掉这些标签。当前标签被关时激活它右边第一个留下的，没有就左边最近的；
 * preferActive 还开着就回到它（关别的标签前为了询问未保存修改临时切过去过）。
 */
export function closeFileTabs(state: FileTabsState, targets: readonly string[], preferActive?: string | null): FileTabsState {
  const closing = (p: string) => targets.some((t) => pathsEquivalent(t, p));
  const paths = state.paths.filter((p) => !closing(p));
  if (paths.length === state.paths.length) return state;
  if (preferActive && paths.includes(preferActive)) return { paths, active: preferActive };
  if (state.active && paths.includes(state.active)) return { paths, active: state.active };
  const index = state.active ? state.paths.indexOf(state.active) : -1;
  const right = state.paths.slice(index + 1).find((p) => !closing(p));
  const left = state.paths.slice(0, Math.max(index, 0)).reverse().find((p) => !closing(p));
  return { paths, active: right ?? left ?? null };
}

export type CloseScope = 'self' | 'others' | 'right' | 'all';

/** 右键菜单「关闭 / 关闭其他 / 关闭右侧 / 全部关闭」各自要关哪些。 */
export function tabsInScope(state: FileTabsState, path: string, scope: CloseScope): string[] {
  const index = state.paths.indexOf(path);
  switch (scope) {
    case 'self':
      return index >= 0 ? [path] : [];
    case 'others':
      return state.paths.filter((p) => p !== path);
    case 'right':
      return index >= 0 ? state.paths.slice(index + 1) : [];
    case 'all':
      return [...state.paths];
  }
}

/** 从持久化读回来的状态：去重、丢空值，激活项不在列表里就退回第一个。 */
export function sanitizeFileTabs(paths: readonly unknown[] | undefined, active: unknown): FileTabsState {
  let state = EMPTY_FILE_TABS;
  for (const p of paths ?? []) {
    if (typeof p === 'string' && p) state = openFileTab(state, p);
  }
  const wanted = typeof active === 'string' ? findTab(state, active) : undefined;
  return { paths: state.paths, active: wanted ?? state.paths[0] ?? null };
}

function dirSegments(path: string): string[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(0, -1);
}

/**
 * 标签上显示的名字：文件名；同名文件同时开着时，后面附上能区分它们的最短上级目录（`src`、`a/src`）。
 * 返回和 paths 一一对应。
 */
export function fileTabLabels(paths: readonly string[]): Array<{ name: string; hint: string }> {
  const names = paths.map((p) => baseName(p));
  return paths.map((path, i) => {
    const name = names[i];
    const peers = paths.filter((p, j) => j !== i && names[j].toLowerCase() === name.toLowerCase());
    if (peers.length === 0) return { name, hint: '' };
    const mine = dirSegments(path);
    const others = peers.map(dirSegments);
    for (let depth = 1; depth <= mine.length; depth += 1) {
      const suffix = mine.slice(-depth).join('/').toLowerCase();
      if (others.every((o) => o.slice(-depth).join('/').toLowerCase() !== suffix)) {
        return { name, hint: mine.slice(-depth).join('/') };
      }
    }
    return { name, hint: mine.join('/') };
  });
}
