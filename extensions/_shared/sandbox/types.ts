export type FileSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type NetworkSandboxPolicy = "restricted" | "enabled"
export type SandboxEnforcement = "full" | "partial"

export interface SandboxExecutionPolicy {
  mode: FileSandboxMode
  network: NetworkSandboxPolicy
  workspaceRoot: string
  sessionId?: string
}

/**
 * 一次 exec 的沙箱事实（DSH ShellSandboxInfo）：执行器作为数据返回，和退出码互不影响。
 * 给模型的标记由工具层用 facts.ts 渲染，不进输出流。
 */
export interface SandboxRunFacts {
  /** 这次实际生效的模式（含 PI_SANDBOX_MODE_ONCE 单次放宽）。 */
  mode: FileSandboxMode
  /** 沙箱拦下了文件操作（attributeRun 判为 denial）。 */
  denied: boolean
  /** 命令没有执行：unavailable = 隔离起不来；runner = runner 或壳没起来。 */
  runnerFailed?: "unavailable" | "runner"
  /** runnerFailed 的原因，原样交给模型和界面。 */
  detail?: string
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

export const SANDBOX_DENIAL_EXIT = 162;
