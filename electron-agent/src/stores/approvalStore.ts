import { create } from 'zustand';

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
  /** 各 workspace 的当前审批策略（由 sidecar approval 扩展经 setStatus 推送回读）。 */
  byWorkspace: Record<string, ApprovalPolicy>;
  setLevel: (workspace: string, level: ApprovalPolicy) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  byWorkspace: {},
  setLevel: (workspace, level) =>
    set((s) =>
      s.byWorkspace[workspace] === level
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspace]: level } },
    ),
}));
