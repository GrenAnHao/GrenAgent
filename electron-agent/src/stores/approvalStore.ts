import { create } from 'zustand';

export type ApprovalPolicy = 'ask' | 'auto' | 'full';

export const APPROVAL_POLICIES: ApprovalPolicy[] = ['ask', 'auto', 'full'];

/** 审批策略显示名（选择器选项用）。 */
export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  ask: '请求批准',
  auto: '替我审批',
  full: '完全访问',
};

/** 审批策略说明（选择器副标题 / tooltip 用）。 */
export const APPROVAL_HINTS: Record<ApprovalPolicy, string> = {
  ask: '写工作区外 / 联网 / 执行代码 / 改文件或危险命令时询问',
  auto: '仅危险命令 / 受保护路径时询问',
  full: '完整访问、不询问（子代理能力限制仍生效）',
};

export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return v === 'ask' || v === 'auto' || v === 'full';
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
