import { afterEach, describe, expect, it, vi } from "vitest";

let failRm = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (failRm) throw new Error("busy");
      return actual.rmSync(path, options);
    },
  };
});

import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { acquireTempDir, dispose } from "./tempDirs.js";

const workspace = "D:/work/repo";
const sessions: string[] = [];

function sid(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessions.push(id);
  return id;
}

afterEach(async () => {
  failRm = false;
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

  it("forgets the session even if removing the directory fails", () => {
    const sessionId = sid("rm-fail");
    const dir = acquireTempDir(sessionId, workspace);
    failRm = true;
    expect(() => dispose(sessionId)).not.toThrow();
    failRm = false;
    const again = acquireTempDir(sessionId, workspace);
    expect(again).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
