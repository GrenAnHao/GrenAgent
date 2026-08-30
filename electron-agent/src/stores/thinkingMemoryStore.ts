import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThinkingMemoryState {
  /** modelKey(provider,id) → 上次选择的推理档位（持久化，按模型记忆）。 */
  byModel: Record<string, string>;
  /** workspace → 模型切换信号（递增）；通知 ModelThinkingAction 重新读取后端档位刷新显示。 */
  switchSeq: Record<string, number>;
  remember: (modelKey: string, level: string) => void;
  bumpSwitch: (workspace: string) => void;
}

export const useThinkingMemoryStore = create<ThinkingMemoryState>()(
  persist(
    (set) => ({
      byModel: {},
      switchSeq: {},
      remember: (modelKey, level) => set((s) => ({ byModel: { ...s.byModel, [modelKey]: level } })),
      bumpSwitch: (workspace) =>
        set((s) => ({ switchSeq: { ...s.switchSeq, [workspace]: (s.switchSeq[workspace] ?? 0) + 1 } })),
    }),
    {
      name: 'pi-thinking-memory',
      // 仅持久化按模型的档位记忆；switchSeq 是运行期信号不落盘。
      partialize: (s) => ({ byModel: s.byModel }),
    },
  ),
);
