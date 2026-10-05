import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  panelMaxWidth,
  resolvePanelVisibility,
  rightPanelOccupiedWidth,
  selectSidebarVisible,
  selectRightPanelVisible,
  useLayoutStore,
  MAIN_COLUMN_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  SIDEBAR_DRAWER_HOVER_CLOSE_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_REST_MIN_WIDTH,
} from './layoutStore';

const base = {
  sidebarOpen: true,
  rightPanelOpen: true,
  sidebarWidth: 240,
  rightPanelWidth: 320,
};

describe('persist merge (启动默认不打开右侧面板 / 底部终端)', () => {
  it('rehydrate 时强制 rightPanelOpen=false（即便上次存的是 true），但保留宽度等其它持久化字段', () => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const merged = merge(
      { rightPanelOpen: true, rightPanelWidth: 500, sidebarOpen: false },
      useLayoutStore.getState(),
    ) as ReturnType<typeof useLayoutStore.getState>;
    expect(merged.rightPanelOpen).toBe(false);
    expect(merged.rightPanelWidth).toBe(500);
    expect(merged.sidebarOpen).toBe(false);
  });

  it('rehydrate 时强制 terminalOpen=false（即便上次存的是 true），但保留 terminalHeight', () => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const merged = merge(
      { terminalOpen: true, terminalHeight: 350 },
      useLayoutStore.getState(),
    ) as ReturnType<typeof useLayoutStore.getState>;
    expect(merged.terminalOpen).toBe(false);
    expect(merged.terminalHeight).toBe(350);
  });

  it('rehydrate 时把旧的侧栏和右面板宽度夹进新范围', () => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const merged = merge(
      { sidebarWidth: 180, rightPanelWidth: 200 },
      useLayoutStore.getState(),
    ) as ReturnType<typeof useLayoutStore.getState>;
    expect(merged.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(merged.rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);

    const wide = merge(
      { sidebarWidth: 600, rightPanelWidth: 900 },
      useLayoutStore.getState(),
    ) as ReturnType<typeof useLayoutStore.getState>;
    expect(wide.sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    expect(wide.rightPanelWidth).toBe(900);
  });
});

describe('resolvePanelVisibility', () => {
  it('尚未量到宽度（<=0）时直接按意图，不折叠', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 0 })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: true,
    });
  });

  it('空间充足时两个都显示', () => {
    // 240 + 320 + 352 = 912 <= 1000
    expect(resolvePanelVisibility({ ...base, availableWidth: 1000 })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: true,
    });
  });

  it('挤压（窗口变窄）时默认先收左侧栏，保留右面板', () => {
    // 912 > 700，先收左侧栏；右面板 320 + 352 = 672 <= 700 保留
    expect(resolvePanelVisibility({ ...base, availableWidth: 700 })).toEqual({
      sidebarVisible: false,
      rightPanelVisible: true,
    });
  });

  it('正在拖宽左侧栏时改为挤掉右面板（谁被操作谁优先）', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 700, dragging: 'sidebar' })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: false,
    });
  });

  it('正在拖宽右面板时挤掉左侧栏', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 700, dragging: 'right' })).toEqual({
      sidebarVisible: false,
      rightPanelVisible: true,
    });
  });

  it('空间极小到右面板也放不下时只剩对话区', () => {
    expect(
      resolvePanelVisibility({
        availableWidth: 400,
        sidebarOpen: false,
        rightPanelOpen: true,
        sidebarWidth: 240,
        rightPanelWidth: 320,
      }),
    ).toEqual({ sidebarVisible: false, rightPanelVisible: false });
  });

  it('窗体达到最小宽度时自动收起会话列表（右面板关闭，空间仍放得下也收）', () => {
    // 240 + 320 = 560 <= 664 本可放下，但 664 <= 阈值 → 仍收起，让对话区拿到整行宽度
    expect(
      resolvePanelVisibility({
        availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
        sidebarOpen: true,
        rightPanelOpen: false,
        sidebarWidth: 240,
        rightPanelWidth: 320,
      }),
    ).toEqual({ sidebarVisible: false, rightPanelVisible: false });
  });

  it('窗体宽于最小宽度阈值时会话列表正常显示', () => {
    expect(
      resolvePanelVisibility({
        availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH + 1,
        sidebarOpen: true,
        rightPanelOpen: false,
        sidebarWidth: 240,
        rightPanelWidth: 320,
      }),
    ).toEqual({ sidebarVisible: true, rightPanelVisible: false });
  });

  it('达到最小宽度但正在拖宽侧栏时不自动收起（谁被操作谁优先）', () => {
    expect(
      resolvePanelVisibility({
        availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
        sidebarOpen: true,
        rightPanelOpen: false,
        sidebarWidth: 240,
        rightPanelWidth: 320,
        dragging: 'sidebar',
      }),
    ).toEqual({ sidebarVisible: true, rightPanelVisible: false });
  });

  it('窗体从最小宽度变大后会话列表自动恢复（纯派生，不改意图）', () => {
    const args = {
      sidebarOpen: true,
      rightPanelOpen: false,
      sidebarWidth: 240,
      rightPanelWidth: 320,
    };
    expect(resolvePanelVisibility({ ...args, availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH })).toEqual({
      sidebarVisible: false,
      rightPanelVisible: false,
    });
    expect(resolvePanelVisibility({ ...args, availableWidth: 1000 })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: false,
    });
  });

  it('占满时右面板盖住中间内容区，左侧会话列表留得下就保留', () => {
    expect(resolvePanelVisibility({
      availableWidth: 1000,
      sidebarOpen: true,
      rightPanelOpen: true,
      sidebarWidth: 275,
      rightPanelWidth: 1100,
      rightPanelFill: true,
    })).toEqual({ sidebarVisible: true, rightPanelVisible: true });
    expect(rightPanelOccupiedWidth({
      fill: true,
      availableWidth: 1000,
      sidebarWidth: 275,
      sidebarVisible: true,
      preferredWidth: 1100,
    })).toBe(725);
  });

  it('占满时会话列表挤到右面板最小宽度以下就让位', () => {
    expect(resolvePanelVisibility({
      availableWidth: 800,
      sidebarOpen: true,
      rightPanelOpen: true,
      sidebarWidth: 520,
      rightPanelWidth: 640,
      rightPanelFill: true,
    })).toEqual({ sidebarVisible: false, rightPanelVisible: true });
    expect(rightPanelOccupiedWidth({
      fill: true,
      availableWidth: 800,
      sidebarWidth: 520,
      sidebarVisible: false,
      preferredWidth: 640,
    })).toBe(800);
  });
});

describe('panelMaxWidth', () => {
  it('未量到宽度时，有限上限原样返回，没有有限上限则退回最小宽度', () => {
    expect(panelMaxWidth(0, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_REST_MIN_WIDTH)).toBe(
      SIDEBAR_MAX_WIDTH,
    );
    expect(panelMaxWidth(0, RIGHT_PANEL_MIN_WIDTH, Number.POSITIVE_INFINITY)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('右侧标签区只给内容区保留 MAIN_COLUMN_MIN_WIDTH，宽窗口不再另设像素上限', () => {
    expect(panelMaxWidth(1000, RIGHT_PANEL_MIN_WIDTH, Number.POSITIVE_INFINITY)).toBe(
      1000 - MAIN_COLUMN_MIN_WIDTH,
    );
    expect(panelMaxWidth(5000, RIGHT_PANEL_MIN_WIDTH, Number.POSITIVE_INFINITY)).toBe(
      5000 - MAIN_COLUMN_MIN_WIDTH,
    );
  });

  it('左侧会话列表不超过 520，并且至少给其余区域留 SIDEBAR_REST_MIN_WIDTH', () => {
    expect(panelMaxWidth(5000, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_REST_MIN_WIDTH)).toBe(
      SIDEBAR_MAX_WIDTH,
    );
    expect(panelMaxWidth(700, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_REST_MIN_WIDTH)).toBe(
      700 - SIDEBAR_REST_MIN_WIDTH,
    );
  });

  it('窗口很窄时不低于面板最小宽度', () => {
    expect(panelMaxWidth(400, RIGHT_PANEL_MIN_WIDTH, Number.POSITIVE_INFINITY)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(panelMaxWidth(400, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_REST_MIN_WIDTH)).toBe(
      SIDEBAR_MIN_WIDTH,
    );
  });
});

describe('useLayoutStore 挤位与自动恢复', () => {
  beforeEach(() => {
    localStorage.clear();
    useLayoutStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      sidebarWidth: 240,
      rightPanelWidth: 320,
      availableWidth: 700,
      liveSidebarWidth: null,
      liveRightPanelWidth: null,
      rightPanelFill: false,
      sidebarDrawer: null,
    });
  });

  it('侧栏宽度夹在 240 到 520，右面板在已测量窗口里不超过内容区保留后的剩余宽度', () => {
    useLayoutStore.getState().setSidebarWidth(100);
    expect(useLayoutStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    useLayoutStore.getState().setSidebarWidth(900);
    expect(useLayoutStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);

    useLayoutStore.getState().setAvailableWidth(1200);
    useLayoutStore.getState().setRightPanelWidth(200);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
    useLayoutStore.getState().setRightPanelWidth(2000);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(1200 - MAIN_COLUMN_MIN_WIDTH);
  });

  it('右面板拉满后窗口变窄再变宽，展开会把宽度收到当前放得下的上限', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      rightPanelOpen: true,
      sidebarWidth: 275,
      rightPanelWidth: 1100,
      availableWidth: 1000,
      liveSidebarWidth: null,
      liveRightPanelWidth: null,
    });
    expect(selectRightPanelVisible(useLayoutStore.getState())).toBe(false);

    useLayoutStore.getState().toggleRightPanel();

    const next = useLayoutStore.getState();
    expect(next.rightPanelOpen).toBe(true);
    expect(next.sidebarOpen).toBe(true);
    expect(next.rightPanelWidth).toBe(1000 - 275 - MAIN_COLUMN_MIN_WIDTH);
    expect(selectRightPanelVisible(next)).toBe(true);
  });

  it('占满不改偏好宽度，关闭或再拖拽后退出占满', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      rightPanelOpen: true,
      sidebarWidth: 275,
      rightPanelWidth: 640,
      availableWidth: 1400,
      rightPanelFill: false,
    });
    useLayoutStore.getState().toggleRightPanelFill();
    expect(useLayoutStore.getState().rightPanelFill).toBe(true);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(640);
    expect(selectSidebarVisible(useLayoutStore.getState())).toBe(true);
    expect(selectRightPanelVisible(useLayoutStore.getState())).toBe(true);
    expect(rightPanelOccupiedWidth({
      fill: true,
      availableWidth: 1400,
      sidebarWidth: 275,
      sidebarVisible: true,
      preferredWidth: 640,
    })).toBe(1125);

    useLayoutStore.getState().toggleRightPanelFill();
    expect(useLayoutStore.getState().rightPanelFill).toBe(false);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(640);

    useLayoutStore.getState().toggleRightPanelFill();
    useLayoutStore.getState().setRightPanelWidth(700);
    expect(useLayoutStore.getState().rightPanelFill).toBe(false);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(700);

    useLayoutStore.getState().toggleRightPanelFill();
    useLayoutStore.getState().toggleRightPanel();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    expect(useLayoutStore.getState().rightPanelFill).toBe(false);
  });

  it('放不下时手动打开右面板会挤掉左侧栏', () => {
    useLayoutStore.getState().toggleRightPanel();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
  });

  it('放不下时手动打开左侧栏会挤掉右面板', () => {
    useLayoutStore.setState({ sidebarOpen: false, rightPanelOpen: true });
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('尚未量到宽度时打开右面板不挤掉左侧栏（兼容初始/测试态）', () => {
    useLayoutStore.setState({ sidebarOpen: true, rightPanelOpen: false, availableWidth: 0 });
    useLayoutStore.getState().setRightPanelOpen(true);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('窗口变大后被挤压收起的面板自动恢复（纯派生，不改意图）', () => {
    useLayoutStore.setState({ sidebarOpen: true, rightPanelOpen: true, availableWidth: 700 });
    // 挤压态：左侧栏被收起
    expect(selectSidebarVisible(useLayoutStore.getState())).toBe(false);
    expect(selectRightPanelVisible(useLayoutStore.getState())).toBe(true);
    // 意图仍是打开
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
    // 窗口变大 → 自动恢复
    useLayoutStore.getState().setAvailableWidth(1000);
    expect(selectSidebarVisible(useLayoutStore.getState())).toBe(true);
    expect(selectRightPanelVisible(useLayoutStore.getState())).toBe(true);
  });
});

describe('会话抽屉', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      sidebarWidth: 275,
      rightPanelWidth: 320,
      availableWidth: 1200,
      sidebarDrawer: null,
      rightPanelFill: false,
    });
  });

  afterEach(() => {
    useLayoutStore.getState().cancelSidebarHoverClose();
    useLayoutStore.setState({ sidebarDrawer: null });
    vi.useRealTimers();
  });

  it('窄到自动收起阈值时，顶部展开改为抽屉，不改停靠意图', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
    });
    useLayoutStore.getState().requestSidebarToggle();
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
    useLayoutStore.getState().requestSidebarToggle();
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('抽屉已经打开时，再点顶部按钮只收回抽屉', () => {
    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: 'hover', availableWidth: 1200 });
    useLayoutStore.getState().requestSidebarToggle();
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
  });

  it('宽度够停靠时，顶部按钮仍然展开或收起会话列', () => {
    useLayoutStore.setState({ sidebarOpen: false, availableWidth: 1200, sidebarDrawer: null });
    useLayoutStore.getState().requestSidebarToggle();
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('手动收起后才能悬停滑出；自动收起或已经用按钮打开时不再降成悬停', () => {
    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: null });
    useLayoutStore.getState().openSidebarDrawer('hover');
    expect(useLayoutStore.getState().sidebarDrawer).toBe('hover');

    useLayoutStore.setState({ sidebarOpen: true, sidebarDrawer: null });
    useLayoutStore.getState().openSidebarDrawer('hover');
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();

    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: 'toggle' });
    useLayoutStore.getState().openSidebarDrawer('hover');
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
  });

  it('悬停滑出在指针离开后收回，回到抽屉上则取消收回', () => {
    vi.useFakeTimers();
    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: null });
    useLayoutStore.getState().openSidebarDrawer('hover');
    useLayoutStore.getState().scheduleSidebarHoverClose();
    useLayoutStore.getState().cancelSidebarHoverClose();
    vi.advanceTimersByTime(SIDEBAR_DRAWER_HOVER_CLOSE_MS);
    expect(useLayoutStore.getState().sidebarDrawer).toBe('hover');

    useLayoutStore.getState().scheduleSidebarHoverClose();
    vi.advanceTimersByTime(SIDEBAR_DRAWER_HOVER_CLOSE_MS);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('窗口变宽后停靠列恢复时关掉抽屉；手动收起的抽屉留着', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
      sidebarDrawer: 'toggle',
      rightPanelOpen: false,
    });
    useLayoutStore.getState().setAvailableWidth(1000);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
    expect(selectSidebarVisible(useLayoutStore.getState())).toBe(true);

    useLayoutStore.setState({
      sidebarOpen: false,
      availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
      sidebarDrawer: 'toggle',
    });
    useLayoutStore.getState().setAvailableWidth(1000);
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
    expect(selectSidebarVisible(useLayoutStore.getState())).toBe(false);
  });
});
