import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSubagentProcess,
  killSubagentsFor,
  killAllSubagents,
  killProcessTree,
  __resetSubagentProcessesForTest,
} from "./subagentProcessRegistry.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(() => ({ unref() {}, on() { return this; } })) };
});

afterEach(() => {
  vi.mocked(spawn).mockClear();
  __resetSubagentProcessesForTest();
});

function child(pid: number) {
  return {
    pid,
    killed: false,
    exitCode: null,
    kill: vi.fn(function (this: { killed: boolean }) { this.killed = true; }),
    once: vi.fn(),
  };
}

describe("subagentProcessRegistry", () => {
  it("killSubagentsFor 只杀该 cwd", () => {
    const a = child(11);
    const b = child(22);
    registerSubagentProcess("D:/a", a as never);
    registerSubagentProcess("D:/b", b as never);
    killSubagentsFor("D:/a");
    expect(a.kill).toHaveBeenCalled();
  });

  it("子进程 exit 后自动从登记表移除", () => {
    const a = child(11) as { pid: number; kill: ReturnType<typeof vi.fn>; on?: Function; once?: Function };
    const handlers: Record<string, () => void> = {};
    a.once = (ev: string, fn: () => void) => { handlers[ev] = fn; };
    registerSubagentProcess("D:/a", a as never);
    handlers.exit?.();
    killSubagentsFor("D:/a");
    expect(a.kill).not.toHaveBeenCalled();
  });

  it("killAllSubagents 杀全部", () => {
    const a = child(11);
    const b = child(22);
    registerSubagentProcess("D:/a", a as never);
    registerSubagentProcess("D:/b", b as never);
    killAllSubagents();
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).toHaveBeenCalled();
  });

  it("POSIX killProcessTree 先杀进程组", () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const c = { pid: 4242, kill: vi.fn() };
    killProcessTree(c as never);
    expect(spy).toHaveBeenCalledWith(-4242, "SIGKILL");
    spy.mockRestore();
  });
});
