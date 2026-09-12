import type { FileSandboxMode } from "./types.js";

const pending = new Map<string, { mode: FileSandboxMode }>();

function normalizeWorkspace(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function denialKey(workspace: string, command: string, sessionId?: string): string {
  return `${normalizeWorkspace(workspace)}\0${sessionId ?? ""}\0${command}`;
}

function lastSegment(command: string): string {
  const idx = command.lastIndexOf("\n");
  return idx >= 0 ? command.slice(idx + 1) : command;
}

function findPendingKey(workspace: string, command: string, sessionId?: string): string | undefined {
  const exact = denialKey(workspace, command, sessionId);
  if (pending.has(exact)) return exact;

  const last = lastSegment(command);
  if (last !== command) {
    const lastKey = denialKey(workspace, last, sessionId);
    if (pending.has(lastKey)) return lastKey;
  }

  const prefix = `${normalizeWorkspace(workspace)}\0${sessionId ?? ""}\0`;
  for (const key of pending.keys()) {
    if (!key.startsWith(prefix)) continue;
    const stored = key.slice(prefix.length);
    if (lastSegment(stored) === command || lastSegment(stored) === last) return key;
  }
}

export function rememberPendingDenial(
  workspace: string,
  command: string,
  mode: FileSandboxMode,
  sessionId?: string,
): void {
  pending.set(denialKey(workspace, command, sessionId), { mode });
}

/** 查找 pending，不删除。匹配规则与 consume 相同。 */
export function peekPendingDenial(
  workspace: string,
  command: string,
  sessionId?: string,
): { mode: FileSandboxMode } | undefined {
  const key = findPendingKey(workspace, command, sessionId);
  return key === undefined ? undefined : pending.get(key);
}

/** consume 必须带与 remember 相同的 sessionId。先精确匹配，失败再试最后一段。 */
export function consumePendingDenial(
  workspace: string,
  command: string,
  sessionId?: string,
): { mode: FileSandboxMode } | undefined {
  const key = findPendingKey(workspace, command, sessionId);
  if (key === undefined) return undefined;
  const record = pending.get(key);
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
