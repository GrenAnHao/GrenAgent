import type { FileSandboxMode } from "./types.js";

const WIDEN: Record<FileSandboxMode, readonly FileSandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
  "danger-full-access": [],
};

export function isStrictWidening(from: FileSandboxMode, to: FileSandboxMode): boolean {
  return WIDEN[from].includes(to);
}
