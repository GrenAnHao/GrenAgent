import { create } from 'zustand';
import { pi, type IsolatedPathKind } from '../lib/pi';

/** 当前打开的弹窗。viewer：已删除的独立工作区里的会话只读查看。 */
export type IsolatedDialog =
  | { kind: 'create'; project: string }
  | { kind: 'manage'; project: string; focusId?: string }
  | { kind: 'viewer'; sessionPath: string; title: string }
  | null;

interface IsolatedWorkspaceStore {
  /** 路径 → 主进程探测结果（侧栏、WorkspaceBar、打开会话时用）。 */
  kinds: Record<string, IsolatedPathKind>;
  dialog: IsolatedDialog;
  /** 创建 / 删除 / 回传后加一，列表类组件据此重读。 */
  revision: number;
  refreshKinds: (paths: string[]) => Promise<void>;
  setKinds: (kinds: Record<string, IsolatedPathKind>) => void;
  openCreate: (project: string) => void;
  openManage: (project: string, focusId?: string) => void;
  openViewer: (sessionPath: string, title: string) => void;
  close: () => void;
  bump: () => void;
}

export const useIsolatedWorkspaceStore = create<IsolatedWorkspaceStore>((set, get) => ({
  kinds: {},
  dialog: null,
  revision: 0,
  async refreshKinds(paths) {
    if (paths.length === 0) return;
    try {
      const result = await pi.probeIsolatedWorkspaces(paths);
      get().setKinds(result);
    } catch {
      /* 探测失败保持上一次的结果 */
    }
  },
  setKinds(kinds) {
    const prev = get().kinds;
    if (Object.entries(kinds).every(([path, kind]) => prev[path] === kind)) return;
    set({ kinds: { ...prev, ...kinds } });
  },
  openCreate: (project) => set({ dialog: { kind: 'create', project } }),
  openManage: (project, focusId) => set({ dialog: { kind: 'manage', project, ...(focusId ? { focusId } : {}) } }),
  openViewer: (sessionPath, title) => set({ dialog: { kind: 'viewer', sessionPath, title } }),
  close: () => set({ dialog: null }),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

export function isolatedKindOf(path: string): IsolatedPathKind | undefined {
  return useIsolatedWorkspaceStore.getState().kinds[path];
}
