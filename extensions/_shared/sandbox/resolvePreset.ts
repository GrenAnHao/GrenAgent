import type { ApprovalPolicy } from "../approval.js";
import type { AgentMode } from "../../agent-mode/modes.js";
import type { FileSandboxMode, SandboxExecutionPolicy } from "./types.js";

export function fileModeForApproval(approval: ApprovalPolicy): FileSandboxMode {
  if (approval === "readonly") return "read-only";
  if (approval === "full") return "danger-full-access";
  return "workspace-write";
}

export function resolvePreset(input: {
  approval: ApprovalPolicy;
  agentMode: AgentMode;
  workspaceRoot: string;
  sessionId?: string;
}): SandboxExecutionPolicy {
  const mode = input.agentMode === "ask" ? "read-only" : fileModeForApproval(input.approval);
  return {
    mode,
    network: "enabled",
    workspaceRoot: input.workspaceRoot,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function isConfined(mode: FileSandboxMode): mode is Exclude<FileSandboxMode, "danger-full-access"> {
  return mode !== "danger-full-access";
}
