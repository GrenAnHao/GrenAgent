import type { ConfinedArgv } from "./types.js";

export type RunKind = "runner-failure" | "denial" | "command";

export function attributeRun(
  result: { exitCode: number | null; stdout?: string; stderr?: string; spawnError?: unknown },
  confined: Pick<ConfinedArgv, "denialExitCodes" | "denialSignatures" | "runnerFailureRules">,
): { kind: RunKind } {
  if (result.spawnError) return { kind: "runner-failure" };
  if (result.exitCode == null) return { kind: "command" };
  const code = result.exitCode;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  const stderr = (result.stderr ?? "").toLowerCase();
  for (const rule of confined.runnerFailureRules) {
    if (rule.exitCodes.includes(code) && rule.signatures.some((s) => combined.includes(s.toLowerCase()))) {
      return { kind: "runner-failure" };
    }
  }
  if (confined.denialExitCodes.includes(code)) return { kind: "denial" };
  if (code !== 0 && confined.denialSignatures.some((s) => stderr.includes(s.toLowerCase()))) {
    return { kind: "denial" };
  }
  return { kind: "command" };
}
