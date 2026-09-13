import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));
vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: vi.fn(() => "auto") }));
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(() => undefined) }));

import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import { __resetSubagentControlPlaneForTest } from "./controlPlane.js";
import multiAgent from "./index.js";
import { spawnPiAgent } from "./runner.js";
import { canUseEmbeddedSubagent, runEmbeddedSubagent } from "./embedded-runner.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: { cwd: string; model?: { provider?: string; id?: string } },
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;

function loadSpawnAgent(): Execute {
  let exec: Execute | undefined;
  const pi = {
    registerTool: (t: { name: string; execute: Execute }) => {
      if (t.name === "spawn_agent") exec = t.execute;
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    on: () => {},
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  return exec!;
}

const ctx = { cwd: process.platform === "win32" ? "D:\\proj" : "/proj" };

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
    await loadSpawnAgent()("tm2", { task: "do x", model: "openai/gpt-4o" }, null, null, {
      ...ctx,
      model: { provider: "custom-mtwuh2s5", id: "deepseek-flash" },
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
