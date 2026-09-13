import { memo, useCallback } from 'react';
import { Button, Icon } from '@lobehub/ui';
import { ShieldAlert, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { extensionUiRespond, pi } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

/** sidecar 审批选项。点按钮即回传，不再走「请选择」单选题。 */
const APPROVAL_ACTIONS = new Set(['允许本次', '总是允许', '允许', '拒绝']);
const APPROVAL_TEST_IDS: Record<string, string> = {
  允许本次: 'allow-once',
  总是允许: 'allow-always',
  允许: 'allow',
  拒绝: 'deny',
};
const APPROVAL_ORDER = ['拒绝', '总是允许', '允许', '允许本次'];

export function isApprovalSelect(options: string[] | undefined): boolean {
  return Array.isArray(options) && options.length > 0 && options.every((label) => APPROVAL_ACTIONS.has(label));
}

function sortApprovalOptions(options: string[]): string[] {
  return [...options].sort((a, b) => APPROVAL_ORDER.indexOf(a) - APPROVAL_ORDER.indexOf(b));
}

const styles = createStaticStyles(({ css }) => ({
  card: css`
    margin-bottom: 8px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
  `,
  head: css`
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  headTitle: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  close: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  body: css`
    margin-block-start: 6px;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
  row: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-block-start: 10px;
  `,
}));

/**
 * ChatInput 上方的内联审批卡：permission 与审批类 select。
 * 其余 select / confirm / input 由 OverlayUiPromptCard 渲染。
 */
export const PromptRequestCard = memo(function PromptRequestCard() {
  const { workspace } = useAgentStoreContext();
  const item = useUiPromptStore((s) => s.byWorkspace[workspace]);

  const respond = useCallback(
    (payload: Record<string, unknown>) => {
      if (!item) return;
      if (item.request.source === 'permission') {
        void pi.resolvePermission(item.request.id, payload.confirmed === true ? 'allow' : 'deny');
      } else {
        void extensionUiRespond(item.workspace, {
          type: 'extension_ui_response',
          id: item.request.id,
          ...payload,
        });
      }
      useUiPromptStore.getState().clear(item.workspace, item.request.id);
    },
    [item],
  );

  if (!item) return null;
  if (item.request.source !== 'permission' && !isApprovalSelect(item.request.options)) return null;

  const { request } = item;
  const dismiss = () => respond({ cancelled: true });
  const options = sortApprovalOptions(request.options ?? []);
  return (
    <div className={styles.card} data-testid="prompt-request-approval">
      <div className={styles.head}>
        <Icon icon={ShieldAlert} size={13} />
        <span className={styles.headTitle}>需要批准</span>
        <button
          className={styles.close}
          data-testid="prompt-request-dismiss"
          onClick={dismiss}
          title="取消"
          type="button"
        >
          <Icon icon={X} size={14} />
        </button>
      </div>
      {request.title ? <div className={styles.body}>{request.title}</div> : null}
      <div className={styles.row}>
        {options.map((label) => (
          <Button
            data-testid={`prompt-request-approval-${APPROVAL_TEST_IDS[label] ?? label}`}
            key={label}
            onClick={() => respond({ value: label })}
            size="small"
            type={label === '允许本次' || label === '允许' ? 'primary' : undefined}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
});
