import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_SIDEBAR_WIDTH = 275;
export const DEFAULT_RIGHT_PANEL_WIDTH = 640;
export const DEFAULT_TERMINAL_HEIGHT = 200;

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;
/**
 * 拖左侧会话列表时，为窗口其余部分保留的最小宽度。
 * 与侧栏自身最小宽度相同，但是另一条规则：侧栏最大只能到「可用宽度 - 此值」。
 */
export const SIDEBAR_REST_MIN_WIDTH = 240;
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const TERMINAL_MIN_HEIGHT = 100;
export const TERMINAL_MAX_HEIGHT = 600;

/** 右侧标签区打开时，中间内容区至少保留的宽度。右侧没有另外的像素上限。 */
export const MAIN_COLUMN_MIN_WIDTH = 352;

/** 窗体最小宽度（对齐 tauri.conf.json 的 app.windows[].minWidth）。 */
export const WINDOW_MIN_WIDTH = 720;
/** 最左模块导航 rail 的固定宽度（对齐 ModuleRail），整行可用宽度 = 窗口宽 - rail。 */
export const MODULE_RAIL_WIDTH = 56;
/**
 * 会话列表自动收起阈值：整行可用宽度收缩到与「窗体最小宽度」相当时，自动收起左侧会话列表，
 * 把宽度整体让给对话区。= 窗体最小宽度 - rail 宽度，再留 8px 余量吸收高 DPI 缩放下的子像素测量误差。
 * 窗体不能比最小宽度更窄，故「可用宽度 <= 此值」等价于「窗体达到最小宽度时」。
 * 此宽度下停靠列放不下，顶部「展开」改为覆盖式抽屉，不改 sidebarOpen 意图。
 */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = WINDOW_MIN_WIDTH - MODULE_RAIL_WIDTH + 8;

/** 悬停滑出的会话抽屉，指针离开后多久收回。 */
export const SIDEBAR_DRAWER_HOVER_CLOSE_MS = 180;

/** 窗体窄到自动收起阈值时，会话列表不能再停靠展开，只能盖一层抽屉。尚未量到宽度时不算。 */
export function sidebarNeedsOverlay(availableWidth: number): boolean {
  return availableWidth > 0 && availableWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH;
}

export type SidebarDrawerMode = 'toggle' | 'hover';

let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

function clearSidebarHoverClose() {
  if (hoverCloseTimer != null) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
}

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
  /** 右面板占满主区域：中间内容区宽度为 0，不再保留 MAIN_COLUMN_MIN_WIDTH。 */
  rightPanelFill?: boolean;
}): PanelVisibility {
  const { availableWidth, sidebarOpen, rightPanelOpen, sidebarWidth, rightPanelWidth, dragging, rightPanelFill } = args;
  let sidebarVisible = sidebarOpen;
  let rightPanelVisible = rightPanelOpen;
  if (availableWidth <= 0) return { sidebarVisible, rightPanelVisible };

  if (rightPanelFill && rightPanelOpen) {
    if (sidebarVisible && sidebarWidth + SIDEBAR_REST_MIN_WIDTH > availableWidth) sidebarVisible = false;
    if (sidebarVisible && dragging !== 'sidebar' && availableWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH) {
      sidebarVisible = false;
    }
    const besideSidebar = sidebarVisible ? availableWidth - sidebarWidth : availableWidth;
    if (sidebarVisible && besideSidebar < RIGHT_PANEL_MIN_WIDTH) {
      if (dragging === 'sidebar') return { sidebarVisible: true, rightPanelVisible: false };
      sidebarVisible = false;
    }
    const workspace = sidebarVisible ? availableWidth - sidebarWidth : availableWidth;
    return { sidebarVisible, rightPanelVisible: workspace >= RIGHT_PANEL_MIN_WIDTH };
  }

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
  if (sidebarVisible && sidebarWidth + SIDEBAR_REST_MIN_WIDTH > availableWidth) {
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
 * 面板拖拽上限。contentReserve 是拖这一侧时必须留给其余区域的宽度：
 * 左侧会话列表留 SIDEBAR_REST_MIN_WIDTH，右侧标签区留 MAIN_COLUMN_MIN_WIDTH。
 * panelMax 不是有限数时，上限只由可用宽度和保留宽度决定。尚未量到窗口时，
 * 有限上限原样返回，没有有限上限则退回面板最小宽度。
 */
export function panelMaxWidth(
  availableWidth: number,
  panelMin: number,
  panelMax: number,
  contentReserve = MAIN_COLUMN_MIN_WIDTH,
): number {
  if (availableWidth <= 0) return Number.isFinite(panelMax) ? panelMax : panelMin;
  const cap = Number.isFinite(panelMax) ? panelMax : Number.POSITIVE_INFINITY;
  return clampValue(availableWidth - contentReserve, panelMin, cap);
}

/** 占满时右面板宽度等于侧栏让出后的整段工作区；未占满时仍用用户偏好宽度。 */
export function rightPanelOccupiedWidth(args: {
  fill: boolean;
  availableWidth: number;
  sidebarWidth: number;
  sidebarVisible: boolean;
  preferredWidth: number;
}): number {
  if (!args.fill || args.availableWidth <= 0) return args.preferredWidth;
  const workspace = args.sidebarVisible
    ? Math.max(0, args.availableWidth - args.sidebarWidth)
    : args.availableWidth;
  return Math.max(RIGHT_PANEL_MIN_WIDTH, workspace);
}

function clampRightPanelWidth(width: number, availableWidth: number): number {
  const cap =
    availableWidth > 0
      ? Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - MAIN_COLUMN_MIN_WIDTH)
      : Number.POSITIVE_INFINITY;
  return clampValue(width, RIGHT_PANEL_MIN_WIDTH, cap);
}

interface LayoutState {
  sidebarWidth: number;
  sidebarOpen: boolean;
  rightPanelWidth: number;
  rightPanelOpen: boolean;
  /** 右面板是否占满侧栏以外的区域。不持久化，关闭或拖拽宽度后清除。 */
  rightPanelFill: boolean;
  terminalHeight: number;
  terminalOpen: boolean;

  /** 运行时量到的整行可用宽度（不含最左 rail）。非持久化，由布局测量写入。 */
  availableWidth: number;
  /** 拖拽过程中的实时宽度（非持久化），用于让另一侧面板实时让位。 */
  liveSidebarWidth: number | null;
  liveRightPanelWidth: number | null;

  /**
   * 覆盖式会话抽屉。不持久化，也不改 sidebarOpen。
   * 点选会话不收回。指针完全离开这块布局，或点到布局外面，才收回。
   */
  sidebarDrawer: SidebarDrawerMode | null;

  setAvailableWidth: (w: number) => void;
  setSidebarWidth: (width: number) => void;
  setLiveSidebarWidth: (width: number | null) => void;
  toggleSidebar: () => void;
  /** 顶部按钮：抽屉开着就关；窄窗口改开抽屉；否则停靠展开/收起。 */
  requestSidebarToggle: () => void;
  openSidebarDrawer: (mode: SidebarDrawerMode) => void;
  closeSidebarDrawer: () => void;
  scheduleSidebarHoverClose: () => void;
  cancelSidebarHoverClose: () => void;
  setRightPanelWidth: (width: number) => void;
  setLiveRightPanelWidth: (width: number | null) => void;
  toggleRightPanel: () => void;
  toggleRightPanelFill: () => void;
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
    (set, get) => {
      const openRightPanel = () => {
        const s = get();
        if (s.availableWidth <= 0) {
          set({ rightPanelOpen: true });
          return;
        }
        const besideSidebar = s.availableWidth - s.sidebarWidth - MAIN_COLUMN_MIN_WIDTH;
        const keepSidebar = !s.sidebarOpen || besideSidebar >= RIGHT_PANEL_MIN_WIDTH;
        const widthBudget = keepSidebar && s.sidebarOpen ? s.availableWidth - s.sidebarWidth : s.availableWidth;
        set({
          rightPanelOpen: true,
          rightPanelWidth: clampRightPanelWidth(s.rightPanelWidth, widthBudget),
          sidebarOpen: keepSidebar ? s.sidebarOpen : false,
        });
      };

      return {
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarOpen: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      rightPanelOpen: false,
      rightPanelFill: false,
      terminalHeight: DEFAULT_TERMINAL_HEIGHT,
      terminalOpen: false,

      availableWidth: 0,
      liveSidebarWidth: null,
      liveRightPanelWidth: null,
      sidebarDrawer: null,

      setAvailableWidth: (w) => {
        const availableWidth = Math.max(0, w);
        set((state) => {
          if (!state.sidebarDrawer) return { availableWidth };
          const { sidebarVisible } = resolvePanelVisibility({
            availableWidth,
            sidebarOpen: state.sidebarOpen,
            rightPanelOpen: state.rightPanelOpen,
            sidebarWidth: state.liveSidebarWidth ?? state.sidebarWidth,
            rightPanelWidth: state.liveRightPanelWidth ?? state.rightPanelWidth,
            rightPanelFill: state.rightPanelFill,
            dragging:
              state.liveSidebarWidth != null ? 'sidebar' : state.liveRightPanelWidth != null ? 'right' : null,
          });
          // 窗口变宽后停靠列自己回来了，盖着的抽屉让位，避免两份会话列表叠在一起。
          return sidebarVisible ? { availableWidth, sidebarDrawer: null } : { availableWidth };
        });
      },

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
        if (s.rightPanelOpen && bothExceed(s)) set({ sidebarOpen: true, rightPanelOpen: false, rightPanelFill: false });
        else set({ sidebarOpen: true });
      },

      requestSidebarToggle: () => {
        const s = get();
        if (s.sidebarDrawer) {
          clearSidebarHoverClose();
          set({ sidebarDrawer: null });
          return;
        }
        if (sidebarNeedsOverlay(s.availableWidth)) {
          set({ sidebarDrawer: 'toggle' });
          return;
        }
        get().toggleSidebar();
      },

      openSidebarDrawer: (mode) => {
        clearSidebarHoverClose();
        const s = get();
        if (mode === 'hover') {
          // 只响应手动收起。自动收起时 sidebarOpen 仍为 true，走顶部按钮的抽屉。
          // 停靠列可见时 sidebarOpen 也必为 true，这里不用再派生可见性。
          if (s.sidebarDrawer === 'toggle' || s.sidebarOpen) return;
        }
        if (s.sidebarDrawer === mode) return;
        set({ sidebarDrawer: mode });
      },

      closeSidebarDrawer: () => {
        clearSidebarHoverClose();
        if (get().sidebarDrawer == null) return;
        set({ sidebarDrawer: null });
      },

      scheduleSidebarHoverClose: () => {
        if (get().sidebarDrawer == null) return;
        clearSidebarHoverClose();
        hoverCloseTimer = setTimeout(() => {
          hoverCloseTimer = null;
          if (get().sidebarDrawer != null) set({ sidebarDrawer: null });
        }, SIDEBAR_DRAWER_HOVER_CLOSE_MS);
      },

      cancelSidebarHoverClose: () => clearSidebarHoverClose(),

      setRightPanelWidth: (width) =>
        set({
          rightPanelFill: false,
          rightPanelWidth: clampRightPanelWidth(width, get().availableWidth),
          liveRightPanelWidth: null,
        }),

      setLiveRightPanelWidth: (width) =>
        set({
          liveRightPanelWidth: width == null ? null : clampRightPanelWidth(width, get().availableWidth),
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
          set({ rightPanelOpen: false, rightPanelFill: false });
          return;
        }
        // 被窗口挤掉时打开意图可能仍是 true。按当前宽度重算，否则再次展开不会改变任何状态。
        openRightPanel();
      },

      toggleRightPanelFill: () => set((state) => ({ rightPanelFill: !state.rightPanelFill })),

      setRightPanelOpen: (open) => {
        if (!open) {
          set({ rightPanelOpen: false, rightPanelFill: false });
          return;
        }
        openRightPanel();
      },

      setTerminalHeight: (height) =>
        set({ terminalHeight: clampValue(height, TERMINAL_MIN_HEIGHT, TERMINAL_MAX_HEIGHT) }),

      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

      setTerminalOpen: (open) => set({ terminalOpen: open }),
    };
    },
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
      merge: (persisted, current) => {
        const saved = persisted as Partial<LayoutState>;
        return {
          ...current,
          ...saved,
          sidebarWidth: clampValue(
            saved.sidebarWidth ?? current.sidebarWidth,
            SIDEBAR_MIN_WIDTH,
            SIDEBAR_MAX_WIDTH,
          ),
          rightPanelWidth: Math.max(RIGHT_PANEL_MIN_WIDTH, saved.rightPanelWidth ?? current.rightPanelWidth),
          rightPanelOpen: false,
          rightPanelFill: false,
          terminalOpen: false,
          sidebarDrawer: null,
        };
      },
    },
  ),
);

const visibilityArgs = (s: LayoutState) => ({
  availableWidth: s.availableWidth,
  sidebarOpen: s.sidebarOpen,
  rightPanelOpen: s.rightPanelOpen,
  sidebarWidth: s.liveSidebarWidth ?? s.sidebarWidth,
  rightPanelWidth: s.liveRightPanelWidth ?? s.rightPanelWidth,
  rightPanelFill: s.rightPanelFill,
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
