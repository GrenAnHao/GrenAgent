import { Button } from '@lobehub/ui';
import { MessageCircleQuestion } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, useState } from 'react';
import type { ImageAttachment } from '../../features/chat/input/ChatInputContext';
import { LazyMarkdown } from '../../features/chat/LazyMarkdown';
import { ConvCard } from '../../features/chat/conv/ConvCard';
import { OptionRow } from '../../features/chat/conv/OptionRow';
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
  // 外层：统一设计封顶 600px、左对齐随内容（窄屏自适应）。
  wrap: css`
    width: 100%;
    max-width: 600px;
  `,
  body: css`
    padding: 10px 12px;
  `,
  question: css`
    margin-block-end: 10px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.45;
    color: ${cssVar.colorText};
  `,
  // 选项多时卡内滚动，卡头/页脚（ConvCard 提供）固定。
  options: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
  `,
  // 自定义项（选中「其他」）内联输入框，贴在该选项行下方。
  customInput: css`
    width: 100%;
    margin-block-start: 6px;
    padding: 7px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
    font-size: 13px;
    outline: none;

    &::placeholder {
      color: ${cssVar.colorTextTertiary};
    }
    &:focus {
      border-color: ${cssVar.colorInfo};
    }
  `,
  // 已作答后的只读摘要行（无页脚）。
  doneText: css`
    padding: 10px 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  // 分页页脚中部「已答 N / M」计数，把提交按钮顶到右侧。
  footMid: css`
    margin-inline-end: auto;
    font-size: 11px;
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

/**
 * 通用选择题 UI（对齐对话项统一视觉：ConvCard 卡壳 + OptionRow 选项行）。
 * 支持单选 / 多选、自定义项（内联输入）、补充说明（可贴图）；多题时分页步骤呈现。
 */
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

  // 卡头右侧 tag：多题显进度 + 单/多选；单题多选显已选计数；单题单选显「单选」。
  const tag = paged
    ? `${idx + 1}/${questions.length} · ${q?.allowMultiple ? '多选' : '单选'}`
    : q?.allowMultiple
      ? `多选 · 已选 ${pickedCount}`
      : '单选';

  const footer =
    !disabled && !doneLabel ? (
      paged ? (
        <>
          <Button data-testid={`${testId}-prev`} disabled={idx === 0} onClick={() => setStep(idx - 1)} size="small">
            上一题
          </Button>
          <span className={styles.footMid}>
            已答 {answeredCount} / {questions.length}
          </span>
          {isLast ? (
            <Button data-testid={`${testId}-submit`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
              提交
            </Button>
          ) : (
            <Button data-testid={`${testId}-next`} disabled={!curOk} onClick={() => setStep(idx + 1)} size="small" type="primary">
              下一题
            </Button>
          )}
        </>
      ) : (
        <>
          {onSkip ? (
            <Button data-testid={`${testId}-skip`} onClick={onSkip} size="small">
              {skipLabel}
            </Button>
          ) : (
            <span />
          )}
          {onContinue ? (
            <Button data-testid={`${testId}-continue`} disabled={!allOk} onClick={onContinue} size="small" type="primary">
              {continueLabel}
            </Button>
          ) : null}
        </>
      )
    ) : undefined;

  return (
    <div className={cx(styles.wrap, className)} data-testid={testId}>
      <ConvCard footer={footer} icon={MessageCircleQuestion} label={headerTitle} tag={tag}>
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
                  <div key={o.id} data-testid={`${testId}-opt-${q.id}-${o.id}`}>
                    <OptionRow
                      index={String.fromCharCode(65 + oi)}
                      label={o.label}
                      multi={Boolean(q.allowMultiple)}
                      onClick={() => {
                        if (!disabled) onToggle(q.id, o.id, Boolean(q.allowMultiple));
                      }}
                      selected={isSel}
                    />
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
      </ConvCard>
    </div>
  );
});
