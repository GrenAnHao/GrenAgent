import { create } from 'zustand';
import type { FindStatus } from './domFinder';

/** 一个「可查找的地方」：会话是 'chat'，每个文件标签用它的标签 id。 */
export interface FindScopeState {
  open: boolean;
  query: string;
  status: FindStatus;
  /** 每按一次 Ctrl+F（含已经打开时）+1：查找栏据此把焦点放回输入框并全选。 */
  focusNonce: number;
  /** 上 / 下一个的请求。nonce 变了驱动才动作，避免把「方向」当成持久状态。 */
  nav: { dir: 'next' | 'prev'; nonce: number };
}

const EMPTY: FindScopeState = {
  open: false,
  query: '',
  status: { total: 0, current: 0 },
  focusNonce: 0,
  nav: { dir: 'next', nonce: 0 },
};

interface FindStoreState {
  scopes: Record<string, FindScopeState>;
  open: (scope: string, initialQuery?: string) => void;
  close: (scope: string) => void;
  setQuery: (scope: string, query: string) => void;
  setStatus: (scope: string, status: FindStatus) => void;
  navigate: (scope: string, dir: 'next' | 'prev') => void;
  forget: (scope: string) => void;
}

export const useFindStore = create<FindStoreState>()((set) => {
  const patch = (scope: string, fn: (cur: FindScopeState) => Partial<FindScopeState>) =>
    set((state) => {
      const cur = state.scopes[scope] ?? EMPTY;
      return { scopes: { ...state.scopes, [scope]: { ...cur, ...fn(cur) } } };
    });
  return {
    scopes: {},
    // 已经打开时再 open：只重新聚焦并全选，不动查询；没打开时用选中文字预填。
    open: (scope, initialQuery) =>
      patch(scope, (cur) =>
        cur.open
          ? { focusNonce: cur.focusNonce + 1 }
          : { open: true, query: initialQuery ?? cur.query, focusNonce: cur.focusNonce + 1 },
      ),
    close: (scope) => patch(scope, () => ({ open: false, status: EMPTY.status })),
    setQuery: (scope, query) => patch(scope, () => ({ query })),
    setStatus: (scope, status) => patch(scope, () => ({ status })),
    navigate: (scope, dir) => patch(scope, (cur) => ({ nav: { dir, nonce: cur.nav.nonce + 1 } })),
    forget: (scope) =>
      set((state) => {
        if (!(scope in state.scopes)) return state;
        const scopes = { ...state.scopes };
        delete scopes[scope];
        return { scopes };
      }),
  };
});

export function useFindScope(scope: string): FindScopeState {
  return useFindStore((state) => state.scopes[scope] ?? EMPTY);
}

export const EMPTY_FIND_SCOPE = EMPTY;
