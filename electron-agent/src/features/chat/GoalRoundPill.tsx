import { Target } from 'lucide-react';
import { memo } from 'react';
import { NoticeSplitPill } from './NoticeSplitPill';

const HEAD = /^Goal Round (\d+)\s*\/\s*\d+/;

/**
 * Goal 续跑一轮发给模型的正文（extensions/goal/prompt.ts buildGoalRoundPrompt）：
 * 首行 `Goal Round 4/256。` 换成「目标续跑 · 第 4 轮」，展开看这一轮模型收到的完整条件与要求。
 * 轮次预算不上卡片，和 Goal 条一致。
 */
export function goalRoundTitle(firstLine: string): string {
  const match = HEAD.exec(firstLine.trim());
  if (!match) return '目标续跑';
  return `目标续跑 · 第 ${match[1]} 轮`;
}

function GoalRoundPillInner({ content }: { content: string }) {
  return <NoticeSplitPill content={content} icon={Target} testId="goal-round-pill" formatTitle={goalRoundTitle} />;
}

export const GoalRoundPill = memo(GoalRoundPillInner);
