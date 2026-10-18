import type { ConfinedArgv, SandboxPolicy } from "../types.js";
import { SANDBOX_DENIAL_EXIT } from "../types.js";
import { capabilitySid } from "./sids.js";

// Git Bash（msys）报的是 Permission denied，原生程序报 Access is denied。
const DENIAL_SIGNATURES = ["access is denied", "拒绝访问", "permission denied"] as const;

const RUNNER_FAILURE_RULES = [
  {
    kind: "runner-launch-failed" as const,
    exitCodes: [163],
    signatures: ["pi-sandbox-win:"],
  },
  {
    kind: "runner-launch-failed" as const,
    // WSL bash CreateInstance → 1; MSYS signal pipe → STATUS_DLL_INIT_FAILED.
    exitCodes: [1, 3221225794, -1073741502],
    signatures: [
      "bash/service/createinstance",
      "couldn't create signal pipe",
      "createfilemapping",
    ],
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
      "--workspace",
      policy.workspaceRoot,
      "--workspace-sid",
      capabilitySid("workspace", policy.workspaceRoot),
      "--temp",
      tempDir,
      "--temp-sid",
      capabilitySid("temp", tempDir),
    );
  } else {
    prefix.push("--temp", tempDir);
  }
  return [...prefix, "--", ...argv];
}

export interface SandboxLogon {
  username: string;
  blobPath: string;
  /** Profile directory the account owns, for example C:\\Users\\PiSandbox. */
  home?: string;
}

/** Launch the command as the dedicated sandbox account. No capability SIDs. */
export function windowsAccountArgv(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  argv: string[],
  helperPath: string,
  tempDir: string,
  identity: SandboxLogon,
): string[] {
  const prefix = [
    helperPath,
    "--logon-user",
    identity.username,
    "--logon-blob",
    identity.blobPath,
    "--temp",
    tempDir,
  ];
  if (identity.home) {
    prefix.push("--sandbox-home", identity.home);
  }
  if (policy.mode === "workspace-write") {
    prefix.push("--workspace", policy.workspaceRoot);
  }
  return [...prefix, "--", ...argv];
}

export function windowsAccountConfined(
  policy: SandboxPolicy,
  argv: string[],
  helperPath: string,
  tempDir: string,
  identity: SandboxLogon,
): ConfinedArgv {
  return {
    argv: windowsAccountArgv(policy, argv, helperPath, tempDir, identity),
    enforcement: "partial",
    denialExitCodes: [SANDBOX_DENIAL_EXIT],
    denialSignatures: [...DENIAL_SIGNATURES],
    runnerFailureRules: RUNNER_FAILURE_RULES,
  };
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
