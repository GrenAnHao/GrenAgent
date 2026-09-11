import { createHash } from "node:crypto";

export type CapabilitySidKind = "workspace" | "temp";

function normalizeSandboxRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function capabilitySid(kind: CapabilitySidKind, root: string): string {
  const resolvedPath = normalizeSandboxRoot(root);
  const digest = createHash("sha256").update(`${kind}:${resolvedPath}`).digest();
  const a = digest.readUInt32LE(0);
  const b = digest.readUInt32LE(4);
  const c = digest.readUInt32LE(8);
  const d = digest.readUInt32LE(12);
  return `S-1-4-${a}-${b}-${c}-${d}`;
}

export function assertWritableRootsDisjoint(workspace: string, temp: string): void {
  const left = normalizeSandboxRoot(workspace);
  const right = normalizeSandboxRoot(temp);
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
    throw new Error(`writable roots must be disjoint: ${workspace} vs ${temp}`);
  }
}
