import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAgentStore, type AgentStoreApi } from './agent';

interface AgentStoreContextValue {
  workspace: string;
  store: AgentStoreApi;
  workspaceReady: boolean;
  setWorkspaceReady: (ready: boolean) => void;
}

const AgentStoreContext = createContext<AgentStoreContextValue | null>(null);

interface AgentStoreProviderProps {
  workspace: string;
  children: ReactNode;
}

/**
 * 为某个工作区创建并提供 agent store。
 * workspace 变化时重建 store（旧 store 自动 destroy 取消订阅）。
 */
export function AgentStoreProvider({ workspace, children }: AgentStoreProviderProps) {
  const store = useMemo(() => createAgentStore(workspace), [workspace]);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  useEffect(() => {
    setWorkspaceReady(false);
  }, [workspace]);

  useEffect(() => {
    return () => store.destroy();
  }, [store]);

  const value = useMemo(
    () => ({ workspace, store, workspaceReady, setWorkspaceReady }),
    [workspace, store, workspaceReady],
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

/** 便捷获取当前工作区的 agent store API（含 useStore 选择器）。 */
export function useAgentStore(): AgentStoreApi {
  return useAgentStoreContext().store;
}
