import { memo } from 'react';
import { CircleHelp } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { ConvCard } from './conv/ConvCard';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    max-width: 520px;
    padding: 9px 12px;
  `,
  question: css`
    margin-block-end: 4px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  answer: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
}));

interface ParsedAnswer {
  title: string;
  answer: string;
}

/** content 为 askChoice 写入的 JSON：{ title, answer }；解析失败返回 null（调用方回退）。 */
export function parseAnswer(content: string): ParsedAnswer | null {
  try {
    const d = JSON.parse(content) as Partial<ParsedAnswer>;
    if (d && typeof d.title === 'string') return { title: d.title, answer: String(d.answer ?? '') };
  } catch {
    /* not our JSON */
  }
  return null;
}

/** 对话流内的「问题 + 答案」卡（L4，ConvCard surface），对应一次选择题的结果，持久留痕。 */
export const AnswerCard = memo(function AnswerCard({ content }: { content: string }) {
  const data = parseAnswer(content);
  if (!data) {
    return (
      <ConvCard label="Answer" icon={CircleHelp} data-testid="answer-card">
        <div className={styles.body}>
          <div className={styles.answer}>{content}</div>
        </div>
      </ConvCard>
    );
  }
  return (
    <ConvCard label="Answer" icon={CircleHelp} data-testid="answer-card">
      <div className={styles.body}>
        <div className={styles.question}>{data.title}</div>
        <div className={styles.answer}>{data.answer}</div>
      </div>
    </ConvCard>
  );
});
