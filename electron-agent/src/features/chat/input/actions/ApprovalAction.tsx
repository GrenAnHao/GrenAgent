import { useEffect, useState } from 'react';
import { App } from 'antd';
import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Eye, Hand, PencilLine, Shield, ShieldAlert, type LucideIcon } from 'lucide-react';
import {
  APPROVAL_HINTS,
  APPROVAL_LABELS,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
} from '../../../../stores/approvalStore';
import { enableFullAccess } from '../../../../stores/fullAccessConfirmStore';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { compactLabelStyles, useComposerCompact } from '../composerCompact';
import { useComposerOwnerKey, useComposerOwnerPreferences } from '../composerOwner';
import { ensureComposerPreferences, writeComposerPreference } from './composerPreferences';

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
 * 每级是一档确认强度（驱动 safety 的逐次确认行为）。
 *
 * 数据来源是会话/草稿的 `session-preferences` 快照：
 *  - 恢复只显示保存值，不调 setter；
 *  - 普通会话只改这一份会话（agent_set_approval 带原始 sessionPath），不动项目默认；
 *  - 草稿只写本地偏好；完全权限确认时的回执仍归发起时捕获的 owner；
 *  - Ask 禁用编辑但保留保存的档位；完全权限在 Ask 下没有生效，不标红；
 *  - 加载中禁用，保存失败可见并回滚。
 */
export default function ApprovalAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const ownerKey = useComposerOwnerKey(workspace);
  const { preferences, loading: preferencesLoading, error: preferencesError } = useComposerOwnerPreferences(workspace);
  const [loadFailed, setLoadFailed] = useState(false);
  const compact = useComposerCompact();
  const { message } = App.useApp();

  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    setLoadFailed(false);
    void ensureComposerPreferences(workspace, ownerKey).then((result) => {
      if (cancelled) return;
      if (result.ok) return;
      setLoadFailed(true);
      message.error(result.message ? `无法读取审批档位：${result.message}` : '无法读取审批档位，请重试');
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady, ownerKey]);

  const level: ApprovalPolicy = preferences.approval ?? 'auto';
  const mode = preferences.mode ?? 'agent';
  const loading = preferencesLoading || !preferences.approval;
  const disabled = !workspaceReady || loadFailed || loading || preferencesError === 'load' || mode === 'ask';
  // Ask 模式强制只读，完全权限没有生效，不标红。
  const danger = level === 'full' && mode !== 'ask';

  const onChange = (next: string) => {
    const target = next as ApprovalPolicy;
    if (target === 'full') {
      // 确认窗在确认那一刻重新读取 owner，不能等回执回来再读全局 activeSessionPath。
      void enableFullAccess(workspace, ownerKey);
      return;
    }
    void writeComposerPreference(workspace, ownerKey, 'approval', target).then((result) => {
      if (result.ok || result.error === 'loading') return;
      message.error(result.message ? `审批档位保存失败：${result.message}` : '审批档位保存失败，已保留原值');
    });
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
