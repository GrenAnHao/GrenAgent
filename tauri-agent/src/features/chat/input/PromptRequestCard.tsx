import { memo, useCallback, useEffect, useState } from 'react';
import { Button, Icon } from '@lobehub/ui';
import { MessageCircleQuestion, ShieldAlert, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { QuestionSelector } from '../../../components/QuestionSelector';
import { extensionUiRespond } from '../../../lib/pi';
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
  error: css`
    margin-block-start: 8px;
    color: ${cssVar.colorError};
    font-size: 12px;
    white-space: pre-wrap;
  `,
  row: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-block-start: 10px;
  `,
  textarea: css`
    width: 100%;
    margin-block-start: 8px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-size: 13px;
    resize: vertical;
  `,
  selectWrap: css`
    margin-bottom: 8px;
  `,
}));

/**
 * ChatInput 上方的内联「交互请求」：扩展经 ctx.ui.select / confirm / input 发起。
 * 审批类 select 走独立按钮（点一下即回传）；其余 select 与 QuestionsCard 共用 QuestionSelector。
 */
export const PromptRequestCard = memo(function PromptRequestCard() {
  const { workspace } = useAgentStoreContext();
  const item = useUiPromptStore((s) => s.byWorkspace[workspace]);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [respondError, setRespondError] = useState<string>();

  const requestId = item?.request.id;
  useEffect(() => {
    setText(item?.request.prefill ? String(item.request.prefill) : '');
    setSelected({});
    setRespondError(undefined);
  }, [requestId, item?.request.prefill]);

  const respond = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!item) return;
      try {
        await extensionUiRespond(item.workspace, {
          type: 'extension_ui_response',
          id: item.request.id,
          ...payload,
        });
        useUiPromptStore.getState().clear(item.workspace, item.request.id);
      } catch (error) {
        // 保留请求卡，避免 sidecar 仍在等待响应时用户看不到任何反馈。
        setRespondError(error instanceof Error ? error.message : String(error));
      }
    },
    [item],
  );

  if (!item) return null;
  const { request } = item;
  const isConfirm = request.method === 'confirm';
  const isInput = request.method === 'input';
  const isSelect = !isConfirm && !isInput;
  const dismiss = () => respond(isConfirm ? { confirmed: false } : { cancelled: true });

  if (isSelect && isApprovalSelect(request.options)) {
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
        {respondError ? <div className={styles.error}>{`提交失败：${respondError}`}</div> : null}
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
  }

  // 其余 select（问答 / 多选项）仍走 QuestionSelector。
  if (isSelect) {
    const options = request.options?.length ? request.options : ['确定', '取消'];
    const selectQuestion = {
      id: 'select',
      title: request.title ?? '请选择一个选项',
      options: options.map((label, i) => ({ id: `o${i + 1}`, label })),
    };
    const chosen = selected.select?.[0];
    const chosenLabel =
      chosen != null ? selectQuestion.options.find((o) => o.id === chosen)?.label : undefined;
    return (
      <QuestionSelector
        className={styles.selectWrap}
        continueLabel="确定"
        data-testid="prompt-request-select"
        headerTitle="请选择"
        onContinue={() => {
          if (chosenLabel) respond({ value: chosenLabel });
        }}
        onSkip={dismiss}
        onToggle={(questionId, optionId) => setSelected({ [questionId]: [optionId] })}
        questions={[selectQuestion]}
        selected={selected}
        skipLabel="取消"
      />
    );
  }

  const heading = isConfirm ? (request.title ?? '确认') : '请输入';
  const body = isConfirm ? (request.message ?? request.title ?? '') : (request.title ?? '');
  return (
    <div className={styles.card} data-testid="prompt-request-card">
      <div className={styles.head}>
        <Icon icon={MessageCircleQuestion} size={13} />
        <span className={styles.headTitle}>{heading}</span>
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
      {body ? <div className={styles.body}>{body}</div> : null}
      {respondError ? <div className={styles.error}>{`提交失败：${respondError}`}</div> : null}

      {isConfirm ? (
        <div className={styles.row}>
          <Button data-testid="prompt-request-cancel" onClick={() => respond({ confirmed: false })} size="small">
            取消
          </Button>
          <Button
            data-testid="prompt-request-confirm"
            onClick={() => respond({ confirmed: true })}
            size="small"
            type="primary"
          >
            确定
          </Button>
        </div>
      ) : (
        <>
          <textarea
            className={styles.textarea}
            data-testid="prompt-request-input"
            onChange={(e) => setText(e.target.value)}
            placeholder={typeof request.placeholder === 'string' ? request.placeholder : undefined}
            rows={3}
            value={text}
          />
          <div className={styles.row}>
            <Button data-testid="prompt-request-cancel" onClick={dismiss} size="small">
              取消
            </Button>
            <Button
              data-testid="prompt-request-submit"
              onClick={() => respond({ value: text })}
              size="small"
              type="primary"
            >
              提交
            </Button>
          </div>
        </>
      )}
    </div>
  );
});
