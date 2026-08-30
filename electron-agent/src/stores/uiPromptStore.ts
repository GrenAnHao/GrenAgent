import { create } from 'zustand';
import type { ExtensionUiRequest } from '../lib/pi';

/**
 * ChatInput 上方的内联「交互请求」：扩展经 ctx.ui.select / confirm / input 发起的请求，
 * 不再弹 Modal，而是按 workspace 暂存于此，由 PromptRequestCard 在输入框上方渲染并回传。
 * 同一 workspace 同时只保留一条（新请求覆盖旧的）。
 */
export interface UiPromptItem {
  workspace: string;
  request: ExtensionUiRequest;
}

interface UiPromptState {
  byWorkspace: Record<string, UiPromptItem>;
  setRequest: (item: UiPromptItem) => void;
  clear: (workspace: string, id?: string) => void;
}

export const useUiPromptStore = create<UiPromptState>((set) => ({
  byWorkspace: {},
  setRequest: (item) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [item.workspace]: item } })),
  clear: (workspace, id) =>
    set((s) => {
      const cur = s.byWorkspace[workspace];
      // 仅当目标仍是该请求时才清，避免清掉已被新请求替换的条目。
      if (!cur || (id && cur.request.id !== id)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspace];
      return { byWorkspace: next };
    }),
}));
