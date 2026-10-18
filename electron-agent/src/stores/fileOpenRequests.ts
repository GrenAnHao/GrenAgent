import { create } from 'zustand';

/** 外部入口（交付卡、审查标签）请求「文件」标签打开某个文件。 */
export interface FileOpenRequest {
  path: string;
  nonce: number;
}

interface FileOpenRequestState {
  /** 按「文件」标签 id 存最近一次请求。只放内存：不进 dockStore 的 payload，否则重启或恢复关闭的标签会重开文件。 */
  byTab: Record<string, FileOpenRequest>;
  request: (tabId: string, path: string) => void;
  /** 标签接手请求后清掉；nonce 对不上说明期间又来了新请求，留着。 */
  consume: (tabId: string, nonce: number) => void;
}

let nonceSeq = 0;

export const useFileOpenRequests = create<FileOpenRequestState>()((set) => ({
  byTab: {},
  request: (tabId, path) => {
    nonceSeq += 1;
    set((s) => ({ byTab: { ...s.byTab, [tabId]: { path, nonce: nonceSeq } } }));
  },
  consume: (tabId, nonce) =>
    set((s) => {
      if (s.byTab[tabId]?.nonce !== nonce) return s;
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    }),
}));
