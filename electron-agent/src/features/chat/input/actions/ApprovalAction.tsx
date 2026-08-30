import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Hand, Shield, ShieldAlert, type LucideIcon } from 'lucide-react';
import { pi } from '../../../../lib/pi';
import {
  APPROVAL_HINTS,
  APPROVAL_LABELS,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  useApprovalStore,
} from '../../../../stores/approvalStore';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';

/** 每个审批策略的 lucide 图标（对齐 Codex：请求批准=手/替我审批=盾/完全访问=感叹号盾牌）。 */
const ICONS: Record<ApprovalPolicy, LucideIcon> = {
  ask: Hand,
  auto: Shield,
  full: ShieldAlert,
};

/**
 * 审批策略选择器：请求批准 / 替我审批 / 完全访问，与「模式」并列。
 * 每级是一档确认强度（驱动 safety 的逐次确认行为）。当前级别由 sidecar approval 扩展经 setStatus
 * 推送到 approvalStore（切会话/刷新回读）；切换走 agent_set_approval（底层 /approval，不调 LLM）。
 */
export default function ApprovalAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const level = useApprovalStore((s) => s.byWorkspace[workspace] ?? 'auto');

  const onChange = (next: string) => {
    const target = next as ApprovalPolicy;
    useApprovalStore.getState().setLevel(workspace, target);
    void pi.setApproval(workspace, target);
  };

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady}
      value={level}
      options={APPROVAL_POLICIES.map((p) => ({ label: APPROVAL_LABELS[p], value: p }))}
      optionRender={(option) => {
        const p = option.value as ApprovalPolicy;
        return (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            title={APPROVAL_HINTS[p]}
          >
            <Icon icon={ICONS[p]} size={14} />
            <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <span>{APPROVAL_LABELS[p]}</span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{APPROVAL_HINTS[p]}</span>
            </span>
          </span>
        );
      }}
      placeholder="审批"
      prefix={ICONS[level]}
      style={{ width: 'auto', maxWidth: 120 }}
      onChange={onChange}
    />
  );
}
