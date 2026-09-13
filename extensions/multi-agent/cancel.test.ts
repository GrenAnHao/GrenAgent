import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getActivation, installActivation, __resetActivationsForTest } from "./activation.js";
import { appendCancelRequest, cancelRequestPath, cancelSubAgent, drainCancelRequests, installCancelWatcher, uninstallCancelWatcher } from "./cancel.js";
import { registerParentSessionHost, __resetParentHostsForTest } from "./parent-host.js";
import { SubAgentRegistry } from "./registry.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  __resetActivationsForTest();
  __resetParentHostsForTest();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sa-cancel-"));
  dirs.push(dir);
  return dir;
}

function persistSession(sm: SessionManager): string {
  const path = sm.getSessionFile();
  if (!path) throw new Error("session file was not created");
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function writeMeta(cwd: string, id: string, data: Record<string, unknown>): string {
  const sm = SessionManager.create(cwd, join(cwd, "sessions"), { id });
  sm.appendCustomEntry("subagent_meta", data);
  return persistSession(sm);
}

function lastSubagentMetaData(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const item = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (item?.type === "custom" && item.customType === "subagent_meta" && item.data && typeof item.data === "object") {
      found = item.data;
    }
  }
  return found;
}

function mockSession() {
  const state = { isStreaming: false };
  let idleResolve!: () => void;
  let idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  return {
    get isStreaming() {
      return state.isStreaming;
    },
    set isStreaming(value: boolean) {
      state.isStreaming = value;
    },
    pendingMessageCount: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "child done" }] }],
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    waitForIdle: () => {
      if (!state.isStreaming) return Promise.resolve();
      return idle;
    },
    resolveIdle: () => {
      state.isStreaming = false;
      idleResolve();
      idle = new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },
  };
}

function mockSessionManager(data: Record<string, unknown> = { mode: "continuable", parentSessionId: "p1" }) {
  return {
    getEntries: () => [{ type: "custom", customType: "subagent_meta", data }],
    appendCustomEntry: vi.fn(),
  };
}

function runningRegistry(cwd: string, id: string, sessionPath?: string | null) {
  const reg = new SubAgentRegistry(join(cwd, "registry.db"));
  reg.load();
  reg.create({ id, task: "t", sessionPath });
  return reg;
}

describe("cancel requests", () => {
  it("appendCancelRequest writes jsonl line", () => {
    const cwd = tmpCwd();
    appendCancelRequest(cwd, "sa-abc");
    const raw = readFileSync(cancelRequestPath(cwd), "utf8").trim();
    expect(JSON.parse(raw).agentId).toBe("sa-abc");
  });

  it("drain processes only new lines", () => {
    const cwd = tmpCwd();
    const seen: string[] = [];
    const offset = { lines: 0 };
    mkdirSync(join(cwd, ".pi", "subagents"), { recursive: true });
    writeFileSync(cancelRequestPath(cwd), '{"agentId":"sa-1"}\n', "utf8");
    drainCancelRequests(cwd, offset, (id) => seen.push(id));
    expect(seen).toEqual(["sa-1"]);
    appendCancelRequest(cwd, "sa-2");
    drainCancelRequests(cwd, offset, (id) => seen.push(id));
    expect(seen).toEqual(["sa-1", "sa-2"]);
  });

  it("cancelSubAgent aborts inflight and marks cancelled", () => {
    const cwd = tmpCwd();
    const reg = new SubAgentRegistry(join(cwd, "registry.db"));
    reg.load();
    const id = SubAgentRegistry.genId();
    reg.create({ id, task: "t" });
    const controller = new AbortController();
    const inflight = new Map<string, AbortController>([[id, controller]]);
    cancelSubAgent(id, reg, inflight);
    expect(controller.signal.aborted).toBe(true);
    expect(reg.get(id)?.status).toBe("cancelled");
    expect(inflight.has(id)).toBe(false);
    reg.close();
  });

  it("installCancelWatcher invokes handler for appended requests", async () => {
    const cwd = tmpCwd();
    const seen: string[] = [];
    installCancelWatcher(cwd, (id) => seen.push(id));
    appendCancelRequest(cwd, "sa-watch");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toContain("sa-watch");
    uninstallCancelWatcher(cwd);
  });

  it("uninstallCancelWatcher is idempotent", () => {
    const cwd = tmpCwd();
    expect(uninstallCancelWatcher(cwd)).toBe(false);
    installCancelWatcher(cwd, () => {});
    expect(uninstallCancelWatcher(cwd)).toBe(true);
    expect(uninstallCancelWatcher(cwd)).toBe(false);
  });
});

describe("cancelSubAgent tornDown", () => {
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
  });

  it("resident activation writes tornDown via its sessionManager and does not SessionManager.open", async () => {
    const cwd = tmpCwd();
    const id = "sa-live01";
    const reg = runningRegistry(cwd, id, "/ws/child.jsonl");
    const controller = new AbortController();
    const inflight = new Map<string, AbortController>([[id, controller]]);
    const sessionManager = mockSessionManager();
    installActivation({
      childId: id,
      sessionPath: "/ws/child.jsonl",
      parentSessionId: "p1",
      parentSessionPath: "/ws/parent.jsonl",
      workspace: "A",
      session: mockSession(),
      sessionManager,
    });
    const open = vi.spyOn(SessionManager, "open");

    cancelSubAgent(id, reg, inflight);

    expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "subagent_meta",
      expect.objectContaining({ tornDown: true, mode: "continuable" }),
    );
    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getActivation(id)).toBeUndefined();
    });
    expect(reg.get(id)?.status).toBe("cancelled");
    expect(controller.signal.aborted).toBe(true);
    expect(inflight.has(id)).toBe(false);
    reg.close();
  });

  it("without activation writes tornDown onto the registry sessionPath jsonl", () => {
    const cwd = tmpCwd();
    const id = "sa-cold01";
    const sessionPath = writeMeta(cwd, id, { mode: "continuable" });
    const reg = runningRegistry(cwd, id, sessionPath);
    const inflight = new Map<string, AbortController>();

    cancelSubAgent(id, reg, inflight);

    const meta = lastSubagentMetaData(SessionManager.open(sessionPath).getEntries());
    expect(meta?.tornDown).toBe(true);
    expect(reg.get(id)?.status).toBe("cancelled");
    reg.close();
  });

  it("invalid session jsonl does not block cancel", () => {
    const cwd = tmpCwd();
    const id = "sa-bad01";
    const sessionPath = join(cwd, "sessions", `${id}.jsonl`);
    mkdirSync(join(cwd, "sessions"), { recursive: true });
    writeFileSync(sessionPath, "not a pi session\n");
    const reg = runningRegistry(cwd, id, sessionPath);
    const inflight = new Map<string, AbortController>();

    expect(() => cancelSubAgent(id, reg, inflight)).not.toThrow();
    expect(reg.get(id)?.status).toBe("cancelled");
    reg.close();
  });

  it("without sessionPath or activation does not throw or open a session file", () => {
    const cwd = tmpCwd();
    const id = "sa-nopath";
    const reg = runningRegistry(cwd, id);
    const inflight = new Map<string, AbortController>();
    const open = vi.spyOn(SessionManager, "open");

    expect(() => cancelSubAgent(id, reg, inflight)).not.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(reg.get(id)?.status).toBe("cancelled");
    reg.close();
  });

  it("announced resident cancel sends aborted settlement notice", async () => {
    const cwd = tmpCwd();
    const id = "sa-stop01";
    const reg = runningRegistry(cwd, id, "/ws/child.jsonl");
    const inflight = new Map<string, AbortController>();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/parent.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    const session = mockSession();
    session.isStreaming = true;
    installActivation({
      childId: id,
      sessionPath: "/ws/child.jsonl",
      parentSessionId: "p1",
      parentSessionPath: "/ws/parent.jsonl",
      workspace: "A",
      session,
      announced: true,
      sessionManager: mockSessionManager(),
    });

    cancelSubAgent(id, reg, inflight);

    await vi.waitFor(() => {
      expect(getActivation(id)).toBeUndefined();
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-settled",
        content: expect.stringContaining("was stopped"),
      }),
      expect.anything(),
    );
    reg.close();
  });
});
