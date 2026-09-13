import { createStaticStyles, cssVar } from 'antd-style';
import { Bot } from 'lucide-react';
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
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    & h1,
    & h2,
    & h3,
    & h4 {
      margin: 4px 0;
      font-size: 12px;
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
    }

    & p {
      margin: 4px 0;
    }

    & ul,
    & ol {
      margin: 2px 0;
      padding-inline-start: 18px;
    }

    & li {
      margin: 1px 0;
    }
  `,
}));

interface SubagentSettledPillProps {
  content: string;
}

function SubagentSettledPillInner({ content }: SubagentSettledPillProps) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = useMemo(() => {
    const newline = content.search(/\r?\n/);
    const first = (newline === -1 ? content : content.slice(0, newline)).trim();
    const title = first || content.trim();
    const rest = newline === -1 ? '' : content.slice(newline).replace(/^\r?\n/, '');
    return { title, body: rest || content };
  }, [content]);

  return (
    <div data-testid="subagent-settled-pill" style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <MutedLine
        icon={Bot}
        text={title}
        open={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded ? (
        <div className={styles.body}>
          <LazyMarkdown variant="chat" fontSize={12}>
            {body}
          </LazyMarkdown>
        </div>
      ) : null}
    </div>
  );
}

export const SubagentSettledPill = memo(SubagentSettledPillInner);
