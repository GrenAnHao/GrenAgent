import { Button, Icon } from '@lobehub/ui';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo } from 'react';
import type { ImageAttachment } from '../../features/chat/input/ChatInputContext';
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
  /** @deprecated 用 allowExtra + extraText */
  otherText?: string;
  onOtherTextChange?: (value: string) => void;
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
    max-width: 560px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
  `,
  head: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 12px 14px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  headTitle: css`
    flex: 1;
    min-width: 0;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  badge: css`
    flex: none;
    padding: 1px 7px;
    border-radius: 999px;
    background: ${cssVar.colorFillSecondary};
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  block: css`
    &:not(:first-of-type) {
      margin-block-start: 4px;
      padding-block-start: 8px;
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  question: css`
    padding: 10px 14px 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.45;
    color: ${cssVar.colorText};
  `,
  hint: css`
    padding: 4px 14px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  options: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px 0;
  `,
  option: css`
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-size: 13px;
    text-align: start;
    cursor: pointer;
    transition:
      border-color 0.12s ease,
      background 0.12s ease;

    &:hover {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  optionSelected: css`
    border-color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
  `,
  optionDone: css`
    cursor: default;

    &:hover {
      border-color: ${cssVar.colorBorderSecondary};
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  letter: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    background: ${cssVar.colorFillSecondary};
    font-size: 11px;
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  optionLabel: css`
    flex: 1;
    line-height: 1.4;
  `,
  check: css`
    flex: none;
    color: ${cssVar.colorPrimary};
  `,
  customInput: css`
    width: calc(100% - 28px);
    margin: 6px 14px 0;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-size: 13px;
    resize: vertical;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    margin-block-start: 12px;
    padding: 10px 14px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillQuaternary};
  `,
  doneText: css`
    margin-block-start: 12px;
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
  if (q.options.length === 0) {
    return q.allowCustom ? Boolean(customTexts?.[q.id]?.trim()) : false;
  }
  if (ids.length === 0) return false;
  if (ids.includes(CUSTOM_OPTION_ID) && !customTexts?.[q.id]?.trim()) return false;
  return true;
}

/** Cursor Plan Mode 风格的通用选择题 UI：单选/多选、自定义、补充说明（可贴图）。 */
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
  otherText,
  onOtherTextChange,
  allowExtra = false,
  allowExtraImages = true,
  extraText = '',
  onExtraTextChange,
  extraImages = [],
  onExtraImagesChange,
  extraPlaceholder,
  continueLabel = 'Continue',
  skipLabel = 'Skip',
  headerTitle = 'Questions',
  className,
  'data-testid': testId = 'question-selector',
}: QuestionSelectorProps) {
  const extraValue = onExtraTextChange ? extraText : (otherText ?? '');
  const setExtra = onExtraTextChange ?? onOtherTextChange;
  const showExtra = allowExtra && setExtra && !disabled;
  const canContinue = questions.every((q) => questionSatisfied(q, selected, customTexts));
  const showFooter = !disabled && !doneLabel && (onContinue || onSkip);

  return (
    <div className={cx(styles.root, className)} data-testid={testId}>
      <div className={styles.head}>
        <Icon icon={MessageCircleQuestion} size={13} />
        <span className={styles.headTitle}>{headerTitle}</span>
        {questions.length > 1 ? <span className={styles.badge}>{questions.length} 题</span> : null}
      </div>

      {questions.map((q, qi) => {
        const picked = selected[q.id] ?? [];
        const showCustomField = q.allowCustom && picked.includes(CUSTOM_OPTION_ID) && onCustomTextChange;
        return (
          <div className={styles.block} key={q.id || String(qi)}>
            {questions.length > 1 ? (
              <div className={styles.hint}>
                {qi + 1} / {questions.length}
                {q.allowMultiple ? ' · 可多选' : ' · 单选'}
              </div>
            ) : q.allowMultiple ? (
              <div className={styles.hint}>可多选</div>
            ) : q.options.length > 0 ? (
              <div className={styles.hint}>单选</div>
            ) : null}
            <div className={styles.question}>{q.title}</div>
            <div className={styles.options}>
              {q.options.map((o, oi) => {
                const isSel = picked.includes(o.id);
                return (
                  <button
                    className={cx(
                      styles.option,
                      isSel && styles.optionSelected,
                      disabled && styles.optionDone,
                    )}
                    data-testid={`${testId}-opt-${q.id}-${o.id}`}
                    disabled={disabled}
                    key={o.id}
                    onClick={() => onToggle(q.id, o.id, Boolean(q.allowMultiple))}
                    type="button"
                  >
                    <span className={styles.letter}>{String.fromCharCode(65 + oi)}</span>
                    <span className={styles.optionLabel}>{o.label}</span>
                    {isSel ? <Icon className={styles.check} icon={Check} size={14} /> : null}
                  </button>
                );
              })}
            </div>
            {showCustomField ? (
              <textarea
                className={styles.customInput}
                data-testid={`${testId}-custom-${q.id}`}
                onChange={(e) => onCustomTextChange(q.id, e.target.value)}
                placeholder="请输入自定义答案"
                rows={2}
                value={customTexts[q.id] ?? ''}
              />
            ) : null}
          </div>
        );
      })}

      {showExtra ? (
        <ExtraContent
          allowImages={allowExtraImages}
          data-testid={`${testId}-extra`}
          images={extraImages}
          onImagesChange={onExtraImagesChange ?? (() => {})}
          onTextChange={setExtra}
          placeholder={extraPlaceholder}
          text={extraValue}
        />
      ) : null}

      {doneLabel ? <div className={styles.doneText}>{doneLabel}</div> : null}

      {showFooter ? (
        <div className={styles.footer}>
          {onSkip ? (
            <Button data-testid={`${testId}-skip`} onClick={onSkip} size="small">
              {skipLabel}
            </Button>
          ) : null}
          {onContinue ? (
            <Button
              data-testid={`${testId}-continue`}
              disabled={!canContinue}
              onClick={onContinue}
              size="small"
              type="primary"
            >
              {continueLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
