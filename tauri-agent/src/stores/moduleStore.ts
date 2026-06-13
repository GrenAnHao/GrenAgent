import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ModuleId =
  | 'chat'
  | 'knowledge'
  | 'memory'
  | 'review'
  | 'create'
  | 'connections'
  | 'extensions'
  | 'settings';

interface ModuleState {
  activeModule: ModuleId;
  setActiveModule: (module: ModuleId) => void;
}

export const useModuleStore = create<ModuleState>()(
  persist(
    (set) => ({
      activeModule: 'chat',
      setActiveModule: (module) => set({ activeModule: module }),
    }),
    {
      name: 'grenagent-module',
      partialize: (state) => ({ activeModule: state.activeModule }),
    },
  ),
);
