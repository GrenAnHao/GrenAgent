import type { GoalSnapshot } from "./types.js";

export function goalStatusSentence(snapshot: GoalSnapshot): string {
  if (snapshot.status === "paused") return "已暂停的目标";
  if (snapshot.status === "blocked") return "受阻的目标";
  if (snapshot.status === "complete") return "已完成的目标";
  if (snapshot.activation === "armed") return "执行中的目标";
  return "未运行的目标";
}

export function formatGoalReceipt(snapshot: GoalSnapshot): string {
  const lines = [
    goalStatusSentence(snapshot),
    snapshot.condition,
    `${snapshot.roundsStarted}/${snapshot.maxRounds}`,
    snapshot.activation ?? "disarmed",
  ];
  if (snapshot.status === "blocked" && snapshot.blockedReason?.message) {
    lines.push(snapshot.blockedReason.message);
  }
  return lines.join(" · ");
}
