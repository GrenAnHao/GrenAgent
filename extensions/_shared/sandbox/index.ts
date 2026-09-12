export type {
  BashEscalationRequest,
  ConfinedArgv,
  FileSandboxMode,
  NetworkSandboxPolicy,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxPolicy,
  SandboxProvider,
} from "./types.js";
export { SANDBOX_DENIAL_EXIT } from "./types.js";
export { SandboxUnavailableError } from "./errors.js";
export { fileModeForApproval, isConfined, resolvePreset } from "./resolvePreset.js";
export { isStrictWidening, justifyOk } from "./escalate.js";
export {
  clearPendingDenials,
  consumePendingDenial,
  peekPendingDenial,
  rememberPendingDenial,
} from "./pendingDenial.js";
export { attributeRun } from "./attribute.js";
export type { RunKind } from "./attribute.js";
export { createSandboxProvider } from "./provider.js";
export type { SandboxProbeResult, SandboxProviderDeps } from "./provider.js";
export { createSandboxedBashOperations } from "./operations.js";
export type {
  ExecOptions,
  SandboxedBashOperations,
  SandboxedBashOperationsDeps,
  SpawnImpl,
} from "./operations.js";
export { acquireTempDir, dispose as disposeTempDir } from "./tempDirs.js";
