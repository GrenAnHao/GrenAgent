import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const DEFAULT_RIGHT_PANEL_WIDTH = 320;
export const DEFAULT_TERMINAL_HEIGHT = 200;

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 600;
export const RIGHT_PANEL_MIN_WIDTH = 200;
export const RIGHT_PANEL_MAX_WIDTH = 800;
export const TERMINAL_MIN_HEIGHT = 100;
export const TERMINAL_MAX_HEIGHT = 600;

/** 展开面板时给中间对话区保留的最小宽度，是自动折叠 / 防溢出的核心阈值。 */
export const MAIN_COLUMN_MIN_WIDTH = 320;

/** 窗体最小宽度（对齐 tauri.conf.json 的 app.windows[].minWidth）。 */
export const WINDOW_MIN_WIDTH = 720;
/** 最左模块导航 rail 的固定宽度（对齐 ModuleRail），整行可用宽度 = 窗口宽 - rail。 */
export const MODULE_RAIL_WIDTH = 56;
/**
 * 会话列表自动收起阈值：整行可用宽度收缩到与「窗体最小宽度」相当时，自动收起左侧会话列表，
 * 把宽度整体让给对话区。= 窗体最小宽度 - rail 宽度，再留 8px 余量吸收高 DPI 缩放下的子像素测量误差。
 * 窗体不能比最小宽度更窄，故「可用宽度 <= 此值」等价于「窗体达到最小宽度时」。
 */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = WINDOW_MIN_WIDTH - MODULE_RAIL_WIDTH + 8;

const clampValue = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export interface PanelVisibility {
  sidebarVisible: boolean;
  rightPanelVisible: boolean;
}

/**
 * 按整行可用宽度（侧栏 + 对话区 + 右面板，不含最左 rail）解析两个面板的「实际可见性」。
 * 不改变用户意图（*Open 标志），只在空间不足时按优先级折叠，窗口/面板变化时纯派生地自动恢复：
 * - 默认（窗口被挤压）：先收左侧栏 → 再收右面板 → 只剩对话区。
 * - dragging='sidebar'（正在拖宽左侧栏）：放不下时改为先挤掉右面板（"谁被操作谁优先"）。
 * - dragging='right'（正在拖宽右面板）：放不下时挤掉左侧栏。
 * - 窗体达到最小宽度（availableWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH）：即使还放得下，也自动收起左侧会话列表（正拖拽侧栏时不收）。
 * availableWidth<=0（尚未量到）时直接返回意图，避免首帧误折叠。
 */
export function resolvePanelVisibility(args: {
  availableWidth: number;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  dragging?: 'sidebar' | 'right' | null;
}): PanelVisibility {
  const { availableWidth, sidebarOpen, rightPanelOpen, sidebarWidth, rightPanelWidth, dragging } = args;
  let sidebarVisible = sidebarOpen;
  let rightPanelVisible = rightPanelOpen;
  if (availableWidth <= 0) return { sidebarVisible, rightPanelVisible };

  if (
    sidebarVisible &&
    rightPanelVisible &&
    sidebarWidth + rightPanelWidth + MAIN_COLUMN_MIN_WIDTH > availableWidth
  ) {
    // 两个都放不下：正在拖宽某一侧时让另一侧让位，否则按默认优先级先收左侧栏。
    if (dragging === 'sidebar') rightPanelVisible = false;
    else sidebarVisible = false;
  }
  if (rightPanelVisible && rightPanelWidth + MAIN_COLUMN_MIN_WIDTH > availableWidth) {
    rightPanelVisible = false;
  }
  if (sidebarVisible && sidebarWidth + MAIN_COLUMN_MIN_WIDTH > availableWidth) {
    sidebarVisible = false;
  }
  // 窗体收缩到最小宽度：即使空间还放得下，也自动收起左侧会话列表，把整行宽度让给对话区。
  // 正拖拽侧栏时不收（沿用"谁被操作谁优先"）；窗体变宽后纯派生地自动恢复。
  if (sidebarVisible && dragging !== 'sidebar' && availableWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH) {
    sidebarVisible = false;
  }
  return { sidebarVisible, rightPanelVisible };
}

/**
 * 面板拖拽 / 展开时的自适应宽度上限：只为对话区保留 MAIN_COLUMN_MIN_WIDTH，
 * 其余空间都可占用（拖到极限时另一侧面板会被 resolver 自动让位），从而保证永远收在窗口内。
 */
export function panelMaxWidth(availableWidth: number, panelMin: number, panelMax: number): number {
  if (availableWidth <= 0) return panelMax;
  return clampValue(availableWidth - MAIN_COLUMN_MIN_WIDTH, panelMin, panelMax);
}

interface LayoutState {
  sidebarWidth: number;
  sidebarOpen: boolean;
  rightPanelWidth: number;
  rightPanelOpen: boolean;
  terminalHeight: number;
  terminalOpen: boolean;

  /** 运行时量到的整行可用宽度（不含最左 rail）。非持久化，由布局测量写入。 */
  availableWidth: number;
  /** 拖拽过程中的实时宽度（非持久化），用于让另一侧面板实时让位。 */
  liveSidebarWidth: number | null;
  liveRightPanelWidth: number | null;

  setAvailableWidth: (w: number) => void;
  setSidebarWidth: (width: number) => void;
  setLiveSidebarWidth: (width: number | null) => void;
  toggleSidebar: () => void;
  setRightPanelWidth: (width: number) => void;
  setLiveRightPanelWidth: (width: number | null) => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  setTerminalHeight: (height: number) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
}

/** 两个面板都想展开但放不下：返回 true 表示需要挤掉一个（手动打开/setOpen 时据此让位）。 */
function bothExceed(s: Pick<LayoutState, 'availableWidth' | 'sidebarWidth' | 'rightPanelWidth'>): boolean {
  return (
    s.availableWidth > 0 &&
    s.sidebarWidth + s.rightPanelWidth + MAIN_COLUMN_MIN_WIDTH > s.availableWidth
  );
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarOpen: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      rightPanelOpen: false,
      terminalHeight: DEFAULT_TERMINAL_HEIGHT,
      terminalOpen: false,

      availableWidth: 0,
      liveSidebarWidth: null,
      liveRightPanelWidth: null,

      setAvailableWidth: (w) => set({ availableWidth: Math.max(0, w) }),

      setSidebarWidth: (width) =>
        set({
          sidebarWidth: clampValue(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
          liveSidebarWidth: null,
        }),

      setLiveSidebarWidth: (width) =>
        set({
          liveSidebarWidth: width == null ? null : clampValue(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        }),

      toggleSidebar: () => {
        const s = get();
        const { sidebarVisible } = resolvePanelVisibility({
          availableWidth: s.availableWidth,
          sidebarOpen: s.sidebarOpen,
          rightPanelOpen: s.rightPanelOpen,
          sidebarWidth: s.sidebarWidth,
          rightPanelWidth: s.rightPanelWidth,
        });
        if (sidebarVisible) {
          set({ sidebarOpen: false });
          return;
        }
        // 手动展开左侧栏：放不下时按「谁被操作谁优先」挤掉右面板。
        if (s.rightPanelOpen && bothExceed(s)) set({ sidebarOpen: true, rightPanelOpen: false });
        else set({ sidebarOpen: true });
      },

      setRightPanelWidth: (width) =>
        set({
          rightPanelWidth: clampValue(width, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH),
          liveRightPanelWidth: null,
        }),

      setLiveRightPanelWidth: (width) =>
        set({
          liveRightPanelWidth:
            width == null ? null : clampValue(width, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH),
        }),

      toggleRightPanel: () => {
        const s = get();
        const { rightPanelVisible } = resolvePanelVisibility({
          availableWidth: s.availableWidth,
          sidebarOpen: s.sidebarOpen,
          rightPanelOpen: s.rightPanelOpen,
          sidebarWidth: s.sidebarWidth,
          rightPanelWidth: s.rightPanelWidth,
        });
        if (rightPanelVisible) {
          set({ rightPanelOpen: false });
          return;
        }
        if (s.sidebarOpen && bothExceed(s)) set({ rightPanelOpen: true, sidebarOpen: false });
        else set({ rightPanelOpen: true });
      },

      setRightPanelOpen: (open) => {
        if (!open) {
          set({ rightPanelOpen: false });
          return;
        }
        const s = get();
        // 程序化打开右面板（拖入内容 / 子代理）：放不下时挤掉左侧栏。
        if (s.sidebarOpen && bothExceed(s)) set({ rightPanelOpen: true, sidebarOpen: false });
        else set({ rightPanelOpen: true });
      },

      setTerminalHeight: (height) =>
        set({ terminalHeight: clampValue(height, TERMINAL_MIN_HEIGHT, TERMINAL_MAX_HEIGHT) }),

      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

      setTerminalOpen: (open) => set({ terminalOpen: open }),
    }),
    {
      name: 'hermes-layout',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        sidebarOpen: state.sidebarOpen,
        rightPanelWidth: state.rightPanelWidth,
        terminalHeight: state.terminalHeight,
      }),
      // 右面板 / 底部终端：启动一律默认关闭，不跟随上次会话的开关状态恢复
      //（用户要求「启动界面默认不打开右侧面板 / 底部终端面板」）。因此不持久化 rightPanelOpen / terminalOpen，
      // 并在 rehydrate 合并时强制为 false——兼容旧 localStorage 里已存的 true。
      // 宽度 / 高度仍持久化：用户再次打开时沿用其偏好尺寸；会话内打开 / 关闭照常工作。
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<LayoutState>),
        rightPanelOpen: false,
        terminalOpen: false,
      }),
    },
  ),
);

const visibilityArgs = (s: LayoutState) => ({
  availableWidth: s.availableWidth,
  sidebarOpen: s.sidebarOpen,
  rightPanelOpen: s.rightPanelOpen,
  sidebarWidth: s.liveSidebarWidth ?? s.sidebarWidth,
  rightPanelWidth: s.liveRightPanelWidth ?? s.rightPanelWidth,
  dragging: (s.liveSidebarWidth != null ? 'sidebar' : s.liveRightPanelWidth != null ? 'right' : null) as
    | 'sidebar'
    | 'right'
    | null,
});

/** 选择器：派生出的左侧栏实际可见性（拖拽中用 live 宽度，实时反映让位）。 */
export const selectSidebarVisible = (s: LayoutState) => resolvePanelVisibility(visibilityArgs(s)).sidebarVisible;
/** 选择器：派生出的右面板实际可见性。 */
export const selectRightPanelVisible = (s: LayoutState) =>
  resolvePanelVisibility(visibilityArgs(s)).rightPanelVisible;
