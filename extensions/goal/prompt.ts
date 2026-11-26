import { GOAL_BLOCKED_MIN_ROUNDS } from "./types.js";

export function buildGoalRoundPrompt(input: {
  condition: string;
  round: number;
  maxRounds: number;
  runNumber?: number;
  runRound?: number;
}): string {
  return [
    `Goal Round ${input.round}/${input.maxRounds}。`,
    ...(input.runNumber !== undefined ? [`运行批次：第 ${input.runNumber} 批 · 第 ${input.runRound ?? input.round} 轮（累计 ${input.round} 轮）。`] : []),
    `当前完成条件：${input.condition}`,
    "",
    "对着当前工作区逐条核对这些需求，用仓库里的实际证据判断是否已经完成。",
    "证据不够就继续干活。禁止靠记忆把目标标为 complete。",
    `blocked 必须同一障碍连续达到 ${GOAL_BLOCKED_MIN_ROUNDS} 轮才允许上报。`,
  ].join("\n");
}
