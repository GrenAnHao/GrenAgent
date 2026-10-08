export type {
  ConfinedArgv,
  FileSandboxMode,
  NetworkSandboxPolicy,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxPolicy,
  SandboxProvider,
  SandboxRunFacts,
} from "./types.js";
export { SANDBOX_DENIAL_EXIT } from "./types.js";
export { SandboxUnavailableError } from "./errors.js";
export { fileModeForApproval, isConfined, resolvePreset } from "./resolvePreset.js";
export { isStrictWidening } from "./escalate.js";
export {
  ESCALATION_TARGETS,
  escalationHintMarker,
  parseSandboxNote,
  runnerFailedMarker,
  sandboxDenialMarker,
  sandboxNotes,
} from "./facts.js";
export type { EscalationTarget, SandboxNote } from "./facts.js";
export { clearEscalationGrants, grantEscalation, takeEscalationGrant } from "./escalationGrant.js";
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
export { withTextMarkers } from "./userBash.js";
export { acquireTempDir, dispose as disposeTempDir } from "./tempDirs.js";
