import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronDown } from 'lucide-react';
import { Icon } from '@lobehub/ui';
import { memo, useState } from 'react';
import { extractText } from './toolUtils';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    max-width: 600px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  headBtn: css`
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: start;
    &:hover { color: ${cssVar.colorTextSecondary}; }
  `,
  ok: css`color: #7ee2a8;`,
  title: css`flex: 1; font-size: 12px; color: ${cssVar.colorTextSecondary};`,
  chevron: css`
    color: ${cssVar.colorTextTertiary};
    transition: transform 0.38s cubic-bezier(0.34, 1.4, 0.64, 1);
  `,
  chevronOpen: css`transform: rotate(180deg);`,
  item: css`
    padding: 9px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  qlabel: css`font-size: 11px; color: ${cssVar.colorTextTertiary};`,
  qtext: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  apill: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 7px 10px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: 8px;
    background: ${cssVar.colorPrimaryBg};
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  badge: css`
    flex: none;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
    font-size: 10px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-block-start: 1px;
  `,
  rest: css`
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.38s cubic-bezier(0.34, 1.2, 0.64, 1);
  `,
  restOpen: css`grid-template-rows: 1fr;`,
  restInner: css`min-height: 0; overflow: hidden;`,
}));

interface QData { title: string; options: string[] }

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

export const AnsweredQuestionsCard = memo(function AnsweredQuestionsCard({
  args, result,
}: { args: unknown; result: unknown }) {
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

  const renderItem = (item: typeof items[0], nth: number) => (
    <div className={styles.item} key={nth}>
      {multi && <span className={styles.qlabel}>第 {nth + 1} 题</span>}
      {item.q && <div className={styles.qtext}>{item.q}</div>}
      {item.a && (
        <div className={styles.apill}>
          {item.letter && <span className={styles.badge}>{item.letter}</span>}
          <span>{item.a}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        {multi ? (
          <button className={styles.headBtn} onClick={() => setOpen((v) => !v)} type="button">
            <span className={styles.ok}>✓</span>
            <span className={styles.title}>已回答全部 {items.length} 题</span>
            <Icon className={cx(styles.chevron, open && styles.chevronOpen)} icon={ChevronDown} size={12} />
          </button>
        ) : (
          <><span className={styles.ok}>✓</span><span className={styles.title}>已回答</span></>
        )}
      </div>

      {first && renderItem(first, 0)}

      {multi && rest.length > 0 && (
        <div className={cx(styles.rest, open && styles.restOpen)}>
          <div className={styles.restInner}>
            {rest.map((item, i) => renderItem(item, i + 1))}
          </div>
        </div>
      )}
    </div>
  );
});
