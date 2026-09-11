import type { ConfinedArgv, SandboxPolicy } from "../types.js";
import { SANDBOX_DENIAL_EXIT } from "../types.js";
import { capabilitySid } from "./sids.js";

const DENIAL_SIGNATURES = ["access is denied", "拒绝访问"] as const;

const RUNNER_FAILURE_RULES = [
  {
    kind: "runner-launch-failed" as const,
    exitCodes: [163],
    signatures: ["pi-sandbox-win:"],
  },
];

export function windowsHelperArgv(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  argv: string[],
  helperPath: string,
  tempDir: string,
): string[] {
  const prefix = [helperPath];
  if (policy.mode === "workspace-write") {
    prefix.push(
      "--workspace-sid",
      capabilitySid("workspace", policy.workspaceRoot),
      "--temp-sid",
      capabilitySid("temp", tempDir),
    );
  }
  return [...prefix, "--", ...argv];
}

export function windowsConfined(
  policy: SandboxPolicy,
  argv: string[],
  helperPath: string,
  tempDir: string,
): ConfinedArgv {
  return {
    argv: windowsHelperArgv(policy, argv, helperPath, tempDir),
    enforcement: "partial",
    denialExitCodes: [SANDBOX_DENIAL_EXIT],
    denialSignatures: [...DENIAL_SIGNATURES],
    runnerFailureRules: RUNNER_FAILURE_RULES,
  };
}
