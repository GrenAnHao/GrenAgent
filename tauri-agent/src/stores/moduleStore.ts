import { create } from 'zustand';

export type ModuleId =
  | 'chat'
  | 'knowledge'
  | 'memory'
  | 'review'
  | 'create'
  | 'checkpoints'
  | 'connections'
  | 'extensions'
  | 'usage'
  | 'settings';

interface ModuleState {
  activeModule: ModuleId;
  setActiveModule: (module: ModuleId) => void;
}

// 首启一律进对话页：activeModule 不再持久化，避免重启恢复到上次停留的设置/其他页面。
export const useModuleStore = create<ModuleState>((set) => ({
  activeModule: 'chat',
  setActiveModule: (module) => set({ activeModule: module }),
}));
