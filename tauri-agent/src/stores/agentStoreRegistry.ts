import { create } from 'zustand';
import { createAgentStore, type AgentStoreApi } from './agent';

/** 默认常驻上限：超过则 LRU 淘汰最久未 active 的非 active、非运行中 store。 */
const DEFAULT_MAX = 8;

interface Entry {
  store: AgentStoreApi;
  lastActive: number;
  unsub: () => void;
}

/** 运行态：哪些 workspace 当前在 streaming（供 Sidebar 角标读）。 */
interface RegistryStatus {
  runningWorkspaces: string[];
}
export const useAgentRegistryStore = create<RegistryStatus>(() => ({ runningWorkspaces: [] }));

export interface AgentStoreRegistry {
  getOrCreate: (workspace: string) => AgentStoreApi;
  get: (workspace: string) => AgentStoreApi | undefined;
  /** 该 workspace 的 store 是否已常驻（决定切换时是否需要全屏 loading）。 */
  has: (workspace: string) => boolean;
  release: (workspace: string) => void;
  setActive: (workspace: string | null) => void;
  keys: () => string[];
  destroyAll: () => void;
}

export function createAgentStoreRegistry(max = DEFAULT_MAX): AgentStoreRegistry {
  const map = new Map<string, Entry>();
  let activeKey: string | null = null;

  const recomputeRunning = () => {
    const running: string[] = [];
    for (const [ws, e] of map) {
      if (e.store.useStore.getState().isStreaming) running.push(ws);
    }
    const prev = useAgentRegistryStore.getState().runningWorkspaces;
    // 仅在集合变化时 setState，避免无谓渲染
    if (prev.length !== running.length || running.some((w) => !prev.includes(w))) {
      useAgentRegistryStore.setState({ runningWorkspaces: running });
    }
  };

  const release = (workspace: string) => {
    const e = map.get(workspace);
    if (!e) return;
    e.unsub();
    e.store.destroy();
    map.delete(workspace);
    if (activeKey === workspace) activeKey = null;
    recomputeRunning();
  };

  const evictIfNeeded = () => {
    while (map.size > max) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [ws, e] of map) {
        if (ws === activeKey) continue;
        if (e.store.useStore.getState().isStreaming) continue; // 不淘汰运行中的
        if (e.lastActive < oldest) {
          oldest = e.lastActive;
          victim = ws;
        }
      }
      if (!victim) break; // 全在运行/全 active：暂不淘汰
      release(victim);
    }
  };

  const getOrCreate = (workspace: string) => {
    const existing = map.get(workspace);
    if (existing) {
      existing.lastActive = Date.now();
      return existing.store;
    }
    const store = createAgentStore(workspace);
    store.setActive(workspace === activeKey);
    const unsub = store.useStore.subscribe(() => recomputeRunning());
    map.set(workspace, { store, lastActive: Date.now(), unsub });
    evictIfNeeded();
    return store;
  };

  const setActive = (workspace: string | null) => {
    activeKey = workspace;
    for (const [ws, e] of map) {
      e.store.setActive(ws === workspace);
      if (ws === workspace) e.lastActive = Date.now();
    }
  };

  return {
    getOrCreate,
    get: (workspace) => map.get(workspace)?.store,
    has: (workspace) => map.has(workspace),
    release,
    setActive,
    keys: () => [...map.keys()],
    destroyAll: () => {
      for (const e of map.values()) {
        e.unsub();
        e.store.destroy();
      }
      map.clear();
      activeKey = null;
      useAgentRegistryStore.setState({ runningWorkspaces: [] });
    },
  };
}

/** 全局单例（与 dockStore / sessionStore 风格一致）。 */
export const agentStoreRegistry = createAgentStoreRegistry();
