import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "pi-sandbox";
const TTL_MS = 24 * 60 * 60 * 1000;
const dirs = new Map<string, string>();
let swept = false;

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default";
}

function rootDir(): string {
  return join(tmpdir(), PREFIX);
}

function sessionTempPath(sessionId: string): string {
  return join(rootDir(), safeSessionId(sessionId));
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function assertDisjoint(workspace: string, temp: string): void {
  const left = normalize(workspace);
  const right = normalize(temp);
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
    throw new Error(`writable roots must be disjoint: ${workspace} vs ${temp}`);
  }
}

function sweepExpired(): void {
  if (swept) return;
  swept = true;
  const root = rootDir();
  if (!existsSync(root)) return;
  const now = Date.now();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (now - st.mtimeMs > TTL_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // leftover from a previous process; ignore races
    }
  }
}

export function acquireTempDir(sessionId: string, workspaceRoot: string): string {
  sweepExpired();
  const dir = dirs.get(sessionId) ?? sessionTempPath(sessionId);
  assertDisjoint(workspaceRoot, dir);
  if (!dirs.has(sessionId)) {
    mkdirSync(dir, { recursive: true });
    dirs.set(sessionId, dir);
  }
  return dir;
}

export function dispose(sessionId: string): void {
  const dir = dirs.get(sessionId);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // leftover handles or races; still drop the session mapping
  }
  dirs.delete(sessionId);
}
