import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentStoreApi } from './agent';
import { agentStoreRegistry } from './agentStoreRegistry';

interface AgentStoreContextValue {
  workspace: string;
  store: AgentStoreApi;
  workspaceReady: boolean;
  setWorkspaceReady: (ready: boolean) => void;
  /** 应用是否完成过首屏：仅冷启动显示全屏 loading，之后切换/新建对话走内容区骨架屏。 */
  appBooted: boolean;
}

// 导出原始 context：供 preview 沙盒注入 mock 值，在不连后端、不创建真实 store 的前提下
// 渲染依赖 workspace 的对话控件（PlanCard / 子代理 / 媒体卡等）。应用代码请用下方 hook。
export const AgentStoreContext = createContext<AgentStoreContextValue | null>(null);

interface AgentStoreProviderProps {
  workspace: string;
  children: ReactNode;
}

/**
 * 为某个工作区提供 agent store。
 * store 由 agentStoreRegistry 常驻管理：切换 workspace 不再 destroy（后台继续消费事件、保留流式态），
 * 仅切换 active 标志（active 用 rAF 实时刷新、后台用 setTimeout 兜底）。
 */
export function AgentStoreProvider({ workspace, children }: AgentStoreProviderProps) {
  // 该 workspace 的 store 是否已常驻：必须在 getOrCreate 之前判断（getOrCreate 会把它写进 registry）。
  // 用 ref 缓存「本次 workspace 变化」的判断结果，避免 StrictMode 双渲染在创建后把首开误判为已常驻。
  const residentRef = useRef<{ ws: string; resident: boolean } | null>(null);
  if (residentRef.current?.ws !== workspace) {
    residentRef.current = { ws: workspace, resident: agentStoreRegistry.has(workspace) };
  }
  const resident = residentRef.current.resident;

  const store = useMemo(() => agentStoreRegistry.getOrCreate(workspace), [workspace]);
  // 已常驻 → 直接就绪（展示缓存消息）；首次打开 → 先未就绪，内容区走骨架屏，待数据加载完再就绪。
  const [workspaceReady, setWorkspaceReady] = useState(resident);
  // 全屏 loading 只在冷启动（从未就绪过任何对话）显示；一旦首屏完成便永久 true。
  const [appBooted, setAppBooted] = useState(resident);

  // 工作区切换时把就绪态重置为 resident —— 必须在「渲染期」重置（React 官方「prop 变化时调整 state」模式），
  // 不能放进 useEffect：父组件 effect 晚于子组件 effect 执行，会把 Workspace 子 effect 里同步置好的
  // workspaceReady=true（草稿对话 / 缓存秒显路径）又覆盖回 false，导致 appBooted 永不变 true、永久卡在
  // 全屏 loading。渲染期重置发生在所有 effect 之前，子 effect 的就绪结果最终生效。
  const prevWorkspaceRef = useRef(workspace);
  if (prevWorkspaceRef.current !== workspace) {
    prevWorkspaceRef.current = workspace;
    setWorkspaceReady(resident);
  }

  useEffect(() => {
    if (workspaceReady) setAppBooted(true);
  }, [workspaceReady]);

  useEffect(() => {
    agentStoreRegistry.setActive(workspace);
  }, [workspace]);

  const value = useMemo(
    () => ({ workspace, store, workspaceReady, setWorkspaceReady, appBooted }),
    [workspace, store, workspaceReady, appBooted],
  );

  return <AgentStoreContext.Provider value={value}>{children}</AgentStoreContext.Provider>;
}

/** 获取当前工作区的 agent store 上下文（workspace + store API）。 */
export function useAgentStoreContext(): AgentStoreContextValue {
  const ctx = useContext(AgentStoreContext);
  if (!ctx) {
    throw new Error('useAgentStoreContext must be used within an AgentStoreProvider');
  }
  return ctx;
}

/** 可选版：无 Provider 时返回 null（供可在无工作区上下文中渲染的组件安全降级）。 */
export function useOptionalAgentStoreContext(): AgentStoreContextValue | null {
  return useContext(AgentStoreContext);
}

/** 便捷获取当前工作区的 agent store API（含 useStore 选择器）。 */
export function useAgentStore(): AgentStoreApi {
  return useAgentStoreContext().store;
}
