import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSessionCwdForTest,
  attachSessionCwd,
  projectCwd,
  recordedCwd,
  sessionCwdController,
  WORKING_DIRECTORY_ENTRY,
} from "./session-cwd.js";

let root: string;

function fakeSession(id: string, original: string, entries: unknown[] = []) {
  const runner = { cwd: original };
  const session = {
    sessionId: id,
    _cwd: original,
    extensionRunner: runner,
    sessionManager: {
      getCwd: () => original,
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data?: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
    },
  };
  return { session, runner, entries };
}

const wd = (cwd: string, extra: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: WORKING_DIRECTORY_ENTRY,
  data: { cwd, ...extra },
});

beforeEach(() => {
  __resetSessionCwdForTest();
  root = mkdtempSync(join(tmpdir(), "session-cwd-"));
  mkdirSync(join(root, "wt", "a"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("attachSessionCwd", () => {
  it("set() moves the runner cwd and the private session cwd, and records the change", () => {
    const { session, runner, entries } = fakeSession("s1", root);
    attachSessionCwd(session);
    const controller = sessionCwdController("s1")!;
    const change = controller.set("wt/a");
    expect(change.changed).toBe(true);
    expect(change.previous).toBe(root);
    expect(runner.cwd.toLowerCase()).toBe(join(root, "wt", "a").toLowerCase());
    expect(session._cwd).toBe(runner.cwd);
    expect(controller.current()).toBe(runner.cwd);
    expect(controller.original()).toBe(root);
    expect(recordedCwd(entries)).toBe(runner.cwd);
  });

  it("relative paths resolve against the current directory; unchanged moves record nothing", () => {
    const { session, entries } = fakeSession("s1", root);
    attachSessionCwd(session);
    const controller = sessionCwdController("s1")!;
    controller.set(join(root, "wt"));
    const before = entries.length;
    const again = controller.set(".");
    expect(again.changed).toBe(false);
    expect(entries.length).toBe(before);
    controller.set("a");
    expect(controller.current().toLowerCase()).toBe(join(root, "wt", "a").toLowerCase());
  });

  it("rejects missing directories and empty input without moving", () => {
    const { session, runner } = fakeSession("s1", root);
    attachSessionCwd(session);
    const controller = sessionCwdController("s1")!;
    expect(() => controller.set("nope")).toThrow(/does not exist/);
    expect(() => controller.set("  ")).toThrow(/must not be empty/);
    expect(runner.cwd).toBe(root);
  });

  it("restores the last recorded directory when a session is opened again", () => {
    const target = join(root, "wt", "a");
    const { session, runner } = fakeSession("s2", root, [wd(join(root, "wt")), wd(target)]);
    attachSessionCwd(session);
    expect(runner.cwd).toBe(target);
    expect(session._cwd).toBe(target);
  });

  it("falls back to the original directory and records why when the recorded one is gone", () => {
    const gone = join(root, "removed");
    const { session, runner, entries } = fakeSession("s3", root, [wd(gone)]);
    attachSessionCwd(session);
    expect(runner.cwd).toBe(root);
    expect(entries.at(-1)).toEqual(wd(root, { unavailable: gone }));
  });

  it("detach unregisters only its own controller; sessions without a manager are ignored", () => {
    const a = fakeSession("s4", root);
    const detachA = attachSessionCwd(a.session);
    const b = fakeSession("s4", root);
    attachSessionCwd(b.session);
    detachA();
    expect(sessionCwdController("s4")).toBeDefined();
    expect(attachSessionCwd({} as never)).toBeTypeOf("function");
  });
});

describe("projectCwd", () => {
  it("is the session header directory, not the current one", () => {
    expect(projectCwd({ cwd: "/wt", sessionManager: { getCwd: () => "/repo" } })).toBe("/repo");
    expect(projectCwd({ cwd: "/repo" })).toBe("/repo");
  });
});
