import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Eye, Hand, PencilLine, Shield, ShieldAlert, type LucideIcon } from 'lucide-react';
import { pi } from '../../../../lib/pi';
import {
  APPROVAL_HINTS,
  APPROVAL_LABELS,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  setComposerApprovalLevel,
  useComposerApproval,
} from '../../../../stores/approvalStore';
import { useComposerMode, useComposerSessionPath } from '../../../../stores/modeStore';
import { enableFullAccess } from '../../../../stores/fullAccessConfirmStore';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { compactLabelStyles, useComposerCompact } from '../composerCompact';

/** 每个审批策略的 lucide 图标（仅查看 / 请求批准 / 替我审批 / 工作区编辑 / 完全权限）。 */
const ICONS: Record<ApprovalPolicy, LucideIcon> = {
  readonly: Eye,
  ask: Hand,
  auto: Shield,
  workspace: PencilLine,
  full: ShieldAlert,
};

/** 完全权限关掉沙箱、不再询问，用错误色标出来。&& 压过 Select 自带的文字色。 */
const styles = createStaticStyles(({ css }) => ({
  danger: css`
    && {
      color: ${cssVar.colorError};
    }
  `,
}));

/**
 * 审批策略选择器：仅查看 / 请求批准 / 替我审批 / 工作区编辑 / 完全权限，与「模式」并列。
 * 每级是一档确认强度（驱动 safety 的逐次确认行为）。档位按会话：approval 扩展经 setStatus（带 sessionPath）
 * 推送到 approvalStore；切换走 agent_set_approval 并带会话路径，只改这一份会话。草稿改项目默认。
 * Ask 模式下选择器禁用（value 仍显示当前档；实际强制只读由 worker 的 resolvePreset 做）。
 */
export default function ApprovalAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const sessionPath = useComposerSessionPath(workspace);
  const level = useComposerApproval(workspace);
  const mode = useComposerMode(workspace);
  const compact = useComposerCompact();
  const disabled = !workspaceReady || mode === 'ask';
  // Ask 模式强制只读，完全权限没有生效，不标红。
  const danger = level === 'full' && !disabled;

  const onChange = (next: string) => {
    const target = next as ApprovalPolicy;
    if (target === 'full') {
      void enableFullAccess(workspace, sessionPath);
      return;
    }
    setComposerApprovalLevel(workspace, sessionPath, target);
    void pi.setApproval(workspace, target, sessionPath);
  };

  return (
    <Select
      size="small"
      variant="borderless"
      popupMatchSelectWidth={false}
      disabled={disabled}
      value={level}
      options={APPROVAL_POLICIES.map((p) => ({ label: APPROVAL_LABELS[p], value: p }))}
      optionRender={(option) => {
        const p = option.value as ApprovalPolicy;
        return (
          <span
            className={p === 'full' ? styles.danger : undefined}
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
      classNames={{
        ...(compact ? { value: compactLabelStyles.clip } : {}),
        ...(danger ? { trigger: styles.danger, prefix: styles.danger } : {}),
      }}
      style={{ width: 'auto', maxWidth: compact ? 40 : 148, paddingInline: 0 }}
      suffixIcon={null}
      onChange={onChange}
    />
  );
}
