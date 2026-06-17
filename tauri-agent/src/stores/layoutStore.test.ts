import { beforeEach, describe, expect, it } from 'vitest';
import {
  panelMaxWidth,
  resolvePanelVisibility,
  selectSidebarVisible,
  selectRightPanelVisible,
  useLayoutStore,
  MAIN_COLUMN_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './layoutStore';

const base = {
  sidebarOpen: true,
  rightPanelOpen: true,
  sidebarWidth: 240,
  rightPanelWidth: 320,
};

describe('resolvePanelVisibility', () => {
  it('尚未量到宽度（<=0）时直接按意图，不折叠', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 0 })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: true,
    });
  });

  it('空间充足时两个都显示', () => {
    // 240 + 320 + 320 = 880 <= 1000
    expect(resolvePanelVisibility({ ...base, availableWidth: 1000 })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: true,
    });
  });

  it('挤压（窗口变窄）时默认先收左侧栏，保留右面板', () => {
    // 880 > 664，先收左侧栏；右面板 320 + 320 = 640 <= 664 保留
    expect(resolvePanelVisibility({ ...base, availableWidth: 664 })).toEqual({
      sidebarVisible: false,
      rightPanelVisible: true,
    });
  });

  it('正在拖宽左侧栏时改为挤掉右面板（谁被操作谁优先）', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 664, dragging: 'sidebar' })).toEqual({
      sidebarVisible: true,
      rightPanelVisible: false,
    });
  });

  it('正在拖宽右面板时挤掉左侧栏', () => {
    expect(resolvePanelVisibility({ ...base, availableWidth: 664, dragging: 'right' })).toEqual({
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
});

describe('panelMaxWidth', () => {
  it('未量到宽度时回退静态上限', () => {
    expect(panelMaxWidth(0, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('常规情况只给对话区保留 MAIN_COLUMN_MIN_WIDTH', () => {
    expect(panelMaxWidth(1000, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(
      1000 - MAIN_COLUMN_MIN_WIDTH,
    );
  });

  it('窗口很窄时不低于面板最小宽度', () => {
    expect(panelMaxWidth(400, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(panelMaxWidth(400, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('空间很大时不超过静态上限', () => {
    expect(panelMaxWidth(5000, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(RIGHT_PANEL_MAX_WIDTH);
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
      availableWidth: 664,
      liveSidebarWidth: null,
      liveRightPanelWidth: null,
    });
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
    useLayoutStore.setState({ sidebarOpen: true, rightPanelOpen: true, availableWidth: 664 });
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
