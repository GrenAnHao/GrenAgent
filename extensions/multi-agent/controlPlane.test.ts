import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetActivationsForTest, getActivation, installActivation } from "./activation.js";
import {
  __resetSubagentControlPlaneForTest,
  getRegistry,
  inflight,
  releaseChildForDelete,
  releaseSubagentControlPlane,
} from "./controlPlane.js";
import { __resetParentHostsForTest, registerParentSessionHost } from "./parent-host.js";
import { __resetJobsForTest } from "../jobs/service.js";
import { markChildRunning, takeSilenced } from "./child-runs.js";

const dirs: string[] = [];

afterEach(() => {
  __resetSubagentControlPlaneForTest();
  __resetActivationsForTest();
  __resetParentHostsForTest();
  __resetJobsForTest();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still be releasing a handle in a failed assertion */
    }
  }
});

function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sa-plane-"));
  dirs.push(dir);
  return dir;
}

/** 正在流式输出的子级；空闲的会自然结算并给父会话发回执，测不到删除路径本身。 */
function busySession() {
  return {
    isStreaming: true,
    pendingMessageCount: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    waitForIdle: () => new Promise<void>(() => {}),
  };
}

function parentHost(sessionPath: string, workspace: string) {
  const sendMessage = vi.fn();
  registerParentSessionHost({
    sessionId: "p1",
    sessionPath,
    workspace,
    isBusy: () => false,
    isDraining: () => false,
    sendMessage,
    prompt: vi.fn(),
  });
  return sendMessage;
}

describe("subagent control plane", () => {
  it("releaseSubagentControlPlane closes registry.db so the workspace can be removed", async () => {
    const cwd = tmpCwd();
    getRegistry(cwd);
    const dbPath = join(cwd, ".pi", "subagents", "registry.db");
    expect(existsSync(dbPath)).toBe(true);

    const result = releaseSubagentControlPlane(cwd);
    expect(result.released).toEqual([cwd]);
    await expect(rm(cwd, { recursive: true, force: true })).resolves.toBeUndefined();
    expect(existsSync(cwd)).toBe(false);
  });

  it("matches an equivalent path spelling when releasing", () => {
    const cwd = tmpCwd();
    getRegistry(cwd);
    const flipped = cwd.includes("\\") ? cwd.replace(/\\/g, "/") : cwd;
    expect(releaseSubagentControlPlane(flipped).released.length).toBe(1);
    expect(releaseSubagentControlPlane(cwd).released).toEqual([]);
  });
});

describe("releaseChildForDelete", () => {
  it("disposes a resident child without settling into the parent and marks its row cancelled", async () => {
    const cwd = tmpCwd();
    const parentPath = join(cwd, "parent.jsonl");
    const childPath = join(cwd, "child.jsonl");
    const sendMessage = parentHost(parentPath, cwd);
    const session = busySession();
    installActivation({
      childId: "sa-1",
      sessionPath: childPath,
      parentSessionId: "p1",
      parentSessionPath: parentPath,
      workspace: cwd,
      session,
      announced: true,
    });
    const registry = getRegistry(cwd);
    registry.create({ id: "sa-1", task: "t", sessionPath: childPath });
    inflight.set("sa-1", new AbortController());

    await releaseChildForDelete(cwd, "sa-1", childPath);

    expect(getActivation("sa-1")).toBeUndefined();
    expect(session.dispose).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(inflight.has("sa-1")).toBe(false);
    expect(registry.get("sa-1")?.status).toBe("cancelled");
  });

  it("aborts an in-flight background run, silences its settlement notice, and waits until the run has cleared", async () => {
    const cwd = tmpCwd();
    const childPath = join(cwd, "child.jsonl");
    const controller = new AbortController();
    const registry = getRegistry(cwd);
    registry.create({ id: "sa-2", task: "t", sessionPath: childPath });
    markChildRunning("sa-2", "p1");
    inflight.set("sa-2", controller);
    controller.signal.addEventListener("abort", () => {
      setTimeout(() => {
        registry.finish("sa-2", { status: "cancelled", exitCode: -1 });
        inflight.delete("sa-2");
      }, 30);
    });

    const released = releaseChildForDelete(cwd, "sa-2", childPath);
    expect(takeSilenced("sa-2")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(inflight.has("sa-2")).toBe(true);

    await expect(released).resolves.toEqual({ quiescent: true });
    expect(inflight.has("sa-2")).toBe(false);
    expect(registry.get("sa-2")?.status).toBe("cancelled");
  });

  it("reports quiescent=false when the aborted run does not clear within the cap", async () => {
    const cwd = tmpCwd();
    const controller = new AbortController();
    inflight.set("sa-stuck", controller);

    await expect(releaseChildForDelete(cwd, "sa-stuck", join(cwd, "child.jsonl"), { settleTimeoutMs: 60 }))
      .resolves.toEqual({ quiescent: false });
    expect(controller.signal.aborted).toBe(true);
    expect(inflight.has("sa-stuck")).toBe(true);
  });

  it("is a no-op for a child that is neither resident nor in flight", async () => {
    const cwd = tmpCwd();
    await expect(releaseChildForDelete(cwd, "sa-3", join(cwd, "child.jsonl"))).resolves.toEqual({ quiescent: true });
    await expect(releaseChildForDelete(cwd, null, join(cwd, "child.jsonl"))).resolves.toEqual({ quiescent: true });
    expect(existsSync(join(cwd, ".pi", "subagents", "registry.db"))).toBe(false);
  });
});
