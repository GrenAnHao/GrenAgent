import { create } from 'zustand';
import type { QSData } from '../components/QuestionSelector/answers';

export interface InlineQuestionItem {
  workspace: string;
  id: string;
  data: QSData;
}

interface InlineQuestionState {
  byWorkspace: Record<string, InlineQuestionItem>;
  setRequest: (item: InlineQuestionItem) => void;
  clear: (workspace: string, id?: string) => void;
}

/**
 * 阻塞式 ask_user 富卡请求：经 ctx.ui.input 载荷送到前端，识别哨兵后暂存于此，
 * 由消息列表末尾的 InlineQuestionCard 渲染并经 extension_ui_response 回传。
 * 同一 workspace 同时只保留一条（新请求覆盖旧的）。
 */
export const useInlineQuestionStore = create<InlineQuestionState>((set) => ({
  byWorkspace: {},
  setRequest: (item) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [item.workspace]: item } })),
  clear: (workspace, id) =>
    set((s) => {
      const cur = s.byWorkspace[workspace];
      // 仅当目标仍是该请求时才清，避免清掉已被新请求替换的条目。
      if (!cur || (id && cur.id !== id)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspace];
      return { byWorkspace: next };
    }),
}));
