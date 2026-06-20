import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronDown } from 'lucide-react';
import { Icon } from '@lobehub/ui';
import { memo, useState } from 'react';
import { extractText } from './toolUtils';

const styles = createStaticStyles(({ css }) => ({
  card: css`
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
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
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
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    &:last-child { border-block-end: none; }
  `,
  qlabel: css`font-size: 11px; color: ${cssVar.colorTextTertiary};`,
  qtext: css`font-size: 13px; color: ${cssVar.colorTextSecondary}; line-height: 1.4;`,
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
  rest: css`
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.38s cubic-bezier(0.34, 1.2, 0.64, 1);
  `,
  restOpen: css`grid-template-rows: 1fr;`,
  restInner: css`min-height: 0; overflow: hidden;`,
}));

function extractQTitles(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const qs = (args as { questions?: unknown[] }).questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is { question?: unknown } => Boolean(q) && typeof q === 'object')
    .map((q) => String(q.question ?? '').trim())
    .filter(Boolean);
}

function parseAnswerLines(result: unknown): string[] {
  const text = extractText(result);
  if (!text) return [];
  return text
    .split('\n')
    .filter((l) => /^\d+\./.test(l.trim()))
    .map((l) => l.replace(/^\d+\.\s*[^：]*：/, '').trim());
}

export const AnsweredQuestionsCard = memo(function AnsweredQuestionsCard({
  args,
  result,
}: {
  args: unknown;
  result: unknown;
}) {
  const [open, setOpen] = useState(false);
  const titles = extractQTitles(args);
  const answers = parseAnswerLines(result);

  if (titles.length === 0 && answers.length === 0) return null;

  const count = Math.max(titles.length, answers.length);
  const items = Array.from({ length: count }, (_, i) => ({
    q: titles[i] ?? '',
    a: answers[i] ?? '',
  }));
  const multi = items.length > 1;
  const [first, ...rest] = items;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        {multi ? (
          <button className={styles.headBtn} onClick={() => setOpen((v) => !v)} type="button">
            <span className={styles.ok}>✓</span>
            <span className={styles.title}>已回答全部 {items.length} 题</span>
            <Icon
              className={cx(styles.chevron, open && styles.chevronOpen)}
              icon={ChevronDown}
              size={12}
            />
          </button>
        ) : (
          <>
            <span className={styles.ok}>✓</span>
            <span className={styles.title}>已回答</span>
          </>
        )}
      </div>

      {first && (
        <div className={styles.item}>
          {multi && <span className={styles.qlabel}>第 1 题</span>}
          {first.q && <div className={styles.qtext}>{first.q}</div>}
          {first.a && <div className={styles.apill}>{first.a}</div>}
        </div>
      )}

      {multi && rest.length > 0 && (
        <div className={cx(styles.rest, open && styles.restOpen)}>
          <div className={styles.restInner}>
            {rest.map((item, i) => (
              <div className={styles.item} key={i}>
                <span className={styles.qlabel}>第 {i + 2} 题</span>
                {item.q && <div className={styles.qtext}>{item.q}</div>}
                {item.a && <div className={styles.apill}>{item.a}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
