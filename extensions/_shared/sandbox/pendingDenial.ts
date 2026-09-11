import type { FileSandboxMode } from "./types.js";

const pending = new Map<string, { mode: FileSandboxMode }>();

function normalizeWorkspace(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function denialKey(workspace: string, command: string, sessionId?: string): string {
  return `${normalizeWorkspace(workspace)}\0${sessionId ?? ""}\0${command}`;
}

export function rememberPendingDenial(
  workspace: string,
  command: string,
  mode: FileSandboxMode,
  sessionId?: string,
): void {
  pending.set(denialKey(workspace, command, sessionId), { mode });
}

export function consumePendingDenial(
  workspace: string,
  command: string,
  sessionId?: string,
): { mode: FileSandboxMode } | undefined {
  const key = denialKey(workspace, command, sessionId);
  const record = pending.get(key);
  if (!record) return undefined;
  pending.delete(key);
  return record;
}

export function clearPendingDenials(sessionId: string): void {
  const needle = `\0${sessionId}\0`;
  for (const key of pending.keys()) {
    const sep = key.indexOf("\0");
    if (sep >= 0 && key.startsWith(needle, sep)) pending.delete(key);
  }
}

export function __resetPendingDenialsForTest(): void {
  pending.clear();
}
