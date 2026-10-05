import { create } from 'zustand';
import { sessionControlKey, useComposerSessionPath } from './modeStore';

export type ApprovalPolicy = 'readonly' | 'ask' | 'auto' | 'workspace' | 'full';

export const APPROVAL_POLICIES: ApprovalPolicy[] = ['readonly', 'ask', 'auto', 'workspace', 'full'];

/** 审批策略显示名（选择器选项用）。与 extensions/_shared/approval 逐字一致。 */
export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  readonly: '仅查看',
  ask: '请求批准',
  auto: '替我审批',
  workspace: '工作区编辑',
  full: '完全权限',
};

/** 审批策略说明（选择器副标题 / tooltip 用）。 */
export const APPROVAL_HINTS: Record<ApprovalPolicy, string> = {
  readonly: '只读。写由 OS 沙箱拒绝；联网与升权会询问',
  ask: '工作区内可写。越界 / 联网 / 危险命令 / 升权询问',
  auto: '工作区内可写。仅危险命令询问；升权仍询问',
  workspace: '工作区内可写且不问。越界由 OS 拒绝，升权直接拒绝',
  full: '关闭 OS 沙箱，不询问（子代理能力限制仍生效）',
};

export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return v === 'readonly' || v === 'ask' || v === 'auto' || v === 'workspace' || v === 'full';
}

interface ApprovalState {
  /** 各 workspace 的项目默认档：草稿显示它，新会话继承它（approval-policy-default 推送）。 */
  byWorkspace: Record<string, ApprovalPolicy>;
  /** 各会话自己的档（approval-policy 推送，带 sessionPath）。切会话互不影响。 */
  bySession: Record<string, ApprovalPolicy>;
  setLevel: (workspace: string, level: ApprovalPolicy) => void;
  setSessionLevel: (sessionPath: string, level: ApprovalPolicy) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  byWorkspace: {},
  bySession: {},
  setLevel: (workspace, level) =>
    set((s) =>
      s.byWorkspace[workspace] === level
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspace]: level } },
    ),
  setSessionLevel: (sessionPath, level) => {
    const key = sessionControlKey(sessionPath);
    set((s) => (s.bySession[key] === level ? s : { bySession: { ...s.bySession, [key]: level } }));
  },
}));

/** 某会话（null = 草稿）当前生效的档：会话自己的 → 项目默认 → auto。 */
export function readApprovalLevel(workspace: string, sessionPath: string | null): ApprovalPolicy {
  const s = useApprovalStore.getState();
  return (sessionPath ? s.bySession[sessionControlKey(sessionPath)] : undefined) ?? s.byWorkspace[workspace] ?? 'auto';
}

/** 写本地乐观值：会话写会话；项目默认同步更新（与宿主一致，最近一次选择给新会话继承）。 */
export function setComposerApprovalLevel(workspace: string, sessionPath: string | null, level: ApprovalPolicy): void {
  const s = useApprovalStore.getState();
  if (sessionPath) s.setSessionLevel(sessionPath, level);
  s.setLevel(workspace, level);
}

export function useComposerApproval(workspace: string): ApprovalPolicy {
  const path = useComposerSessionPath(workspace);
  return useApprovalStore((s) => (path ? s.bySession[sessionControlKey(path)] : undefined) ?? s.byWorkspace[workspace] ?? 'auto');
}
