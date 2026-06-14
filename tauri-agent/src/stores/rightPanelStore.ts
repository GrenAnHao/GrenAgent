import { create } from 'zustand';
import { useLayoutStore } from './layoutStore';

/** A crawled page surfaced in the right panel (opened from a fetch_url card). */
export interface PageView {
  url: string;
  content: string;
  title?: string;
  chars?: number;
  crawler?: string;
}

/** A manually-opened right-panel tab (currently page content; extensible to more kinds). */
export interface PageTab {
  id: string;
  title: string;
  page: PageView;
}

interface RightPanelState {
  /** Manually-opened tabs (sub-agent tabs are derived from messages in RightPanel). */
  pageTabs: PageTab[];
  /** Active tab id — may be a page tab id or a sub-agent message id. */
  activeId: string | null;
  openPage: (page: PageView) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
}

/**
 * Generic right-panel tab control: any content can be opened as a tab and switched
 * between. fetch_url cards open page tabs here; sub-agents appear as tabs too.
 */
export const useRightPanelStore = create<RightPanelState>((set) => ({
  pageTabs: [],
  activeId: null,
  openPage: (page) => {
    const id = `page:${page.url}`;
    set((s) => ({
      pageTabs: s.pageTabs.some((t) => t.id === id)
        ? s.pageTabs.map((t) => (t.id === id ? { ...t, page, title: page.title || page.url } : t))
        : [...s.pageTabs, { id, title: page.title || page.url, page }],
      activeId: id,
    }));
    useLayoutStore.getState().setRightPanelOpen(true);
  },
  closeTab: (id) =>
    set((s) => {
      const pageTabs = s.pageTabs.filter((t) => t.id !== id);
      return {
        pageTabs,
        activeId: s.activeId === id ? (pageTabs.at(-1)?.id ?? null) : s.activeId,
      };
    }),
  setActive: (id) => set({ activeId: id }),
}));
