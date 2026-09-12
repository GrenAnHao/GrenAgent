import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTempDir, dispose } from "./tempDirs.js";

const workspace = "D:/work/repo";
const sessions: string[] = [];

function sid(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessions.push(id);
  return id;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((id) => dispose(id)));
});

describe("acquireTempDir", () => {
  it("reuses the same directory for the same sessionId", () => {
    const sessionId = sid("reuse");
    const first = acquireTempDir(sessionId, workspace);
    const second = acquireTempDir(sessionId, workspace);
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);
  });

  it("removes the directory after dispose", async () => {
    const sessionId = sid("gone");
    const dir = acquireTempDir(sessionId, workspace);
    expect(existsSync(dir)).toBe(true);
    await dispose(sessionId);
    expect(existsSync(dir)).toBe(false);
  });

  it("rejects a workspace that equals the temp root", () => {
    const sessionId = sid("overlap");
    const dir = acquireTempDir(sessionId, workspace);
    expect(() => acquireTempDir(sessionId, dir)).toThrow();
  });
});
