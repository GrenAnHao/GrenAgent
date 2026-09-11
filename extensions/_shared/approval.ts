// 进程内共享的审批策略（多扩展读同一份）。运行时只读内存；
// 对话中切档走 setApprovalPolicy，下一刀工具调用立刻看到。
// 文件只给 session_start / watchConfig 灌内存，以及重启后恢复。默认 auto。
import { currentCwd } from "./workspace-context.js";

export type ApprovalPolicy = "ask" | "auto" | "full";

const byCwd = new Map<string, ApprovalPolicy>();

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

export function getApprovalPolicy(cwd?: string): ApprovalPolicy {
  return byCwd.get(resolveCwd(cwd)) ?? "auto";
}

export function setApprovalPolicy(p: ApprovalPolicy, cwd?: string): void {
  byCwd.set(resolveCwd(cwd), p);
}

export function hasApprovalPolicy(cwd?: string): boolean {
  return byCwd.has(resolveCwd(cwd));
}

/** 与主进程 approvalPolicyConfigKey 保持一致：工作区路径规范化后作为热更新键。 */
export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${normalizeCwd(workspace)}`;
}

export function parseApproval(s: string | undefined): ApprovalPolicy | undefined {
  const v = (s ?? "").trim().toLowerCase();
  return v === "ask" || v === "auto" || v === "full" ? v : undefined;
}

export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  ask: "请求批准",
  auto: "替我审批",
  full: "完全访问",
};

/** 仅测试。 */
export function __resetApprovalForTest(): void {
  byCwd.clear();
}
