import { create } from 'zustand';
import { useSessionStore } from '../store/session';
import { pathsEquivalent } from '../lib/pathUtils';

export type AgentMode = 'agent' | 'ask' | 'debug' | 'plan' | 'brainstorm';

export const AGENT_MODES: AgentMode[] = ['agent', 'ask', 'debug', 'plan', 'brainstorm'];

/** 模式显示名（选择器选项用）。 */
export const MODE_LABELS: Record<AgentMode, string> = {
  agent: 'Agent',
  ask: 'Ask',
  debug: 'Debug',
  plan: 'Plan',
  brainstorm: 'Brainstorm',
};

export function isAgentMode(v: unknown): v is AgentMode {
  return v === 'agent' || v === 'ask' || v === 'debug' || v === 'plan' || v === 'brainstorm';
}

/** 会话路径归一化后作键：分隔符 / 大小写差异不拆成两份。 */
export function sessionControlKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
}

interface ModeState {
  /** 各 workspace 的项目默认模式：草稿显示它，新会话继承它（agent-mode-default 推送）。 */
  byWorkspace: Record<string, AgentMode>;
  /** 各会话自己的模式（agent-mode 推送，带 sessionPath）。切会话互不影响。 */
  bySession: Record<string, AgentMode>;
  setMode: (workspace: string, mode: AgentMode) => void;
  setSessionMode: (sessionPath: string, mode: AgentMode) => void;
}

export const useModeStore = create<ModeState>((set) => ({
  byWorkspace: {},
  bySession: {},
  setMode: (workspace, mode) =>
    set((s) =>
      s.byWorkspace[workspace] === mode
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspace]: mode } },
    ),
  setSessionMode: (sessionPath, mode) => {
    const key = sessionControlKey(sessionPath);
    set((s) => (s.bySession[key] === mode ? s : { bySession: { ...s.bySession, [key]: mode } }));
  },
}));

/** 输入栏当前作用的会话：草稿没有会话（返回 null，走项目默认）。 */
export function useComposerSessionPath(workspace: string): string | null {
  return useSessionStore((s) => {
    if (s.draftConversationCwd && pathsEquivalent(s.draftConversationCwd, workspace)) return null;
    return s.activeSessionPath || null;
  });
}

export function useComposerMode(workspace: string): AgentMode {
  const path = useComposerSessionPath(workspace);
  return useModeStore((s) => (path ? s.bySession[sessionControlKey(path)] : undefined) ?? s.byWorkspace[workspace] ?? 'agent');
}
