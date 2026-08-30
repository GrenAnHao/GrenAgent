import { create } from 'zustand';

interface ContextFilesState {
  paths: string[];
  add: (path: string) => void;
  remove: (path: string) => void;
  clear: () => void;
}

export const useContextFilesStore = create<ContextFilesState>((set) => ({
  paths: [],
  add: (path) =>
    set((s) => ({
      paths: s.paths.includes(path) ? s.paths : [...s.paths, path],
    })),
  remove: (path) => set((s) => ({ paths: s.paths.filter((p) => p !== path) })),
  clear: () => set({ paths: [] }),
}));
