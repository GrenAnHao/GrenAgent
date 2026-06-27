import { beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 的 spawn_agent execute() 此前无单测。这里用最小 mock 隔离 fs / 子进程 / sqlite，
// 覆盖两条会改运行时行为的逻辑：D（sandbox 不可用→结果标 isolationDowngraded）与
// B（owner=full 时给自主子代理注入 APPROVAL_POLICY=auto，能力硬限不变）。
vi.mock("./workflows.js", () => ({ registerWorkflows: () => {} }));
vi.mock("./cancel.js", () => ({ installCancelWatcher: () => {}, cancelSubAgent: () => {} }));
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
  }
  return { SubAgentRegistry };
});
vi.mock("./runner.js", () => ({
  spawnPiAgent: vi.fn(async () => ({ ok: true, output: "done", exitCode: 0, transcript: "" })),
}));
vi.mock("../_shared/sandbox-gate.js", () => ({ sandboxAvailable: vi.fn(async () => false) }));
vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: vi.fn(() => "auto") }));
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(() => undefined) }));

import { getApprovalPolicy } from "../_shared/approval.js";
import { sandboxAvailable } from "../_shared/sandbox-gate.js";
import multiAgent from "./index.js";
import { spawnPiAgent } from "./runner.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;

function loadSpawnAgent(): Execute {
  let exec: Execute | undefined;
  const pi = {
    registerTool: (t: { name: string; execute: Execute }) => {
      if (t.name === "spawn_agent") exec = t.execute;
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  return exec!;
}

const ctx = { cwd: process.platform === "win32" ? "D:\\proj" : "/proj" };

beforeEach(() => {
  vi.clearAllMocks();
  // Hermetic: a stray PI_IS_SUBAGENT in the ambient env would trip the recursion guard.
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.SAFETY_READONLY;
  vi.mocked(sandboxAvailable).mockResolvedValue(false);
  vi.mocked(getApprovalPolicy).mockReturnValue("auto");
});

describe("spawn_agent · sandbox downgrade visibility (D)", () => {
  it("marks isolationDowngraded when sandbox requested but unavailable", async () => {
    vi.mocked(sandboxAvailable).mockResolvedValue(false);
    const r = await loadSpawnAgent()("t1", { task: "do x", profile: { isolation: "sandbox" } }, null, null, ctx);
    expect(r.details?.isolationDowngraded).toBe(true);
    expect(r.content[0].text).toContain("回退到进程隔离");
  });

  it("does NOT mark downgrade when sandbox is available", async () => {
    vi.mocked(sandboxAvailable).mockResolvedValue(true);
    const r = await loadSpawnAgent()("t2", { task: "do x", profile: { isolation: "sandbox" } }, null, null, ctx);
    expect(r.details?.isolationDowngraded).toBeUndefined();
    expect(r.content[0].text).not.toContain("回退到进程隔离");
  });

  it("does NOT mark downgrade for a non-sandbox profile", async () => {
    const r = await loadSpawnAgent()("t3", { task: "do x" }, null, null, ctx);
    expect(r.details?.isolationDowngraded).toBeUndefined();
  });
});

describe("spawn_agent · approval policy injected into sub-agent (B)", () => {
  const injectedPolicy = () => (vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.env as Record<string, string>).APPROVAL_POLICY;

  it("floors owner full → auto for autonomous sub-agents (keeps ⑤ guards active)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("full");
    await loadSpawnAgent()("t4", { task: "do x" }, null, null, ctx);
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
