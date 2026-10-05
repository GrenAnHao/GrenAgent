export type FileSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type NetworkSandboxPolicy = "restricted" | "enabled"
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: FileSandboxMode
  network: NetworkSandboxPolicy
  workspaceRoot: string
  sessionId?: string
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: Exclude<FileSandboxMode, "danger-full-access">
}

export interface RunnerFailureRule {
  kind: "runner-missing" | "runner-launch-failed" | "runner-internal"
  exitCodes: readonly number[]
  signatures: readonly string[]
}

export interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  denialExitCodes: readonly number[]
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

export interface SandboxProvider {
  confine(argv: string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
  dispose?(sessionId: string): Promise<void>
}

export interface BashEscalationRequest {
  command: string
  justification: string
  targetMode: FileSandboxMode
}

export const SANDBOX_DENIAL_EXIT = 162;
