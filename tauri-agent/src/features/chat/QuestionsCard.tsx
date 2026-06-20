import { memo, useCallback, useState } from 'react';
import { App } from 'antd';
import { pi } from '../../lib/pi';
import type { ImageAttachment } from '../chat/input/ChatInputContext';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { CUSTOM_OPTION_ID, QuestionSelector } from '../../components/QuestionSelector';

interface QuestionOption {
  id: string;
  label: string;
}

interface QuestionSpec {
  id: string;
  title: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowCustom?: boolean;
}

interface QuestionsData {
  kind: 'questions';
  id: string;
  questions: QuestionSpec[];
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraPlaceholder?: string;
}

/** content 为 ask_user 写入的 QuestionsCardData JSON；非本结构返回 null（调用方回退）。 */
export function parseQuestions(content: string): QuestionsData | null {
  try {
    const d = JSON.parse(content) as Partial<QuestionsData>;
    if (d && d.kind === 'questions' && Array.isArray(d.questions)) {
      const questions: QuestionSpec[] = d.questions
        .filter((q): q is QuestionSpec => Boolean(q) && typeof q.title === 'string' && Array.isArray(q.options))
        .map((q, i) => ({
          id: String(q.id ?? '').trim() || `q${i + 1}`,
          title: q.title,
          options: q.options.map((o, oi) => ({
            id: String(o?.id ?? '').trim() || `o${oi + 1}`,
            label: String(o?.label ?? ''),
          })),
          allowMultiple: Boolean(q.allowMultiple),
          allowCustom: Boolean(q.allowCustom),
        }));
      if (questions.length > 0) {
        return {
          kind: 'questions',
          id: String(d.id ?? ''),
          questions,
          allowExtra: Boolean(d.allowExtra),
          allowExtraImages: d.allowExtraImages !== false,
          extraPlaceholder: typeof d.extraPlaceholder === 'string' ? d.extraPlaceholder : undefined,
        };
      }
    }
  } catch {
    /* not our JSON */
  }
  return null;
}

function formatChoiceLabels(
  q: QuestionSpec,
  ids: string[],
  customTexts?: Record<string, string>,
): string[] {
  return ids
    .map((oid) => {
      if (oid === CUSTOM_OPTION_ID) {
        const t = customTexts?.[q.id]?.trim();
        return t ? `其他：${t}` : '其他';
      }
      return q.options.find((o) => o.id === oid)?.label;
    })
    .filter((x): x is string => Boolean(x));
}

/** 把用户的选择拼成人类可读、AI 可解析的回传文本。 */
export function formatAnswers(
  data: QuestionsData,
  selected: Record<string, string[]>,
  customTexts?: Record<string, string>,
  extraNote?: string,
  imageCount?: number,
): string {
  const lines = data.questions.map((q, i) => {
    const labels = formatChoiceLabels(q, selected[q.id] ?? [], customTexts);
    return `${i + 1}. ${q.title}：${labels.length > 0 ? labels.join('、') : '(未选)'}`;
  });
  const note = extraNote?.trim();
  if (note) lines.push(`补充说明：${note}`);
  if (imageCount && imageCount > 0) lines.push(`补充图片：${imageCount} 张（见消息附件）`);
  return `[我的选择]\n${lines.join('\n')}`;
}

/**
 * 对话流内的「提问卡」：`ask_user` 产出 agent-questions 消息，支持单选/多选、自定义选项、补充说明（可贴图）。
 */
export const QuestionsCard = memo(function QuestionsCard({
  content,
  answered,
}: {
  content: string;
  answered?: boolean;
}) {
  const { workspace } = useAgentStoreContext();
  const { message } = App.useApp();
  const data = parseQuestions(content);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [extraText, setExtraText] = useState('');
  const [extraImages, setExtraImages] = useState<ImageAttachment[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const done = Boolean(answered) || submitted || skipped;

  const toggle = useCallback((questionId: string, optionId: string, allowMultiple: boolean) => {
    setSelected((prev) => {
      const cur = prev[questionId] ?? [];
      if (allowMultiple) {
        return {
          ...prev,
          [questionId]: cur.includes(optionId) ? cur.filter((x) => x !== optionId) : [...cur, optionId],
        };
      }
      return { ...prev, [questionId]: cur.includes(optionId) ? [] : [optionId] };
    });
  }, []);

  const onContinue = useCallback(async () => {
    if (!data) return;
    setSubmitted(true);
    try {
      const images = extraImages.map(({ type, mimeType, data: imgData }) => ({
        type,
        mimeType,
        data: imgData,
      }));
      await pi.prompt(
        workspace,
        formatAnswers(data, selected, customTexts, extraText, images.length),
        undefined,
        images.length ? images : undefined,
      );
    } catch (e) {
      setSubmitted(false);
      message.error(`提交失败：${e instanceof Error ? e.message : '请重试'}`);
    }
  }, [customTexts, data, extraImages, extraText, message, selected, workspace]);

  const onSkip = useCallback(async () => {
    setSkipped(true);
    try {
      await pi.prompt(workspace, '[跳过提问] 用户选择暂不回答上面的问题，请继续。');
    } catch (e) {
      setSkipped(false);
      message.error(`提交失败：${e instanceof Error ? e.message : '请重试'}`);
    }
  }, [message, workspace]);

  if (!data) {
    return (
      <QuestionSelector
        data-testid="questions-card"
        disabled
        headerTitle="Questions"
        onToggle={() => {}}
        questions={[{ id: 'fallback', title: content, options: [] }]}
        selected={{}}
      />
    );
  }

  return (
    <QuestionSelector
      allowExtra={data.allowExtra}
      allowExtraImages={data.allowExtraImages !== false}
      customTexts={customTexts}
      data-testid="questions-card"
      disabled={done}
      doneLabel={done ? (skipped ? '已跳过' : '已回答') : undefined}
      extraImages={extraImages}
      extraPlaceholder={data.extraPlaceholder}
      extraText={extraText}
      headerTitle="Questions"
      onContinue={done ? undefined : () => void onContinue()}
      onCustomTextChange={done ? undefined : (qid, value) => setCustomTexts((prev) => ({ ...prev, [qid]: value }))}
      onExtraImagesChange={done ? undefined : setExtraImages}
      onExtraTextChange={done || !data.allowExtra ? undefined : setExtraText}
      onSkip={done ? undefined : () => void onSkip()}
      onToggle={toggle}
      questions={data.questions}
      selected={selected}
    />
  );
});
