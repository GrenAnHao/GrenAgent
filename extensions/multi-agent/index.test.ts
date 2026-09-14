import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldCatalog } from "./catalog.js";
import * as catalogEvents from "./catalog-events.js";

// index.ts 的 spawn_agent execute() 此前无单测。这里用最小 mock 隔离 fs / 子进程 / sqlite，
// 覆盖 B（owner=full 时给自主子代理注入 APPROVAL_POLICY=auto，能力硬限不变）等运行时行为。
vi.mock("./workflows.js", () => ({ registerWorkflows: () => {} }));
vi.mock("./cancel.js", () => ({
  installCancelWatcher: () => {},
  uninstallCancelWatcher: () => false,
  cancelSubAgent: () => {},
}));
vi.mock("./worktree.js", () => ({ createWorktree: vi.fn(async () => null), worktreeDiff: vi.fn(async () => "") }));
vi.mock("./agents.js", () => ({
  discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
  resolveAgent: () => undefined,
  suggestAgent: () => undefined,
  withBuiltinDefaults: (agents: unknown) => agents,
}));
vi.mock("./registry.js", () => {
  class SubAgentRegistry {
    static genId() {
      return "sa_test";
    }
    load() {}
    reapOrphans() {}
    create() {}
    finish() {}
    touch() {}
    setSessionPath() {}
    remove() {}
    get() {
      return null;
    }
    list() {
      return [];
    }
    findStuck() {
      return [];
    }
    close() {}
  }
  return { SubAgentRegistry };
});
vi.mock("./runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner.js")>();
  return {
    ...actual,
    spawnPiAgent: vi.fn(async () => ({ ok: true, output: "done", exitCode: 0, transcript: "" })),
  };
});
vi.mock("./embedded-runner.js", () => ({
  canUseEmbeddedSubagent: vi.fn(() => false),
  runEmbeddedSubagent: vi.fn(async () => ({
    ok: true,
    output: "embedded-out",
    exitCode: 0,
    transcript: "",
    sessionPath: "/tmp/child.jsonl",
    stopReason: "completed",
  })),
  startContinuableEmbedded: vi.fn(async () => ({
    agentId: "sa_test",
    sessionPath: "/tmp/child.jsonl",
  })),
}));
vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: vi.fn(() => "auto") }));
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(() => undefined) }));

import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import { __resetSubagentControlPlaneForTest } from "./controlPlane.js";
import multiAgent from "./index.js";
import { spawnPiAgent } from "./runner.js";
import { canUseEmbeddedSubagent, runEmbeddedSubagent, startContinuableEmbedded } from "./embedded-runner.js";
import { runInWorkspace } from "../_shared/workspace-context.js";
import * as activation from "./activation.js";
import * as parentHost from "./parent-host.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: { cwd: string; model?: { provider?: string; id?: string } },
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean }>;

type SessionHandler = (event: unknown, ctx: unknown) => unknown;

function loadSpawnHarness(): {
  execute: Execute;
  appendEntry: ReturnType<typeof vi.fn>;
  handlers: Record<string, SessionHandler>;
  schema: Record<string, unknown>;
  toolNames: string[];
} {
  let exec: Execute | undefined;
  let schema: Record<string, unknown> = {};
  const toolNames: string[] = [];
  const appendEntry = vi.fn();
  const handlers: Record<string, SessionHandler> = {};
  const pi = {
    registerTool: (t: { name: string; execute: Execute; parameters?: { properties?: Record<string, unknown> } }) => {
      toolNames.push(t.name);
      if (t.name === "spawn_agent") {
        exec = t.execute;
        schema = t.parameters?.properties ?? {};
      }
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    on: (event: string, h: SessionHandler) => {
      handlers[event] = h;
    },
    appendEntry,
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  return { execute: exec!, appendEntry, handlers, schema, toolNames };
}

function loadSpawnAgent(): Execute {
  return loadSpawnHarness().execute;
}

const ctx = { cwd: process.platform === "win32" ? "D:\\proj" : "/proj" };

const AVAIL = [{ provider: "a", id: "b", name: "b", reasoning: true }, { provider: "a", id: "c", name: "c", reasoning: false }];
const ctxM = { ...ctx, modelRegistry: { getAvailable: () => AVAIL } };
const enable = (list = '["a/b","a/c"]') =>
  vi.mocked(getConfig).mockImplementation((k: string) =>
    k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL_SELECTION" ? "1" : k === "SUBAGENT_MODEL_ALLOWLIST" ? list : undefined,
  );

beforeEach(() => {
  __resetSubagentControlPlaneForTest();
  vi.clearAllMocks();
  // Hermetic: a stray PI_IS_SUBAGENT in the ambient env would trip the recursion guard.
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.SAFETY_READONLY;
  vi.mocked(getApprovalPolicy).mockReturnValue("auto");
  // 默认不限单会话上限，避免无关的 spawn 行为测试因模块级累计计数被拦；上限专测在下方单独设值。
  vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : undefined));
  vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
  vi.mocked(runEmbeddedSubagent).mockResolvedValue({
    ok: true,
    output: "embedded-out",
    exitCode: 0,
    transcript: "",
    sessionPath: "/tmp/child.jsonl",
    stopReason: "completed",
  });
  vi.mocked(startContinuableEmbedded).mockResolvedValue({
    agentId: "sa_test",
    sessionPath: "/tmp/child.jsonl",
  });
});

describe("spawn_agent · approval policy injected into sub-agent (B)", () => {
  const injectedPolicy = () => (vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.env as Record<string, string>).APPROVAL_POLICY;

  it("floors owner full → auto for autonomous sub-agents (keeps ⑤ guards active)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("full");
    await loadSpawnAgent()("t4", { task: "do x" }, null, null, ctx);
    expect(injectedPolicy()).toBe("auto");
  });

  it("floors owner workspace → auto (does not inherit workspace as-is)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("workspace");
    await loadSpawnAgent()("t7", { task: "do x" }, null, null, ctx);
    expect(injectedPolicy()).toBe("auto");
  });

  it("passes ask through unchanged", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    await loadSpawnAgent()("t5", { task: "do x" }, null, null, ctx);
    expect(injectedPolicy()).toBe("ask");
  });

  it("passes auto through unchanged", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    await loadSpawnAgent()("t6", { task: "do x" }, null, null, ctx);
    expect(injectedPolicy()).toBe("auto");
  });
});

// 并行健壮性：一个任务出错（这里用未知 agent 触发 agentLayer 抛错）不应 reject 整个 Promise.all
// 而遗弃其它正在运行的兄弟任务——应就地记为该任务失败、其余照常跑完。
describe("spawn_agent · parallel resilience (one failing task does not abort siblings)", () => {
  it("records the bad-agent task as failed and still completes the others", async () => {
    const r = await loadSpawnAgent()(
      "tp",
      { tasks: ["do A", { task: "do B", agent: "nonexistent" }, "do C"] },
      null,
      null,
      ctx,
    );
    expect(r.details?.mode).toBe("parallel");
    const results = r.details?.results as Array<{ task: string; ok: boolean; error?: string }>;
    expect(results).toHaveLength(3);
    const byTask = Object.fromEntries(results.map((x) => [x.task, x]));
    expect(byTask["do A"].ok).toBe(true);
    expect(byTask["do C"].ok).toBe(true);
    expect(byTask["do B"].ok).toBe(false);
    expect(byTask["do B"].error).toContain("unknown agent");
    expect(r.details?.failed).toBe(1);
  });
});

describe("spawn_agent · inherit parent model", () => {
  it("passes parent ctx.model when spawn omits model", async () => {
    await loadSpawnAgent()("tm", { task: "do x" }, null, null, {
      ...ctx,
      model: { provider: "custom-mtwuh2s5", id: "deepseek-flash" },
    });
    expect(vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.model).toBe("custom-mtwuh2s5/deepseek-flash");
  });

  it("explicit model wins over parent", async () => {
    enable('["openai/gpt-4o"]');
    await loadSpawnAgent()("tm2", { task: "do x", model: "openai/gpt-4o" }, null, null, {
      ...ctx,
      model: { provider: "custom-mtwuh2s5", id: "deepseek-flash" },
      modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false }] },
    });
    expect(vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.model).toBe("openai/gpt-4o");
  });
});

describe("spawn_agent · embedded session child", () => {
  it("returns details.sessionPath when embedded runner is used", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const r = await loadSpawnAgent()("te", { task: "do x" }, null, null, ctx);
    expect(runEmbeddedSubagent).toHaveBeenCalled();
    expect(spawnPiAgent).not.toHaveBeenCalled();
    expect(r.details?.sessionPath).toBe("/tmp/child.jsonl");
    expect(r.details?.stopReason).toBe("completed");
    expect(r.details?.agentId).toBe("sa_test");
    expect(r.content[0]?.text).toBe("embedded-out");
  });

  it("falls back to subprocess when embedded is disabled", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    await loadSpawnAgent()("te2", { task: "do x" }, null, null, ctx);
    expect(spawnPiAgent).toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("gives each parallel unit its own sessionPath", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) => ({
      ok: true,
      output: `out-${opts.task}`,
      exitCode: 0,
      transcript: "",
      sessionPath: `/tmp/${opts.task}.jsonl`,
      stopReason: "completed" as const,
    }));
    const r = await loadSpawnAgent()("tp2", { tasks: ["A", "B"] }, null, null, ctx);
    const results = r.details?.results as Array<{ sessionPath?: string; task: string }>;
    expect(results.map((x) => x.sessionPath)).toEqual(["/tmp/A.jsonl", "/tmp/B.jsonl"]);
  });

  it("embedded spawn returns continuable details immediately", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const r = await loadSpawnAgent()("ts", { task: "do x", action: "spawn" }, null, null, ctx);
    expect(startContinuableEmbedded).toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
    expect(spawnPiAgent).not.toHaveBeenCalled();
    expect(r.content[0]?.text.startsWith("Background sub-agent started")).toBe(true);
    expect(r.details).toMatchObject({
      agentId: "sa_test",
      sessionPath: "/tmp/child.jsonl",
      mode: "continuable",
      status: "running",
    });
  });

  it("run does not installActivation or sendSettlementToParent", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const install = vi.spyOn(activation, "installActivation");
    const send = vi.spyOn(parentHost, "sendSettlementToParent");
    const r = await loadSpawnAgent()("tr", { task: "do x", action: "run" }, null, null, ctx);
    expect(runEmbeddedSubagent).toHaveBeenCalled();
    expect(startContinuableEmbedded).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(r.content[0]?.text).toBe("embedded-out");
    install.mockRestore();
    send.mockRestore();
  });
});

// 单会话最大子代理数：本次请求数 + 会话已累计超过上限时，整次 spawn 在实际启动前被拒。
describe("spawn_agent · 单会话上限 (SUBAGENT_MAX_PER_SESSION)", () => {
  it("超过上限时拒绝新 spawn 并提示去设置调整", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "2" : undefined));
    // 独立 cwd → 独立 sessionKey，避免与其它测试的模块级累计计数相互污染。
    const capCtx = { cwd: process.platform === "win32" ? "D:\\caplimit" : "/caplimit" };
    await expect(loadSpawnAgent()("tc", { tasks: ["a", "b", "c"] }, null, null, capCtx)).rejects.toThrow(
      "已达单会话子代理上限",
    );
  });
});

describe("spawn_agent · parent catalog write", () => {
  it("embedded run success writes one-shot catalog fact", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const emit = vi.spyOn(catalogEvents, "emitCatalogChanged");
    const { execute, appendEntry } = loadSpawnHarness();
    const parentCtx = { ...ctx, sessionManager: { getSessionFile: () => "/ws/parent.jsonl" } };
    await execute("te-cat", { task: "do x" }, null, null, parentCtx);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(
      "subagent_catalog",
      expect.objectContaining({
        version: 0,
        mode: "one-shot",
        sessionPath: "/tmp/child.jsonl",
      }),
    );
    expect(emit).toHaveBeenCalledWith({ sessionPath: "/ws/parent.jsonl" });
  });

  it("embedded spawn success writes continuable catalog fact", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("ts-cat", { task: "do x", action: "spawn" }, null, null, ctx);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(
      "subagent_catalog",
      expect.objectContaining({
        version: 0,
        mode: "continuable",
        sessionPath: "/tmp/child.jsonl",
      }),
    );
  });

  it("does not write catalog when startContinuableEmbedded throws", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.mocked(startContinuableEmbedded).mockRejectedValue(new Error("spawn failed"));
    const { execute, appendEntry } = loadSpawnHarness();
    await expect(execute("ts-fail", { task: "do x", action: "spawn" }, null, null, ctx)).rejects.toThrow("spawn failed");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("rolls back activation when spawn catalog write throws", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const { execute, appendEntry } = loadSpawnHarness();
    appendEntry.mockImplementation(() => {
      throw new Error("catalog disk full");
    });
    const dispose = vi.spyOn(activation, "disposeActivation");
    await expect(execute("ts-rollback", { task: "do x", action: "spawn" }, null, null, ctx)).rejects.toThrow(
      "catalog disk full",
    );
    expect(dispose).toHaveBeenCalledWith("sa_test", "rollback");
    dispose.mockRestore();
  });

  it("subprocess fallback does not write catalog", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("te-sub", { task: "do x" }, null, null, ctx);
    expect(spawnPiAgent).toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("writes catalog for each successful parallel unit", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) => ({
      ok: opts.task !== "B",
      output: opts.task === "B" ? "" : `out-${opts.task}`,
      exitCode: opts.task === "B" ? 1 : 0,
      error: opts.task === "B" ? "boom" : undefined,
      transcript: "",
      sessionPath: opts.task === "B" ? undefined : `/tmp/${opts.task}.jsonl`,
      stopReason: opts.task === "B" ? ("error" as const) : ("completed" as const),
    }));
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("tp-cat", { tasks: ["A", "B", "C"] }, null, null, ctx);
    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry.mock.calls.map((c) => (c[1] as { sessionPath: string }).sessionPath).sort()).toEqual([
      "/tmp/A.jsonl",
      "/tmp/C.jsonl",
    ]);
  });

  it("writes catalog for each successful chain step", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    let n = 0;
    vi.mocked(runEmbeddedSubagent).mockImplementation(async () => {
      n += 1;
      return {
        ok: true,
        output: `step-${n}`,
        exitCode: 0,
        transcript: "",
        sessionPath: `/tmp/step-${n}.jsonl`,
        stopReason: "completed" as const,
      };
    });
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("tc-cat", { chain: [{ task: "first" }, { task: "second {previous}" }] }, null, null, ctx);
    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry.mock.calls.map((c) => (c[1] as { sessionPath: string }).sessionPath)).toEqual([
      "/tmp/step-1.jsonl",
      "/tmp/step-2.jsonl",
    ]);
  });

  it("does not write catalog when embedded run fails", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.mocked(runEmbeddedSubagent).mockResolvedValue({
      ok: false,
      output: "",
      exitCode: 1,
      error: "boom",
      transcript: "",
      sessionPath: "/tmp/child.jsonl",
      stopReason: "error",
    });
    const { execute, appendEntry } = loadSpawnHarness();
    await expect(execute("te-fail", { task: "do x" }, null, null, ctx)).rejects.toThrow("sub-agent failed");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("does not write catalog when embedded run has no sessionPath", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.mocked(runEmbeddedSubagent).mockResolvedValue({
      ok: true,
      output: "embedded-out",
      exitCode: 0,
      transcript: "",
      stopReason: "completed",
    });
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("te-nopath", { task: "do x" }, null, null, ctx);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("swallows one-shot catalog write failure and still returns the tool result", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const { execute, appendEntry } = loadSpawnHarness();
    appendEntry.mockImplementation(() => {
      throw new Error("catalog disk full");
    });
    const r = await execute("te-soft", { task: "do x" }, null, null, ctx);
    expect(r.content[0]?.text).toBe("embedded-out");
    expect(r.details?.sessionPath).toBe("/tmp/child.jsonl");
  });
});

const forkDirs: string[] = [];

afterEach(() => {
  for (const d of forkDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* session file handle may linger on Windows */
    }
  }
});

function persistSession(sm: SessionManager): string {
  const path = sm.getSessionFile();
  if (!path) throw new Error("session file was not created");
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function persistSessionTo(sm: SessionManager, path: string): void {
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function seedCopiedCatalog(label: string): { oldPath: string; newPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  forkDirs.push(dir);
  const sm = SessionManager.create("/ws", dir);
  sm.appendCustomEntry("subagent_catalog", {
    version: 0,
    childId: "sa-old",
    sessionPath: "/c/sa-old.jsonl",
    childCreatedAt: 100,
    mode: "one-shot",
    label: "old",
  });
  const oldPath = persistSession(sm);
  const newPath = join(dir, "forked.jsonl");
  copyFileSync(oldPath, newPath);
  return { oldPath, newPath, dir };
}

describe("multi-agent · user-fork catalog base", () => {
  it("writes subagent_catalog_base on a new factory session_start with reason fork", () => {
    const { oldPath, newPath } = seedCopiedCatalog("cat-fork");
    expect(foldCatalog(newPath).entries.map((e) => e.id)).toEqual(["sa-old"]);

    const smNew = SessionManager.open(newPath);
    const emit = vi.spyOn(catalogEvents, "emitCatalogChanged");
    const { appendEntry, handlers } = loadSpawnHarness();
    appendEntry.mockImplementation((customType: string, data: unknown) => {
      smNew.appendCustomEntry(customType, data);
    });
    const cwd = process.platform === "win32" ? "D:\\fork-cat" : "/fork-cat";
    handlers.session_start?.(
      { type: "session_start", reason: "fork", previousSessionFile: oldPath },
      { cwd, sessionManager: { getSessionFile: () => newPath } },
    );

    expect(appendEntry).toHaveBeenCalledWith("subagent_catalog_base", { version: 0, reason: "user-fork" });
    expect(emit).toHaveBeenCalledWith({ sessionPath: newPath });
    persistSessionTo(smNew, newPath);
    expect(foldCatalog(newPath).entries).toEqual([]);
  });

  it("writes base when fork catalog read fails", () => {
    const emit = vi.spyOn(catalogEvents, "emitCatalogChanged");
    const { appendEntry, handlers } = loadSpawnHarness();
    const cwd = process.platform === "win32" ? "D:\\fork-unreadable" : "/fork-unreadable";
    handlers.session_start?.(
      { type: "session_start", reason: "fork", previousSessionFile: "/old.jsonl" },
      {
        cwd,
        sessionManager: {
          getSessionFile: () => "/ws/broken.jsonl",
          buildContextEntries: () => {
            throw new Error("unreadable");
          },
        },
      },
    );

    expect(appendEntry).toHaveBeenCalledWith("subagent_catalog_base", { version: 0, reason: "user-fork" });
    expect(emit).toHaveBeenCalledWith({ sessionPath: "/ws/broken.jsonl" });
  });

  it("does not write base on resume even when the new file has catalog facts", () => {
    const { oldPath, newPath } = seedCopiedCatalog("cat-resume");
    expect(foldCatalog(newPath).entries.map((e) => e.id)).toEqual(["sa-old"]);

    const { appendEntry, handlers } = loadSpawnHarness();
    const cwd = process.platform === "win32" ? "D:\\fork-resume" : "/fork-resume";
    handlers.session_start?.(
      { type: "session_start", reason: "resume", previousSessionFile: oldPath },
      { cwd, sessionManager: { getSessionFile: () => newPath } },
    );

    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("does not write base when reason is fork but the new file has no catalog facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-fork-empty-"));
    forkDirs.push(dir);
    const sm = SessionManager.create("/ws", dir);
    sm.appendCustomEntry("anchor", {});
    const oldPath = persistSession(sm);
    const newPath = join(dir, "forked.jsonl");
    copyFileSync(oldPath, newPath);
    expect(foldCatalog(newPath).entries).toEqual([]);

    const { appendEntry, handlers } = loadSpawnHarness();
    const cwd = process.platform === "win32" ? "D:\\fork-empty" : "/fork-empty";
    handlers.session_start?.(
      { type: "session_start", reason: "fork", previousSessionFile: oldPath },
      { cwd, sessionManager: { getSessionFile: () => newPath } },
    );

    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("spawn_agent fork", () => {
  it("rejects tasks", async () => {
    await expect(loadSpawnAgent()("tf", { tasks: ["a", "b"], fork: true }, null, null, ctx)).rejects.toThrow(
      "fork 仅支持单任务",
    );
    expect(spawnPiAgent).not.toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("rejects worktree / non-embedded", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    await expect(
      loadSpawnAgent()("tf", { task: "x", fork: true, profile: { isolation: "worktree" } }, null, null, ctx),
    ).rejects.toThrow("fork 需要 Electron 进程内子会话");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("rejects when called from a subagent origin", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await expect(
      runInWorkspace({ origin: "subagent", workspace: ctx.cwd, cwd: ctx.cwd, config: {} }, () =>
        loadSpawnAgent()("tf", { task: "x", fork: true }, null, null, ctx),
      ),
    ).rejects.toThrow("fork 需要 Electron 进程内子会话");
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("empty prefix succeeds like a normal spawn", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const r = await loadSpawnAgent()(
      "tf",
      { task: "x", fork: true },
      null,
      null,
      { ...ctx, sessionManager: { buildContextEntries: () => [] } },
    );
    expect(r.details).toMatchObject({ forked: true, inheritedEventCount: 0 });
    expect(runEmbeddedSubagent).toHaveBeenCalledWith(expect.objectContaining({ seedMessages: [] }));
  });

  it("spawn with a completed prefix sets inheritedEventCount", async () => {
    const userMsg = { role: "user", content: "hi" };
    const done = { role: "assistant", content: [{ type: "text", text: "done" }] };
    const mine = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-spawn", name: "spawn_agent", arguments: {} }],
    };
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const r = await loadSpawnAgent()(
      "tc-spawn",
      { task: "x", fork: true, action: "spawn" },
      null,
      null,
      {
        ...ctx,
        sessionManager: {
          getSessionFile: () => "/tmp/parent.jsonl",
          getSessionId: () => "parent-1",
          buildContextEntries: () => [
            { type: "message", message: userMsg },
            { type: "message", message: done },
            { type: "message", message: mine },
          ],
        },
      },
    );
    expect(r.details).toMatchObject({ forked: true, inheritedEventCount: 2 });
    expect(startContinuableEmbedded).toHaveBeenCalledWith(
      expect.objectContaining({ seedMessages: [userMsg, done] }),
    );
  });

  it("fails the tool when parent context cannot be read", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await expect(
      loadSpawnAgent()(
        "tf",
        { task: "x", fork: true },
        null,
        null,
        {
          ...ctx,
          sessionManager: {
            buildContextEntries: () => {
              throw new Error("entries boom");
            },
          },
        },
      ),
    ).rejects.toThrow("entries boom");
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });
});

describe("spawn_agent · delegation scope statement", () => {
  const STATEMENT = "你是被委派的子代理：权限范围在启动时已固定";

  it("subprocess path: systemPrompt ends with the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    await loadSpawnAgent()("t-ds1", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
    expect(sp.startsWith("你是被委派的子代理")).toBe(true);
  });

  it("embedded path: systemPrompt ends with the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await loadSpawnAgent()("t-ds2", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
  });

  it("continuable spawn also carries the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await loadSpawnAgent()("t-ds4", { task: "do x", action: "spawn" }, null, null, ctx);
    const sp = vi.mocked(startContinuableEmbedded).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
  });
});

describe("spawn_agent · model selection policy", () => {
  it("disabled: schema has no model fields and no list tool", () => {
    const h = loadSpawnHarness();
    expect(h.schema).not.toHaveProperty("model");
    expect(h.schema).not.toHaveProperty("thinking_level");
    expect(h.toolNames).not.toContain("list_subagent_models");
  });

  it("disabled: explicit model is rejected before spawning", async () => {
    const h = loadSpawnHarness();
    const r = await h.execute("t", { task: "x", model: "a/b" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("子代理路由选择未开启");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("disabled: tasks[].model / chain[].model / profile.model are rejected too", async () => {
    const h = loadSpawnHarness();
    for (const params of [
      { tasks: [{ task: "x", model: "a/b" }] },
      { chain: [{ task: "x", model: "a/b" }] },
      { task: "x", profile: { model: "a/b" } },
      { task: "x", thinking_level: "high" },
    ]) {
      const r = await h.execute("t", params, null, null, ctxM);
      expect(r.isError).toBe(true);
    }
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("disabled: SUBAGENT_MODEL default still applies (user config, not model choice)", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL" ? "x/y" : undefined));
    await loadSpawnAgent()("t", { task: "x" }, null, null, ctxM);
    expect(vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.model).toBe("x/y");
  });

  it("enabled: schema exposes model + thinking_level and registers the list tool", () => {
    enable();
    const h = loadSpawnHarness();
    expect(h.schema).toHaveProperty("model");
    expect(h.schema).toHaveProperty("thinking_level");
    expect(h.toolNames).toContain("list_subagent_models");
  });

  it("enabled: allowlisted available route spawns; thinking_level is forwarded", async () => {
    enable();
    await loadSpawnAgent()("t", { task: "x", model: "a/b", thinking_level: "high" }, null, null, ctxM);
    const opts = vi.mocked(spawnPiAgent).mock.calls[0]?.[2];
    expect(opts?.model).toBe("a/b");
    expect(opts?.thinkingLevel).toBe("high");
  });

  it("enabled: route outside allowlist is rejected", async () => {
    enable('["a/b"]');
    const r = await loadSpawnAgent()("t", { task: "x", model: "a/c" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("不在授权白名单");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("enabled: thinking_level on a non-reasoning model is rejected", async () => {
    enable();
    const r = await loadSpawnAgent()("t", { task: "x", model: "a/c", thinking_level: "medium" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("不支持思考档");
  });

  it("enabled: one bad task in tasks[] aborts the whole batch", async () => {
    enable('["a/b"]');
    const r = await loadSpawnAgent()("t", { tasks: [{ task: "ok", model: "a/b" }, { task: "bad", model: "a/c" }] }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });
});

