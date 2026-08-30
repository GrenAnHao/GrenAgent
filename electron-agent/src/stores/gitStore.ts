import { create } from 'zustand';
import { pi, type BranchInfo, type GitFileStatus } from '../lib/pi';

/** 某 workspace 的 git 概况（分支 + 未提交改动），供功能栏徽标 / 下拉 / diff 共享。 */
export interface GitInfo {
  current: string;
  branches: BranchInfo[];
  changes: GitFileStatus[];
  loading: boolean;
  loaded: boolean;
}

/** 稳定空值引用：useGitInfo 未命中时返回同一对象，避免触发无意义重渲染。 */
const EMPTY: GitInfo = { current: '', branches: [], changes: [], loading: false, loaded: false };

interface GitStoreState {
  byWorkspace: Record<string, GitInfo>;
  /** 拉取分支 + 改动；已加载且非 force 时跳过（打开下拉/收到 agent 事件时传 force 刷新）。 */
  load: (workspace: string, force?: boolean) => Promise<void>;
}

export const useGitStore = create<GitStoreState>((set, get) => ({
  byWorkspace: {},
  load: async (workspace, force = false) => {
    if (!workspace) return;
    const cur = get().byWorkspace[workspace];
    if (cur?.loading) return;
    if (cur?.loaded && !force) return;

    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspace]: { ...(s.byWorkspace[workspace] ?? EMPTY), loading: true },
      },
    }));

    try {
      const [branches, changes] = await Promise.all([
        pi.getGitBranches(workspace),
        pi.getGitStatus(workspace),
      ]);
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspace]: {
            current: branches.current,
            branches: branches.branches,
            changes,
            loading: false,
            loaded: true,
          },
        },
      }));
    } catch {
      // 非 git 仓库 / git 缺失：标记已加载但保持空，功能栏据此隐藏。
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspace]: { ...(s.byWorkspace[workspace] ?? EMPTY), loading: false, loaded: true },
        },
      }));
    }
  },
}));

/** 读取某 workspace 的 git 概况（未命中返回稳定空值）。 */
export function useGitInfo(workspace: string): GitInfo {
  return useGitStore((s) => s.byWorkspace[workspace] ?? EMPTY);
}
