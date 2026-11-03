import { create } from 'zustand';
import { pi } from '../lib/pi';

interface FastState {
  byModel: Record<string, boolean>;
  pending: Record<string, boolean>;
  loaded: boolean;
  loading: boolean;
  error: 'load' | 'save' | null;
  load: (force?: boolean) => Promise<void>;
  remember: (key: string, provider: string, id: string, enabled: boolean) => Promise<void>;
}
let revision = 0;

/** Disk is authoritative for both UI and provider processes; no second localStorage copy. */
export const useFastModeStore = create<FastState>((set, get) => ({
  byModel: {}, pending: {}, loaded: false, loading: false, error: null,
  load: async (force = false) => {
    if (get().loading || (!force && get().loaded) || Object.values(get().pending).some(Boolean)) return;
    const start = revision;
    set({ loading: true, error: null });
    try {
      const byModel = await pi.getModelFastPreferences();
      if (start === revision) set({ byModel, loaded: true });
    } catch { set({ error: 'load' }); }
    finally { set({ loading: false }); }
  },
  remember: async (key, provider, id, enabled) => {
    if (!get().loaded || get().pending[key]) return;
    revision++;
    set((s) => ({ pending: { ...s.pending, [key]: true }, error: null }));
    try {
      const saved = await pi.setModelFastPreference(provider, id, enabled);
      set((s) => ({ byModel: { ...s.byModel, [key]: saved[key] === true } }));
    } catch { set({ error: 'save' }); }
    finally { set((s) => ({ pending: { ...s.pending, [key]: false } })); }
  },
}));
