import { create } from 'zustand';
import type { CatalogActivity } from '../lib/pi';

export type ChildOverlayMode = 'one-shot' | 'continuable';

export interface ChildOverlay {
  id: string;
  sessionPath: string;
  parentSessionPath: string;
  label: string;
  mode: ChildOverlayMode;
  activity: CatalogActivity;
  tornDown: boolean;
}

export function deriveTornDown(mode: ChildOverlayMode, activity: CatalogActivity): boolean {
  if (activity === 'unavailable') return true;
  if (mode === 'continuable' && activity === 'settled') return true;
  return false;
}

interface ChildOverlayState {
  overlay: ChildOverlay | null;
  error: string | null;
  open: (child: Omit<ChildOverlay, 'tornDown'> & { tornDown?: boolean }) => void;
  close: () => void;
  setActivity: (activity: CatalogActivity) => void;
  setTornDown: (v: boolean) => void;
  setError: (message: string | null) => void;
}

export const useChildOverlayStore = create<ChildOverlayState>((set) => ({
  overlay: null,
  error: null,
  open: (child) =>
    set({
      overlay: {
        id: child.id,
        sessionPath: child.sessionPath,
        parentSessionPath: child.parentSessionPath,
        label: child.label,
        mode: child.mode,
        activity: child.activity,
        tornDown: child.tornDown ?? deriveTornDown(child.mode, child.activity),
      },
      error: null,
    }),
  close: () => set({ overlay: null, error: null }),
  setActivity: (activity) =>
    set((s) => (s.overlay ? { overlay: { ...s.overlay, activity } } : s)),
  setTornDown: (tornDown) =>
    set((s) => (s.overlay ? { overlay: { ...s.overlay, tornDown } } : s)),
  setError: (error) => set({ error }),
}));
