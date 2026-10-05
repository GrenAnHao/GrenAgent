import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rememberBrowserHistory, type BrowserHistoryEntry } from './browserHistory';

interface BrowserHistoryState {
  entries: BrowserHistoryEntry[];
  remember: (input: { url: string; title?: string; faviconUrl?: string }) => void;
}

export const useBrowserHistoryStore = create<BrowserHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      remember: (input) => set({ entries: rememberBrowserHistory(get().entries, input) }),
    }),
    {
      name: 'gren-browser-history',
      partialize: (state) => ({ entries: state.entries }),
    },
  ),
);
