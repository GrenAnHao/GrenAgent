import { create } from 'zustand';

/**
 * 全局模块：应用级、不绑定具体项目（或以全局数据为主），常驻最左 ModuleRail。
 *
 * 'devWorkbench' 只在 DEV 构建里由 ModuleRail 渲染入口并可达（生产构建整棵子树被 tree-shake），
 * 但仍列在联合类型里：类型层不区分构建模式，运行时由 ModuleRail 决定要不要露出来。
 */
export type ModuleId = 'chat' | 'connections' | 'extensions' | 'usage' | 'agentData' | 'devWorkbench' | 'settings';

/**
 * 工作区视图：项目级、绑定当前活跃工作区，渲染在主列内（对话区位置），侧栏常驻。
 * 'chat' 为默认且唯一视图；代码检索、Wiki 和 Memory 由 Agent Data 中心管理。
 */
export type WorkspaceView = 'chat';

interface ModuleState {
  activeModule: ModuleId;
  activeWorkspaceView: WorkspaceView;
  setActiveModule: (module: ModuleId) => void;
  setActiveWorkspaceView: (view: WorkspaceView) => void;
}

// 首启一律进对话页：activeModule / activeWorkspaceView 均不持久化，避免重启恢复到上次停留的设置/工具面板。
export const useModuleStore = create<ModuleState>((set) => ({
  activeModule: 'chat',
  activeWorkspaceView: 'chat',
  setActiveModule: (module) => set({ activeModule: module }),
  setActiveWorkspaceView: (view) => set({ activeWorkspaceView: view }),
}));
