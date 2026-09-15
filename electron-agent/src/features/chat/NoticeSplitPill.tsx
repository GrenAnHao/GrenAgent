import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { MutedLine } from './conv/MutedLine';
import { LazyMarkdown } from './LazyMarkdown';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    max-height: 200px;
    margin-block-start: 4px;
    overflow: auto;
    padding-inline-end: 4px;
    scrollbar-width: thin;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${cssVar.colorTextSecondary};

    & .pi-md.pi-md.pi-md :is(h1, h2, h3, h4, h5, h6) {
      margin: 4px 0;
      font-size: var(--pi-font-size-secondary, 13px);
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
    }

    & .pi-md.pi-md.pi-md p {
      margin: 4px 0;
    }

    & .pi-md.pi-md.pi-md :is(ul, ol) {
      margin: 2px 0;
      padding-inline-start: 18px;
    }

    & .pi-md.pi-md.pi-md li {
      margin: 1px 0;
    }
  `,
}));

interface NoticeSplitPillProps {
  content: string;
  icon: LucideIcon;
  testId: string;
}

function NoticeSplitPillInner({ content, icon, testId }: NoticeSplitPillProps) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = useMemo(() => {
    const newline = content.search(/\r?\n/);
    const first = (newline === -1 ? content : content.slice(0, newline)).trim();
    const rest = newline === -1 ? '' : content.slice(newline).replace(/^\r?\n/, '');
    return { title: first || content.trim(), body: rest || content };
  }, [content]);
  return (
    <div data-testid={testId} style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <MutedLine icon={icon} text={title} open={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded ? (
        <div className={styles.body}>
          <LazyMarkdown variant="chat" tone="secondary">
            {body}
          </LazyMarkdown>
        </div>
      ) : null}
    </div>
  );
}

export const NoticeSplitPill = memo(NoticeSplitPillInner);
