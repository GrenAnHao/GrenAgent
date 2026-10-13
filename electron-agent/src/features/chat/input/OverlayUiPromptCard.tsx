import { memo, useCallback, useEffect, useState } from 'react';
import { Button, Icon } from '@lobehub/ui';
import { MessageCircleQuestion, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { QuestionSelector } from '../../../components/QuestionSelector';
import { extensionUiRespond } from '../../../lib/pi';
import { useAgentStore, useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useUiPromptStore } from '../../../stores/uiPromptStore';
import { appendUiPromptReceipt, shouldRenderUiPromptInOverlay, type UiPromptReceipt } from './overlayPrompt';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
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
  waiting: css`
    flex: none;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
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
  selectWrap: css`
    width: 100%;
  `,
}));

/**
 * ChatInput 上方的 overlay「交互请求」：扩展经 ctx.ui.select / confirm / input 发起的非审批项。
 * 审批（permission / 审批 select）仍由 PromptRequestCard 处理。
 */
export const OverlayUiPromptCard = memo(function OverlayUiPromptCard() {
  const { workspace } = useAgentStoreContext();
  const { useStore } = useAgentStore();
  const item = useUiPromptStore((s) => s.byWorkspace[workspace]);
  // 后面还排着的请求（例如子代理的审批，各自在倒计时）：答完这条才会顶上来，这里写出来免得被忽略。
  const waitingCount = useUiPromptStore((s) => s.waiting[workspace]?.length ?? 0);
  const waitingNote = waitingCount > 0 ? `还有 ${waitingCount} 条待处理` : undefined;
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const requestId = item?.request.id;
  useEffect(() => {
    setText(item?.request.prefill ? String(item.request.prefill) : '');
    setSelected({});
  }, [requestId, item?.request.prefill]);

  const respond = useCallback(
    (payload: Record<string, unknown>, receipt: UiPromptReceipt) => {
      if (!item) return;
      void extensionUiRespond(item.workspace, {
        type: 'extension_ui_response',
        id: item.request.id,
        ...payload,
      });
      useUiPromptStore.getState().clear(item.workspace, item.request.id);
      appendUiPromptReceipt(useStore.setState, receipt);
    },
    [item, useStore],
  );

  if (!item || !shouldRenderUiPromptInOverlay(item.request)) return null;
  const { request } = item;
  const isConfirm = request.method === 'confirm';
  const isInput = request.method === 'input';
  const isSelect = !isConfirm && !isInput;
  const heading = isConfirm ? (request.title ?? '确认') : isInput ? (request.title ?? '请输入') : (request.title ?? '请选择');
  const dismiss = () => respond(isConfirm ? { confirmed: false } : { cancelled: true }, { outcome: 'cancelled', title: heading });

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
        fullWidth
        headerTitle={waitingNote ? `请选择（${waitingNote}）` : '请选择'}
        onContinue={() => {
          if (chosenLabel) {
            respond(
              { value: chosenLabel },
              { outcome: 'answered', title: request.title ?? '请选择', value: chosenLabel },
            );
          }
        }}
        onSkip={dismiss}
        onToggle={(questionId, optionId) => setSelected({ [questionId]: [optionId] })}
        questions={[selectQuestion]}
        selected={selected}
        skipLabel="取消"
      />
    );
  }

  const displayHeading = isConfirm ? (request.title ?? '确认') : '请输入';
  const body = isConfirm ? (request.message ?? request.title ?? '') : (request.title ?? '');
  return (
    <div className={styles.card} data-testid="prompt-request-card">
      <div className={styles.head}>
        <Icon icon={MessageCircleQuestion} size={13} />
        <span className={styles.headTitle}>{displayHeading}</span>
        {waitingNote ? (
          <span className={styles.waiting} data-testid="prompt-request-waiting">
            {waitingNote}
          </span>
        ) : null}
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

      {isConfirm ? (
        <div className={styles.row}>
          <Button data-testid="prompt-request-cancel" onClick={dismiss} size="small">
            取消
          </Button>
          <Button
            data-testid="prompt-request-confirm"
            onClick={() =>
              respond(
                { confirmed: true },
                { outcome: 'confirmed', title: request.title ?? '确认', value: '确定' },
              )
            }
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
              onClick={() =>
                respond({ value: text }, { outcome: 'answered', title: request.title ?? '请输入', value: text })
              }
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
