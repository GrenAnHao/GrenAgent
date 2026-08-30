import { create } from 'zustand';

export interface McpServerStatus {
  name: string;
  transport: string;
  status: 'connecting' | 'connected' | 'failed';
  tools: number;
  toolNames?: string[];
}

interface McpStatusState {
  /** 实时连接状态（由 sidecar mcp extension 经 setStatus 推送）。 */
  servers: McpServerStatus[];
  setServers: (servers: McpServerStatus[]) => void;
}

export const useMcpStatusStore = create<McpStatusState>((set) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
}));
