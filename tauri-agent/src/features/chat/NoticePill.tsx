import { Collapse, Flexbox, Icon } from '@lobehub/ui';
import { Sparkles } from 'lucide-react';
import { memo, useState } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

const TITLES: Record<string, string> = {
  'knowledge-rag': '已注入知识库上下文',
  'long-term-memory': '已注入长期记忆',
};

interface NoticePillProps {
  customType: string;
  content: string;
}

function NoticePillInner({ customType, content }: NoticePillProps) {
  const [expanded, setExpanded] = useState(false);
  const title = TITLES[customType] ?? '已注入上下文';

  return (
    <div data-testid="notice-pill" style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <Collapse
        variant="borderless"
        gap={4}
        activeKey={expanded ? ['notice'] : []}
        onChange={(keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          setExpanded(arr.includes('notice'));
        }}
        items={[
          {
            key: 'notice',
            label: (
              <Flexbox horizontal align="center" gap={6} style={{ fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
                <Icon icon={Sparkles} size={13} />
                <span>{title}</span>
              </Flexbox>
            ),
            children: <LazyMarkdown>{content}</LazyMarkdown>,
          },
        ]}
      />
    </div>
  );
}

export const NoticePill = memo(NoticePillInner);
