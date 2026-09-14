import { Bot } from 'lucide-react';
import { memo } from 'react';
import { NoticeSplitPill } from './NoticeSplitPill';

function SubagentSettledPillInner({ content }: { content: string }) {
  return <NoticeSplitPill content={content} icon={Bot} testId="subagent-settled-pill" />;
}

export const SubagentSettledPill = memo(SubagentSettledPillInner);
