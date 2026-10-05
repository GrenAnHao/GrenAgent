import { currentCwd, currentSessionId } from "./workspace-context.js";

export type ApprovalPolicy = "readonly" | "ask" | "auto" | "workspace" | "full";

const POLICIES = new Set<ApprovalPolicy>(["readonly", "ask", "auto", "workspace", "full"]);
// byCwd 是项目默认档（新会话继承、无会话身份的调用读它）；bySession 是每个会话自己的档，优先。
const byCwd = new Map<string, ApprovalPolicy>();
const bySession = new Map<string, ApprovalPolicy>();

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

/** sessionId 省略时取 ALS 里的交互会话；会话没写过档时回退项目默认档。 */
export function getApprovalPolicy(cwd?: string, sessionId: string | undefined = currentSessionId()): ApprovalPolicy {
  const own = sessionId ? bySession.get(sessionId) : undefined;
  return own ?? byCwd.get(resolveCwd(cwd)) ?? "auto";
}
/** 带 sessionId 只写该会话；不带写项目默认档。 */
export function setApprovalPolicy(p: ApprovalPolicy, cwd?: string, sessionId?: string): void {
  if (sessionId) bySession.set(sessionId, p);
  else byCwd.set(resolveCwd(cwd), p);
}
/** 项目默认档（不看会话）。 */
export function getDefaultApprovalPolicy(cwd?: string): ApprovalPolicy {
  return byCwd.get(resolveCwd(cwd)) ?? "auto";
}
export function hasApprovalPolicy(cwd?: string, sessionId?: string): boolean {
  return sessionId ? bySession.has(sessionId) : byCwd.has(resolveCwd(cwd));
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
  bySession.clear();
}
