import { createStaticStyles, cssVar, cx } from 'antd-style';
import { MessageCircleQuestion } from 'lucide-react';
import { memo, useState } from 'react';
import { ConvCard } from '../chat/conv/ConvCard';
import { OptionRow } from '../chat/conv/OptionRow';
import { Disclosure } from '../chat/conv/Disclosure';
import { extractText } from './toolUtils';

const styles = createStaticStyles(({ css }) => ({
  // 外层封顶 600px，与选项卡 / 其它对话卡一致。
  wrap: css`
    max-width: 600px;
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
  `,
  item: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  qlabel: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  qtext: css`
    overflow: hidden;
    font-size: 13px;
    line-height: 1.4;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  // 其余题的折叠容器（grid-rows 高度过渡，与原卡一致的顺滑收展）。
  rest: css`
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.32s cubic-bezier(0.34, 1.2, 0.64, 1);
  `,
  restOpen: css`
    grid-template-rows: 1fr;
  `,
  restInner: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow: hidden;
  `,
  toggle: css`
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: none;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
}));

interface QData {
  title: string;
  options: string[];
}

function extractQData(args: unknown): QData[] {
  if (!args || typeof args !== 'object') return [];
  const qs = (args as { questions?: unknown[] }).questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is { question?: unknown; options?: unknown[] } => Boolean(q) && typeof q === 'object')
    .map((q) => ({
      title: String(q.question ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '',
      options: Array.isArray(q.options)
        ? q.options.map((o) => String(typeof o === 'string' ? o : (o as { label?: unknown }).label ?? '').trim()).filter(Boolean)
        : [],
    }))
    .filter((q) => q.title);
}

function parseAnswers(result: unknown): string[] {
  const text = extractText(result);
  if (!text) return [];
  const chunks = text
    .replace(/^\[我的选择\]\n?/, '')
    .split(/(?=^\d+\.\s)/m)
    .filter((s) => /^\d+\./.test(s.trimStart()));
  return chunks.map((chunk) => {
    const colonIdx = chunk.lastIndexOf('：');
    return colonIdx >= 0 ? chunk.slice(colonIdx + 1).trim() : chunk.replace(/^\d+\.\s*/, '').trim();
  });
}

function optionLetter(options: string[], answerText: string): string | null {
  const idx = options.findIndex((opt) => answerText === opt || answerText.startsWith(opt) || opt === answerText.split('、')[0]);
  return idx >= 0 ? String.fromCharCode(65 + idx) : null;
}

/**
 * 「已回答」留痕卡（对齐对话项统一视觉：ConvCard 卡壳 + OptionRow 选中行）。
 * 每题显示题目 + 用户所选项（字母序号 + 靛蓝高亮 + 勾）；多题时首题常显、其余可折叠。
 */
export const AnsweredQuestionsCard = memo(function AnsweredQuestionsCard({
  args,
  result,
}: {
  args: unknown;
  result: unknown;
}) {
  const [open, setOpen] = useState(false);
  const qdata = extractQData(args);
  const answers = parseAnswers(result);

  const count = Math.max(qdata.length, answers.length);
  if (count === 0) return null;

  const items = Array.from({ length: count }, (_, i) => ({
    q: qdata[i]?.title ?? '',
    a: answers[i] ?? '',
    letter: qdata[i] ? optionLetter(qdata[i].options, answers[i] ?? '') : null,
  }));
  const multi = items.length > 1;
  const [first, ...rest] = items;

  const renderItem = (item: (typeof items)[0], nth: number) => {
    // 答案文本已带「X. 」前缀时去掉（序号由 OptionRow 的字母徽标呈现，避免重复）。
    const displayA =
      item.letter && item.a.startsWith(`${item.letter}. `) ? item.a.slice(item.letter.length + 2) : item.a;
    return (
      <div className={styles.item} key={nth}>
        {multi ? <span className={styles.qlabel}>第 {nth + 1} 题</span> : null}
        {item.q ? <div className={styles.qtext}>{item.q}</div> : null}
        {item.a ? (
          <OptionRow index={item.letter ?? '·'} label={displayA} multi onClick={() => {}} selected />
        ) : null}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <ConvCard
        data-testid="answered-questions-card"
        icon={MessageCircleQuestion}
        label="已回答"
        tag={`${items.length} 题`}
      >
        <div className={styles.body}>
          {first ? renderItem(first, 0) : null}
          {multi && rest.length > 0 ? (
            <>
              <div className={cx(styles.rest, open && styles.restOpen)}>
                <div className={styles.restInner}>{rest.map((item, i) => renderItem(item, i + 1))}</div>
              </div>
              <button className={styles.toggle} onClick={() => setOpen((v) => !v)} type="button">
                {open ? '收起' : `展开剩余 ${rest.length} 题`}
                <Disclosure open={open} />
              </button>
            </>
          ) : null}
        </div>
      </ConvCard>
    </div>
  );
});
