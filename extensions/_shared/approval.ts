import { currentCwd } from "./workspace-context.js";

export type ApprovalPolicy = "readonly" | "ask" | "auto" | "workspace" | "full";

const POLICIES = new Set<ApprovalPolicy>(["readonly", "ask", "auto", "workspace", "full"]);
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
export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${normalizeCwd(workspace)}`;
}
export function parseApproval(s: string | undefined): ApprovalPolicy | undefined {
  const v = (s ?? "").trim().toLowerCase();
  return POLICIES.has(v as ApprovalPolicy) ? (v as ApprovalPolicy) : undefined;
}
export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return typeof v === "string" && POLICIES.has(v as ApprovalPolicy);
}

export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  readonly: "仅查看",
  ask: "请求批准",
  auto: "替我审批",
  workspace: "工作区编辑",
  full: "完全权限",
};

export function __resetApprovalForTest(): void {
  byCwd.clear();
}
