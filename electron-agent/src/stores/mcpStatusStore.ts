import { create } from 'zustand';

export interface McpServerStatus {
  name: string;
  transport: string;
  status: 'connecting' | 'connected' | 'failed' | 'needs-login';
  tools: number;
  toolNames?: string[];
  exposure?: string;
  auth?: 'none' | 'oauth' | 'provider';
  loginUrl?: string;
}

interface McpStatusState {
  /** 最新一份状态，保留给旧调用方；新 UI 应按 workspace 读取。 */
  servers: McpServerStatus[];
  serversByWorkspace: Record<string, McpServerStatus[]>;
  setServers: (servers: McpServerStatus[]) => void;
  setWorkspaceServers: (workspace: string, servers: McpServerStatus[]) => void;
}

export const useMcpStatusStore = create<McpStatusState>((set) => ({
  servers: [],
  serversByWorkspace: {},
  setServers: (servers) => set({ servers }),
  setWorkspaceServers: (workspace, servers) => set((state) => ({
    servers,
    serversByWorkspace: { ...state.serversByWorkspace, [workspace]: servers },
  })),
}));
