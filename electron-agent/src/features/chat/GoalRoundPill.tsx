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

export function goalRoundDetailsTitle(firstLine: string, details?: unknown): string {
  const value = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const { runNumber, runRound } = value;
  if (typeof runNumber === 'number' && Number.isSafeInteger(runNumber) && runNumber > 0
    && typeof runRound === 'number' && Number.isSafeInteger(runRound) && runRound > 0) {
    return `目标续跑 · 第 ${runNumber} 批 · 第 ${runRound} 轮`;
  }
  return goalRoundTitle(firstLine);
}

function GoalRoundPillInner({ content, details }: { content: string; details?: unknown }) {
  return <NoticeSplitPill content={content} icon={Target} testId="goal-round-pill" formatTitle={(line) => goalRoundDetailsTitle(line, details)} />;
}

export const GoalRoundPill = memo(GoalRoundPillInner);
