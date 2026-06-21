import { Button, Icon } from '@lobehub/ui';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, useState } from 'react';
import type { ImageAttachment } from '../../features/chat/input/ChatInputContext';
import { LazyMarkdown } from '../../features/chat/LazyMarkdown';
import { CUSTOM_OPTION_ID } from './constants';
import { ExtraContent } from './ExtraContent';

export { CUSTOM_OPTION_ID } from './constants';

export interface QuestionSelectorOption {
  id: string;
  label: string;
}
export interface QuestionSelectorQuestion {
  id: string;
  title: string;
  options: QuestionSelectorOption[];
  allowMultiple?: boolean;
  allowCustom?: boolean;
}
export interface QuestionSelectorProps {
  questions: QuestionSelectorQuestion[];
  selected: Record<string, string[]>;
  customTexts?: Record<string, string>;
  onToggle: (questionId: string, optionId: string, allowMultiple: boolean) => void;
  onCustomTextChange?: (questionId: string, value: string) => void;
  onContinue?: () => void;
  onSkip?: () => void;
  disabled?: boolean;
  doneLabel?: string;
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraText?: string;
  onExtraTextChange?: (value: string) => void;
  extraImages?: ImageAttachment[];
  onExtraImagesChange?: (items: ImageAttachment[]) => void;
  extraPlaceholder?: string;
  continueLabel?: string;
  skipLabel?: string;
  headerTitle?: string;
  className?: string;
  'data-testid'?: string;
}

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    max-width: 600px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  `,
  head: css`
    display: flex;
    gap: 7px;
    align-items: center;
    padding: 10px 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
  `,
  count: css`
    margin-inline-start: auto;
    color: ${cssVar.colorPrimary};
  `,
  dots: css`
    display: flex;
    gap: 6px;
    margin-inline-start: auto;
  `,
  step: css`
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 10px;
    color: ${cssVar.colorTextTertiary};
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,
  stepDone: css`
    background: rgba(126, 226, 168, 0.15);
    border-color: transparent;
    color: #7ee2a8;
  `,
  stepCur: css`
    background: ${cssVar.colorPrimary};
    border-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
    font-weight: 700;
  `,
  body: css`
    padding: 12px 14px;
  `,
  question: css`
    font-size: 14px;
    font-weight: 600;
    line-height: 1.45;
    color: ${cssVar.colorText};
    margin-block-end: 10px;
  `,
  options: css`
    display: flex;
    flex-direction: column;
    gap: 7px;
  `,
  optionWrap: css`
    display: flex;
    flex-direction: column;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    overflow: hidden;
    transition:
      border-color 0.12s ease,
      background 0.12s ease;

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  optionWrapSel: css`
    border-color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
  `,
  option: css`
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 9px 11px;
    border: none;
    background: transparent;
    color: ${cssVar.colorText};
    font-size: 13px;
    text-align: start;
    cursor: pointer;
  `,
  letter: css`
    flex: none;
    width: 19px;
    height: 19px;
    border-radius: 50%;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-block-start: 1px;
  `,
  letterMulti: css`
    border-radius: 6px;
  `,
  letterSelected: css`
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
  `,
  optionLabel: css`
    flex: 1;
    line-height: 1.4;
  `,
  check: css`
    flex: none;
    margin-inline-start: auto;
    color: ${cssVar.colorPrimary};
  `,
  customInput: css`
    width: 100%;
    padding: 7px 11px;
    border: none;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
    font-size: 13px;
    outline: none;
    &::placeholder { color: ${cssVar.colorTextTertiary}; }
    &:focus { background: ${cssVar.colorFillTertiary}; }
  `,
  footer: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    padding: 10px 14px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  footMid: css`
    margin-inline-end: auto;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  doneText: css`
    padding: 10px 14px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

function questionSatisfied(
  q: QuestionSelectorQuestion,
  selected: Record<string, string[]>,
  customTexts?: Record<string, string>,
): boolean {
  const ids = selected[q.id] ?? [];
  if (q.options.length === 0) return q.allowCustom ? Boolean(customTexts?.[q.id]?.trim()) : false;
  if (ids.length === 0) return false;
  if (ids.includes(CUSTOM_OPTION_ID) && !customTexts?.[q.id]?.trim()) return false;
  return true;
}

/** 通用选择题 UI：单选/多选、自定义、补充说明（可贴图）；多题时分页步骤呈现。 */
export const QuestionSelector = memo(function QuestionSelector({
  questions,
  selected,
  customTexts = {},
  onToggle,
  onCustomTextChange,
  onContinue,
  onSkip,
  disabled = false,
  doneLabel,
  allowExtra = false,
  allowExtraImages = true,
  extraText = '',
  onExtraTextChange,
  extraImages = [],
  onExtraImagesChange,
  extraPlaceholder,
  continueLabel = '确定',
  skipLabel = '取消',
  headerTitle = '请选择',
  className,
  'data-testid': testId = 'question-selector',
}: QuestionSelectorProps) {
  const [step, setStep] = useState(0);
  const paged = questions.length > 1;
  const idx = Math.min(step, Math.max(0, questions.length - 1));
  const q = questions[idx];
  const showExtra = allowExtra && onExtraTextChange && !disabled;
  const isLast = idx === questions.length - 1;
  const curOk = q ? questionSatisfied(q, selected, customTexts) : false;
  const allOk = questions.every((qq) => questionSatisfied(qq, selected, customTexts));
  const answeredCount = questions.filter((qq) => questionSatisfied(qq, selected, customTexts)).length;
  const picked = q ? (selected[q.id] ?? []) : [];
  const pickedCount = picked.filter((id) => id !== CUSTOM_OPTION_ID || customTexts[q?.id ?? '']?.trim()).length;

  return (
    <div className={cx(styles.root, className)} data-testid={testId}>

      <div className={styles.head}>
        <Icon icon={MessageCircleQuestion} size={13} />
        <span className={styles.dot} />
        <span>
          {paged ? `第 ${idx + 1} / ${questions.length} 题` : headerTitle} · {q?.allowMultiple ? '可多选' : '单选'}
        </span>
        {paged ? (
          <span className={styles.dots}>
            {questions.map((qq, i) => (
              <span key={qq.id} className={cx(styles.step, i < idx && styles.stepDone, i === idx && styles.stepCur)}>
                {i + 1}
              </span>
            ))}
          </span>
        ) : q?.allowMultiple ? (
          <span className={styles.count}>已选 {pickedCount}</span>
        ) : null}
      </div>

      {q ? (
        <div className={styles.body}>
          <div className={styles.question}>
            {/`/.test(q.title) ? (
              <LazyMarkdown enableMermaid={false} fontSize={14} variant="chat">
                {q.title}
              </LazyMarkdown>
            ) : (
              q.title
            )}
          </div>
          <div className={styles.options}>
            {q.options.map((o, oi) => {
              const isSel = picked.includes(o.id);
              const isCustom = o.id === CUSTOM_OPTION_ID;
              return (
                <div key={o.id} className={cx(styles.optionWrap, isSel && styles.optionWrapSel)}>
                  <button
                    className={styles.option}
                    data-testid={`${testId}-opt-${q.id}-${o.id}`}
                    disabled={disabled}
                    onClick={() => onToggle(q.id, o.id, Boolean(q.allowMultiple))}
                    type="button"
                  >
                    <span className={cx(styles.letter, q.allowMultiple && styles.letterMulti, isSel && styles.letterSelected)}>
                      {String.fromCharCode(65 + oi)}
                    </span>
                    <span className={styles.optionLabel}>{o.label}</span>
                    {isSel ? <Icon className={styles.check} icon={Check} size={14} /> : null}
                  </button>
                  {isCustom && isSel && onCustomTextChange ? (
                    <input
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      className={styles.customInput}
                      data-testid={`${testId}-custom-${q.id}`}
                      onChange={(e) => onCustomTextChange(q.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="请输入自定义答案"
                      type="text"
                      value={customTexts[q.id] ?? ''}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {showExtra && isLast ? (
        <ExtraContent
          allowImages={allowExtraImages}
          data-testid={`${testId}-extra`}
          images={extraImages}
          onImagesChange={onExtraImagesChange ?? (() => {})}
          onTextChange={onExtraTextChange}
          placeholder={extraPlaceholder}
          text={extraText}
        />
      ) : null}

      {doneLabel ? <div className={styles.doneText}>{doneLabel}</div> : null}

      {!disabled && !doneLabel ? (
        <div className={styles.footer}>
          {paged ? (
            <>
              <Button data-testid={`${testId}-prev`} disabled={idx === 0} onClick={() => setStep(idx - 1)} size="small">
                ← 上一题
              </Button>
              <span className={styles.footMid}>
                已答 {answeredCount} / {questions.length}
              </span>
              {isLast ? (
                <Button data-testid={`${testId}-submit`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
                  ✓ 提交
                </Button>
              ) : (
                <Button data-testid={`${testId}-next`} disabled={!curOk} onClick={() => setStep(idx + 1)} size="small" type="primary">
                  下一题 →
                </Button>
              )}
            </>
          ) : (
            <>
              {onSkip ? (
                <Button data-testid={`${testId}-skip`} onClick={onSkip} size="small">
                  {skipLabel}
                </Button>
              ) : null}
              {onContinue ? (
                <Button data-testid={`${testId}-continue`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
                  {continueLabel}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
});
