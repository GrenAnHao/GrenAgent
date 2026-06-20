import { memo, useCallback, useEffect, useState } from 'react';
import { Button, Icon } from '@lobehub/ui';
import { MessageCircleQuestion, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { QuestionSelector } from '../../../components/QuestionSelector';
import { extensionUiRespond } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

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
}));

/**
 * ChatInput 上方的内联「交互请求」：扩展经 ctx.ui.select / confirm / input 发起。
 * select 与对话流 QuestionsCard 共用 QuestionSelector（Cursor 风格选项行）。
 */
export const PromptRequestCard = memo(function PromptRequestCard() {
  const { workspace } = useAgentStoreContext();
  const item = useUiPromptStore((s) => s.byWorkspace[workspace]);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const requestId = item?.request.id;
  useEffect(() => {
    setText(item?.request.prefill ? String(item.request.prefill) : '');
    setSelected({});
  }, [requestId, item?.request.prefill]);

  const respond = useCallback(
    (payload: Record<string, unknown>) => {
      if (!item) return;
      void extensionUiRespond(item.workspace, {
        type: 'extension_ui_response',
        id: item.request.id,
        ...payload,
      });
      useUiPromptStore.getState().clear(item.workspace, item.request.id);
    },
    [item],
  );

  if (!item) return null;
  const { request } = item;
  const isConfirm = request.method === 'confirm';
  const isInput = request.method === 'input';
  const isSelect = !isConfirm && !isInput;
  const options = request.options?.length ? request.options : ['确定', '取消'];
  const heading = isConfirm ? (request.title ?? '确认') : isSelect ? '请选择' : '请确认';
  const body = isConfirm ? (request.message ?? request.title ?? '') : isInput ? (request.title ?? '') : '';
  const dismiss = () => respond(isConfirm ? { confirmed: false } : { cancelled: true });
  const selectQuestion = {
    id: 'select',
    title: request.title ?? '请选择一个选项',
    options: options.map((label, i) => ({ id: `o${i + 1}`, label })),
  };
  const chosen = selected.select?.[0];
  const chosenLabel =
    chosen != null ? selectQuestion.options.find((o) => o.id === chosen)?.label : undefined;

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
      {body && !isSelect ? <div className={styles.body}>{body}</div> : null}

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
      ) : isInput ? (
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
      ) : (
        <QuestionSelector
          continueLabel="确定"
          data-testid="prompt-request-select"
          headerTitle="请选择"
          onContinue={() => {
            if (chosenLabel) respond({ value: chosenLabel });
          }}
          onSkip={dismiss}
          onToggle={(questionId, optionId, allowMultiple) => {
            setSelected((prev) => {
              const cur = prev[questionId] ?? [];
              if (allowMultiple) {
                return {
                  ...prev,
                  [questionId]: cur.includes(optionId) ? cur.filter((x) => x !== optionId) : [...cur, optionId],
                };
              }
              return { ...prev, [questionId]: [optionId] };
            });
          }}
          questions={[selectQuestion]}
          selected={selected}
          skipLabel="取消"
        />
      )}
    </div>
  );
});
