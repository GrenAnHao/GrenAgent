import { create } from 'zustand';

/**
 * 全局模块：应用级、不绑定具体项目（或以全局数据为主），常驻最左 ModuleRail。
 * 记忆以 ~/.pi 全局长期记忆为主体（项目记忆只是附加），故归全局。
 */
export type ModuleId = 'chat' | 'connections' | 'extensions' | 'usage' | 'memory' | 'settings';

/**
 * 工作区视图：项目级、绑定当前活跃工作区，渲染在主列内（对话区位置），侧栏常驻。
 * 'chat' 为默认视图；知识库只读 <工作区>/.pi 下的数据，属纯项目级。
 */
export type WorkspaceView = 'chat' | 'knowledge';

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
