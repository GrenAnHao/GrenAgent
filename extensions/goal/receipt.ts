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
    `第 ${snapshot.runNumber ?? 1} 批 ${(snapshot.runRoundsStarted ?? snapshot.roundsStarted)}/${snapshot.maxRounds}（累计 ${snapshot.roundsStarted} 轮）`,
    snapshot.activation ?? "disarmed",
  ];
  if (snapshot.status === "paused" && snapshot.pauseReason) {
    const labels = { user: "用户暂停", "max-rounds": "已达本批次轮次上限，人工恢复将开启新批次", "request-error": "请求最终失败", "runtime-error": "运行异常" };
    lines.push(labels[snapshot.pauseReason.code]);
    if (snapshot.pauseReason.message) lines.push(snapshot.pauseReason.message);
  }
  if (snapshot.status === "blocked" && snapshot.blockedReason?.message) {
    lines.push(snapshot.blockedReason.message);
  }
  return lines.join(" · ");
}
