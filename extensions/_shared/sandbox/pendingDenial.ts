import type { FileSandboxMode } from "./types.js";

const pending = new Map<string, { mode: FileSandboxMode }>();

function denialKey(workspace: string, command: string): string {
  return `${workspace}\0${command}`;
}

export function rememberPendingDenial(workspace: string, command: string, mode: FileSandboxMode): void {
  pending.set(denialKey(workspace, command), { mode });
}

export function consumePendingDenial(
  workspace: string,
  command: string,
): { mode: FileSandboxMode } | undefined {
  const key = denialKey(workspace, command);
  const record = pending.get(key);
  if (!record) return undefined;
  pending.delete(key);
  return record;
}

export function __resetPendingDenialsForTest(): void {
  pending.clear();
}
