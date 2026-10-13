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
vi.mock("./agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agents.js")>();
  return {
    ...actual,
    discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
  };
});
const registryRows = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    reset() {
      rows.clear();
    },
  };
});
const jobsMock = vi.hoisted(() => {
  const start = vi.fn((req: { run: () => { done: Promise<unknown> } }) => {
    req.run();
    return "subagent-1";
  });
  return {
    start,
    read: vi.fn(async () => ({ status: "completed", text: "job-out" })),
    kill: vi.fn(() => "requested"),
    snapshot: vi.fn(() => ({ status: "running" })),
    hasLive: vi.fn(() => false),
    onJobDone: vi.fn(() => () => {}),
  };
});
vi.mock("../jobs/service.js", () => ({
  jobs: jobsMock,
}));
vi.mock("./registry.js", () => {
  class SubAgentRegistry {
    static genId() {
      return "sa_test";
    }
    load() {}
    reapOrphans() {}
    create(input: Record<string, unknown> = {}) {
      const id = String(input.id ?? "sa_test");
      const row = { id, task: input.task ?? "", status: "running", jobId: input.jobId ?? null, ...input };
      registryRows.rows.set(id, row);
      return row;
    }
    finish(id: string, patch: Record<string, unknown>) {
      registryRows.rows.set(id, { ...(registryRows.rows.get(id) ?? { id }), ...patch });
    }
    touch() {}
    progress() {}
    setSessionPath() {}
    setJobId(id: string, jobId: string) {
      const prev = registryRows.rows.get(id) ?? { id };
      registryRows.rows.set(id, { ...prev, jobId });
    }
    remove() {}
    get(id?: string) {
      return id ? (registryRows.rows.get(id) ?? null) : null;
    }
    list() {
      return [...registryRows.rows.values()];
    }
    findStuck() {
      return [];
    }
    close() {}
  }
  return { SubAgentRegistry };
});
vi.mock("./worker-session.js", () => ({ openWorkerChildSession: vi.fn(), resumeWorkerChildSession: vi.fn() }));
vi.mock("./embedded-runner.js", () => ({
  openEmbeddedChildSession: vi.fn(),
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
import { jobs } from "../jobs/service.js";
import { __resetSubagentControlPlaneForTest } from "./controlPlane.js";
import multiAgent from "./index.js";
import { runEmbeddedSubagent, startContinuableEmbedded } from "./embedded-runner.js";
import { openWorkerChildSession } from "./worker-session.js";
import { runInWorkspace } from "../_shared/workspace-context.js";
import * as activation from "./activation.js";
import * as parentHost from "./parent-host.js";
import { formatSettlementNotice } from "./settlement-notice.js";
import { __resetChildRunsForTest } from "./child-runs.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate:
    | ((update: { content?: unknown; details?: Record<string, unknown> }) => void)
    | null,
  ctx: { cwd: string; model?: { provider?: string; id?: string } },
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean }>;

type SessionHandler = (event: unknown, ctx: unknown) => unknown;

function loadSpawnHarness(): {
  execute: Execute;
  appendEntry: ReturnType<typeof vi.fn>;
  handlers: Record<string, SessionHandler>;
  schema: Record<string, unknown>;
  toolNames: string[];
  sendMessage: ReturnType<typeof vi.fn>;
  tools: Record<string, Execute>;
} {
  let exec: Execute | undefined;
  let schema: Record<string, unknown> = {};
  const toolNames: string[] = [];
  const tools: Record<string, Execute> = {};
  const appendEntry = vi.fn();
  const sendMessage = vi.fn(async () => {});
  const handlers: Record<string, SessionHandler> = {};
  const pi = {
    registerTool: (t: { name: string; execute: Execute; parameters?: { properties?: Record<string, unknown> } }) => {
      toolNames.push(t.name);
      tools[t.name] = t.execute;
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
    sendMessage,
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  return { execute: exec!, appendEntry, handlers, schema, toolNames, sendMessage, tools };
}

function loadSpawnAgent(): Execute {
  return loadSpawnHarness().execute;
}

const ctx = { cwd: process.platform === "win32" ? "D:\\proj" : "/proj" };

/** 设置 SUBAGENT_BACKEND=worker：两个后端跑同一个 runner，区别只在 runEmbeddedSubagent 的第二个参数（开会话方式）。 */
function useWorkerBackend(): void {
  const prev = vi.mocked(getConfig).getMockImplementation();
  vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_BACKEND" ? "worker" : prev?.(k)));
}

const AVAIL = [{ provider: "a", id: "b", name: "b", reasoning: true }, { provider: "a", id: "c", name: "c", reasoning: false }];
const ctxM = { ...ctx, modelRegistry: { getAvailable: () => AVAIL } };
const enable = (list = '["a/b","a/c"]') =>
  vi.mocked(getConfig).mockImplementation((k: string) =>
    k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL_SELECTION" ? "1" : k === "SUBAGENT_MODEL_ALLOWLIST" ? list : undefined,
  );

beforeEach(() => {
  __resetSubagentControlPlaneForTest();
  __resetChildRunsForTest();
  registryRows.reset();
  vi.clearAllMocks();
  // Hermetic: a stray PI_IS_SUBAGENT in the ambient env would trip the recursion guard.
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.SAFETY_READONLY;
  vi.mocked(getApprovalPolicy).mockReturnValue("auto");
  // 默认不限单会话上限，避免无关的 spawn 行为测试因模块级累计计数被拦；上限专测在下方单独设值。
  vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : undefined));
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
  const injectedPolicy = () => (vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.env as Record<string, string>).APPROVAL_POLICY;

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

describe("spawn_agent · named agent infers capability profile", () => {
  const storedProfile = () => JSON.parse(String(registryRows.rows.get("sa_test")?.profile ?? "null"));
  const injectedEnv = () => vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.env as Record<string, string>;

  it("unnamed spawn persists default writable profile", async () => {
    await loadSpawnAgent()("t", { task: "do x" }, null, null, ctx);
    expect(storedProfile().fs).toBe("workspace");
    expect(storedProfile().name).toBe("default");
    expect(injectedEnv().SAFETY_READONLY).toBeUndefined();
  });

  it("agent ask/scout without profile is readonly explore", async () => {
    await loadSpawnAgent()("t", { task: "recon", agent: "ask" }, null, null, ctx);
    expect(storedProfile().fs).toBe("readonly");
    expect(storedProfile().name).toBe("explore");
    expect(injectedEnv().SAFETY_READONLY).toBe("1");
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.tools).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls"]),
    );
  });

  it("explicit profile wins over named-agent inference", async () => {
    await loadSpawnAgent()("t", { task: "recon", agent: "ask", profile: "default" }, null, null, ctx);
    expect(storedProfile().fs).toBe("workspace");
    expect(injectedEnv().SAFETY_READONLY).toBeUndefined();
  });
});

// codemode 脚本到 timeout_ms 会取消脚本里在跑的子代理。
describe("codemode deadline around spawn_agent", () => {
  it("drops timeout_ms from a codemode script that spawns sub-agents", async () => {
    const { handlers } = loadSpawnHarness();
    const event = {
      toolName: "codemode",
      input: { code: '// @options: {"max_output_tokens": 3000, "timeout_ms": 900000}\nawait tools.spawn_agent({ task: "x" });' },
    };
    await handlers.tool_call?.(event as never, ctx as never);
    expect(event.input.code).toBe('// @options: {"max_output_tokens":3000}\nawait tools.spawn_agent({ task: "x" });');
  });

  it("leaves other tools and scripts without spawn_agent alone", async () => {
    const { handlers } = loadSpawnHarness();
    const plain = { toolName: "codemode", input: { code: '// @options: {"timeout_ms": 60000}\nawait tools.read({ path: "a" });' } };
    await handlers.tool_call?.(plain as never, ctx as never);
    expect(plain.input.code).toContain('"timeout_ms": 60000');
    const bash = { toolName: "bash", input: { command: "echo spawn_agent" } };
    await handlers.tool_call?.(bash as never, ctx as never);
    expect(bash.input.command).toBe("echo spawn_agent");
  });
});

// 并行健壮性：一个任务出错（这里用未知 agent 触发 agentLayer 抛错）不应 reject 整个 Promise.all
// 而遗弃其它正在运行的兄弟任务——应就地记为该任务失败、其余照常跑完。
describe("spawn_agent · early parallel start", () => {
  it("starts a closed task from the argument stream before execute", async () => {
    const { handlers, execute } = loadSpawnHarness();
    await handlers.message_update?.(
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, id: "call_p", toolName: "spawn_agent" },
      } as never,
      ctx as never,
    );
    await handlers.message_update?.(
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 3, delta: '{"tasks":["review server"],' },
      } as never,
      ctx as never,
    );
    expect(runEmbeddedSubagent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.task).toBe("review server");
    await execute("call_p", { tasks: ["review server", "review desktop"] }, null, null, ctx);
    expect(runEmbeddedSubagent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runEmbeddedSubagent).mock.calls.map((c) => c[0]?.task).sort()).toEqual([
      "review desktop",
      "review server",
    ]);
  });

  it("registers an early-started task in inflight until it ends, so cancel and stuck reaping reach it", async () => {
    const { inflight } = await import("./controlPlane.js");
    const { __resetEarlySpawnForTest } = await import("./parallel-early.js");
    let finish!: (r: Awaited<ReturnType<typeof runEmbeddedSubagent>>) => void;
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(new Promise((res) => {
      finish = res;
    }));
    const { handlers } = loadSpawnHarness();
    await handlers.message_update?.(
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 5, id: "call_q", toolName: "spawn_agent" } } as never,
      ctx as never,
    );
    await handlers.message_update?.(
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 5, delta: '{"tasks":["review server"],' } } as never,
      ctx as never,
    );
    expect(inflight.has("sa_test")).toBe(true);
    finish({ ok: true, output: "x", exitCode: 0, transcript: "", sessionPath: "/tmp/c.jsonl", stopReason: "completed" });
    await vi.waitFor(() => expect(inflight.has("sa_test")).toBe(false));
    __resetEarlySpawnForTest();
  });
});

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
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.model).toBe("custom-mtwuh2s5/deepseek-flash");
  });

  it("explicit model wins over parent", async () => {
    enable('["openai/gpt-4o"]');
    await loadSpawnAgent()("tm2", { task: "do x", model: "openai/gpt-4o" }, null, null, {
      ...ctx,
      model: { provider: "custom-mtwuh2s5", id: "deepseek-flash" },
      modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false }] },
    });
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.model).toBe("openai/gpt-4o");
  });
});

describe("spawn_agent · embedded session child", () => {
  it("returns details.sessionPath when the in-process backend is used (the default)", async () => {
    const r = await loadSpawnAgent()("te", { task: "do x" }, null, null, ctx);
    expect(runEmbeddedSubagent).toHaveBeenCalled();
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[1]).not.toBe(openWorkerChildSession);
    expect(r.details?.sessionPath).toBe("/tmp/child.jsonl");
    expect(r.details?.stopReason).toBe("completed");
    expect(r.details?.agentId).toBe("sa_test");
    expect(r.content[0]?.text).toBe("embedded-out");
  });

  it("SUBAGENT_BACKEND=worker runs the same runner with the worker opener", async () => {
    useWorkerBackend();
    await loadSpawnAgent()("te2", { task: "do x" }, null, null, ctx);
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[1]).toBe(openWorkerChildSession);
  });

  it("starts every requested parallel task at once instead of holding the rest behind a cap of 4", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    vi.mocked(runEmbeddedSubagent).mockImplementation(async () => {
      started += 1;
      await gate;
      return {
        ok: true,
        output: "x",
        exitCode: 0,
        transcript: "",
        sessionPath: "/tmp/x.jsonl",
        stopReason: "completed" as const,
      };
    });
    const pending = loadSpawnAgent()("tp5", { tasks: ["a", "b", "c", "d", "e"] }, null, null, ctx);
    await vi.waitFor(() => expect(started).toBe(5));
    release();
    const r = await pending;
    expect(r.details?.count).toBe(5);
  });

  it("publishes each parallel unit sessionPath before the batch finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updates: Array<{ details?: { results?: Array<{ task?: string; agentId?: string; sessionPath?: string }> } }> = [];
    vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) => {
      opts.onUpdate?.({ text: "", transcript: "", sessionPath: `/tmp/${opts.task}.jsonl` });
      await gate;
      return {
        ok: true,
        output: `out-${opts.task}`,
        exitCode: 0,
        transcript: "",
        sessionPath: `/tmp/${opts.task}.jsonl`,
        stopReason: "completed" as const,
      };
    });
    const pending = loadSpawnAgent()(
      "tp-live",
      { tasks: ["A", "B"] },
      null,
      (update) => {
        updates.push(update as (typeof updates)[number]);
      },
      ctx,
    );
    await vi.waitFor(() => {
      const paths = updates.at(-1)?.details?.results?.map((row) => row.sessionPath);
      expect(paths).toEqual(["/tmp/A.jsonl", "/tmp/B.jsonl"]);
    });
    release();
    await pending;
  });

  it("gives each parallel unit its own sessionPath", async () => {
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
    const r = await loadSpawnAgent()("ts", { task: "do x", action: "spawn" }, null, null, ctx);
    expect(startContinuableEmbedded).toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
    expect(r.content[0]?.text.startsWith("Background sub-agent started")).toBe(true);
    expect(r.details).toMatchObject({
      agentId: "sa_test",
      sessionPath: "/tmp/child.jsonl",
      mode: "continuable",
      status: "running",
    });
  });

  it("run does not installActivation or sendSettlementToParent", async () => {
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
  it("一次性任务结束后释放名额，下一次可以再启动", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "1" : undefined));
    const capCtx = { cwd: process.platform === "win32" ? "D:\\caprelease" : "/caprelease" };
    await loadSpawnAgent()("t1", { task: "a" }, null, null, capCtx);
    await expect(loadSpawnAgent()("t2", { task: "b" }, null, null, capCtx)).resolves.toMatchObject({
      details: expect.objectContaining({ agentId: "sa_test" }),
    });
  });

  it("可继续的子代理在收尾前仍占着名额", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "1" : undefined));
    const capCtx = { cwd: process.platform === "win32" ? "D:\\capkeep" : "/capkeep" };
    await loadSpawnAgent()("t1", { task: "a", action: "spawn" }, null, null, capCtx);
    await expect(loadSpawnAgent()("t2", { task: "b" }, null, null, capCtx)).rejects.toThrow("已达单会话子代理上限");
  });

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
    vi.mocked(startContinuableEmbedded).mockRejectedValue(new Error("spawn failed"));
    const { execute, appendEntry } = loadSpawnHarness();
    await expect(execute("ts-fail", { task: "do x", action: "spawn" }, null, null, ctx)).rejects.toThrow("spawn failed");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("rolls back activation when spawn catalog write throws", async () => {
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

  it("the worker backend writes the same one-shot catalog fact (it is a real session too)", async () => {
    useWorkerBackend();
    const { execute, appendEntry } = loadSpawnHarness();
    await execute("te-sub", { task: "do x" }, null, null, ctx);
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[1]).toBe(openWorkerChildSession);
    expect(appendEntry).toHaveBeenCalledWith("subagent_catalog", expect.objectContaining({ mode: "one-shot" }));
  });

  it("writes catalog for each successful parallel unit", async () => {
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

  it("publishes each chain step model up front and keeps it after the step finishes", async () => {
    vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) => {
      opts.onUpdate?.({ text: "", transcript: "", sessionPath: `/tmp/${opts.task}.jsonl` });
      return {
        ok: true,
        output: `out-${opts.task}`,
        exitCode: 0,
        transcript: "",
        sessionPath: `/tmp/${opts.task}.jsonl`,
        stopReason: "completed" as const,
      };
    });
    const updates: Array<{ results?: Array<{ status?: string; model?: string }> }> = [];
    const { execute } = loadSpawnHarness();
    const r = await execute(
      "tc-model",
      { chain: [{ task: "first" }, { task: "second" }] },
      null,
      (u) => {
        if (u.details) updates.push(u.details as { results?: Array<{ status?: string; model?: string }> });
      },
      { ...ctx, model: { provider: "deepseek", id: "deepseek-v4-flash" } },
    );
    expect(updates[0]?.results?.map((step) => step.status)).toEqual(["starting", "waiting"]);
    expect(updates[0]?.results?.map((step) => step.model)).toEqual([
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(updates.some((u) => u.results?.map((step) => step.status).join() === "done,waiting")).toBe(true);
    const results = (r.details?.results ?? []) as Array<{ model?: string }>;
    expect(results.map((step) => step.model)).toEqual([
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("does not write catalog when embedded run fails", async () => {
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
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("fork works on the worker backend too", async () => {
    useWorkerBackend();
    const r = await loadSpawnAgent()("tf", { task: "x", fork: true }, null, null, {
      ...ctx,
      sessionManager: { buildContextEntries: () => [] },
    } as never);
    expect(r.isError).toBeFalsy();
    expect(runEmbeddedSubagent).toHaveBeenCalledWith(expect.objectContaining({ seedMessages: [] }), openWorkerChildSession);
  });

  it("allows fork when called from a subagent origin", async () => {
    const r = await runInWorkspace({ origin: "subagent", workspace: ctx.cwd, cwd: ctx.cwd, config: {} }, () =>
      loadSpawnAgent()("tf", { task: "x", fork: true }, null, null, { ...ctx, sessionManager: { buildContextEntries: () => [] } }),
    );
    expect(r.isError).toBeFalsy();
    expect(runEmbeddedSubagent).toHaveBeenCalled();
  });

  it("empty prefix succeeds like a normal spawn", async () => {
    const r = await loadSpawnAgent()(
      "tf",
      { task: "x", fork: true },
      null,
      null,
      { ...ctx, sessionManager: { buildContextEntries: () => [] } },
    );
    expect(r.details).toMatchObject({ forked: true, inheritedEventCount: 0 });
    expect(runEmbeddedSubagent).toHaveBeenCalledWith(expect.objectContaining({ seedMessages: [] }), expect.anything());
  });

  it("spawn with a completed prefix sets inheritedEventCount", async () => {
    const userMsg = { role: "user", content: "hi" };
    const done = { role: "assistant", content: [{ type: "text", text: "done" }] };
    const mine = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-spawn", name: "spawn_agent", arguments: {} }],
    };
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
      expect.anything(),
    );
  });

  it("fails the tool when parent context cannot be read", async () => {
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
    useWorkerBackend();
    await loadSpawnAgent()("t-ds1", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
    expect(sp.startsWith("你是被委派的子代理")).toBe(true);
  });

  it("embedded path: systemPrompt ends with the statement", async () => {
    await loadSpawnAgent()("t-ds2", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
  });

  it("continuable spawn also carries the statement", async () => {
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
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
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
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("disabled: SUBAGENT_MODEL default still applies (user config, not model choice)", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL" ? "x/y" : undefined));
    await loadSpawnAgent()("t", { task: "x" }, null, null, ctxM);
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.model).toBe("x/y");
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
    const opts = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0];
    expect(opts?.model).toBe("a/b");
    expect(opts?.thinkingLevel).toBe("high");
  });

  it("enabled: route outside allowlist is rejected", async () => {
    enable('["a/b"]');
    const r = await loadSpawnAgent()("t", { task: "x", model: "a/c" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("不在授权白名单");
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
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
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("enabled: allowlist edits reach a session that was already open", async () => {
    enable('["a/b"]');
    const exec = loadSpawnAgent();
    enable('["a/c"]');
    const rejected = await exec("t1", { task: "x", model: "a/b" }, null, null, ctxM);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("不在授权白名单");
    const accepted = await exec("t2", { task: "x", model: "a/c" }, null, null, ctxM);
    expect(accepted.isError).toBeFalsy();
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.model).toBe("a/c");
  });

  describe("cheap / strong aliases as explicit model", () => {
    const enableWith = (extra: Record<string, string>, list = '["a/b"]') =>
      vi.mocked(getConfig).mockImplementation((k: string) =>
        k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL_SELECTION" ? "1" : k === "SUBAGENT_MODEL_ALLOWLIST" ? list : extra[k],
      );

    it("top-level model: cheap resolves to the configured route without being allowlisted", async () => {
      enableWith({ SUBAGENT_MODEL_CHEAP: "deepseek/flash" });
      const r = await loadSpawnAgent()("t", { task: "x", model: "cheap" }, null, null, ctxM);
      expect(r.isError).toBeFalsy();
      expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.model).toBe("deepseek/flash");
    });

    it("tasks[] and chain[] accept the aliases too", async () => {
      enableWith({ SUBAGENT_MODEL_CHEAP: "deepseek/flash", SUBAGENT_MODEL_STRONG: "a/b" });
      const r = await loadSpawnAgent()("t", { tasks: [{ task: "p", model: "cheap" }, { task: "q", model: "strong" }] }, null, null, ctxM);
      expect(r.isError).toBeFalsy();
      const models = vi.mocked(runEmbeddedSubagent).mock.calls.map((c) => c[0]?.model).sort();
      expect(models).toEqual(["a/b", "deepseek/flash"]);
    });

    it("an alias with nothing behind it is rejected before spawning", async () => {
      enableWith({});
      const r = await loadSpawnAgent()("t", { task: "x", model: "strong" }, null, null, ctxM);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("别名 strong 没有对应模型");
      expect(runEmbeddedSubagent).not.toHaveBeenCalled();
    });

    it("thinking_level is checked against the model the alias resolves to", async () => {
      enableWith({ SUBAGENT_MODEL_CHEAP: "a/c", SUBAGENT_MODEL_STRONG: "a/b" });
      const bad = await loadSpawnAgent()("t1", { task: "x", model: "cheap", thinking_level: "medium" }, null, null, ctxM);
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("不支持思考档");
      const good = await loadSpawnAgent()("t2", { task: "x", model: "strong", thinking_level: "high" }, null, null, ctxM);
      expect(good.isError).toBeFalsy();
      expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.thinkingLevel).toBe("high");
    });
  });
});

describe("spawn_agent · nested delegation depth", () => {
  const depthCtx = (depth: number) => ({
    ...ctx,
    sessionManager: {
      getEntries: () => [{ type: "custom", customType: "subagent_meta", data: { origin: "subagent", depth } }],
      getSessionId: () => `sa-parent-${depth}`,
    },
  });
  const cfg = (map: Record<string, string>) =>
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : map[k]));

  it("no longer blocks spawn on PI_IS_SUBAGENT=1", async () => {
    process.env.PI_IS_SUBAGENT = "1";
    cfg({});
    await loadSpawnAgent()("t", { task: "x" }, null, null, ctx);
    expect(runEmbeddedSubagent).toHaveBeenCalled();
    delete process.env.PI_IS_SUBAGENT;
  });

  it("child depth = parent + 1 goes into env and executeSubagent opts", async () => {
    cfg({});
    await loadSpawnAgent()("t", { task: "x" }, null, null, depthCtx(1));
    const opts = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0];
    expect(opts?.env?.SUBAGENT_DEPTH).toBe("2");
    expect(opts?.depth).toBe(2);
  });

  it("rejects when child depth exceeds SUBAGENT_MAX_DEPTH, without reserving a per-session slot", async () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    const r = await loadSpawnAgent()("t", { task: "x" }, null, null, depthCtx(1));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("已达委派深度上限 1");
    expect(runEmbeddedSubagent).not.toHaveBeenCalled();
  });

  it("tasks[] all share the same child depth", async () => {
    cfg({});
    await loadSpawnAgent()("t", { tasks: ["a", "b"] }, null, null, depthCtx(0));
    for (const call of vi.mocked(runEmbeddedSubagent).mock.calls) expect(call[0]?.depth).toBe(1);
  });

  it("fork inside a child is no longer rejected for being a child", async () => {
    cfg({});
    const r = await runInWorkspace(
      { origin: "subagent", workspace: ctx.cwd, cwd: ctx.cwd, config: {} },
      () => loadSpawnAgent()("t", { task: "x", fork: true }, null, null, { ...depthCtx(1), sessionManager: { ...depthCtx(1).sessionManager, buildContextEntries: () => [] } }),
    );
    expect(r.isError).toBeFalsy();
    expect(runEmbeddedSubagent).toHaveBeenCalled();
  });

  it("continuable spawn passes parentActivationId when the caller is a resident activation", async () => {
    cfg({});
    vi.spyOn(activation, "getActivation").mockImplementation((id: string) => (id === "sa-parent-1" ? ({ childId: id, ownedChildren: new Set() } as never) : undefined));
    await loadSpawnAgent()("t", { task: "x", action: "spawn" }, null, null, depthCtx(1));
    const opts = vi.mocked(startContinuableEmbedded).mock.calls[0]?.[0];
    expect(opts?.parentActivationId).toBe("sa-parent-1");
    expect(opts?.depth).toBe(2);
  });
});

describe("spawn_agent · background delivery (subagent-settled, no jobs)", () => {
  const parentCtx = {
    ...ctx,
    sessionManager: { getSessionFile: () => "/sessions/parent.jsonl", getSessionId: () => "parent-1" },
  };

  it("mode omitted → continuable path; no job", async () => {
    await loadSpawnAgent()("t", { task: "x", action: "spawn" }, null, null, ctx);
    expect(startContinuableEmbedded).toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("schema drops mode and the wait action; wait_agent is registered instead", () => {
    const h = loadSpawnHarness();
    expect(h.schema.mode).toBeUndefined();
    expect(JSON.stringify(h.schema.action)).not.toContain('"wait"');
    expect(h.toolNames).toContain("wait_agent");
  });

  it("a worker background spawn is continuable too: returns at once, no job, runs on the worker opener", async () => {
    useWorkerBackend();
    const h = loadSpawnHarness();
    const r = await h.execute("t", { task: "x", action: "spawn" }, null, null, parentCtx);
    expect(r.content[0].text.startsWith("Background sub-agent started. agentId: sa_test")).toBe(true);
    expect(r.content[0].text).toContain("wait_agent");
    expect(r.details).toMatchObject({ agentId: "sa_test", status: "running", mode: "continuable" });
    expect(r.details).not.toHaveProperty("jobId");
    expect(jobs.start).not.toHaveBeenCalled();
    const [opts, open] = vi.mocked(startContinuableEmbedded).mock.calls[0]!;
    expect(opts).toMatchObject({ backend: "worker" });
    expect(open).toBe(openWorkerChildSession);
  });

  it("without a parent host (CLI, worker process) the Activation notice falls back to pi.sendMessage", async () => {
    const h = loadSpawnHarness();
    await h.execute("t", { task: "x", action: "spawn" }, null, null, { ...parentCtx, isIdle: () => false } as never);
    const opts = vi.mocked(startContinuableEmbedded).mock.calls[0]![0] as { deliverFallback?: (n: unknown) => void };
    expect(typeof opts.deliverFallback).toBe("function");
    opts.deliverFallback!(formatSettlementNotice({ childId: "sa_test", stopReason: "completed", output: "OK" }));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, sendOpts] = h.sendMessage.mock.calls[0]!;
    expect(msg).toMatchObject({ customType: "subagent-settled", display: true, details: { childId: "sa_test" } });
    expect(sendOpts).toEqual({ deliverAs: "steer" });
  });

  it("status returns the child output without echoing the task", async () => {
    const task = "你在做任务 6 的代码质量审查。只读审查，不要修改任何文件。\n\n一步（规格审查）的结论：\nSPEC_PASS";
    const h = loadSpawnHarness();
    await h.execute("t", { task }, null, null, ctx);
    const status = await h.execute("s", { action: "status", agentId: "sa_test" }, null, null, ctx);
    expect(status.content[0].text).toBe("agent sa_test: done\n\nembedded-out");
    expect(status.content[0].text).not.toContain(task);
    expect(status.details).toMatchObject({ agentId: "sa_test", task });
  });

  it("list returns child output and leaves the task out of the text", async () => {
    const task = "你在做任务 7 的代码质量审查。只读审查，不要修改任何文件。\n\n前一步（规格审查）的结论：\nSPEC_PASS";
    const h = loadSpawnHarness();
    await h.execute("t", { task }, null, null, ctx);
    const listed = await h.execute("l", { action: "list" }, null, null, ctx);
    expect(listed.content[0].text).toContain("sa_test  [done]");
    expect(listed.content[0].text).toContain("embedded-out");
    expect(listed.content[0].text).not.toContain("SPEC_PASS");
    expect(listed.content[0].text).not.toContain("不要修改任何文件");
    const agents = listed.details?.agents as Array<{ task: string; output: string | null }>;
    expect(agents[0]?.task).toBe(task);
    expect(agents[0]?.output).toBe("embedded-out");
  });

  it("parallel result text does not repeat each task", async () => {
    const task = "你在做任务 6 的代码质量审查。只读审查，不要修改任何文件。";
    const r = await loadSpawnAgent()("tp-echo", { tasks: [task, "第二项"] }, null, null, ctx);
    expect(r.content[0].text).not.toContain(task);
    expect(r.content[0].text).not.toContain("Task:");
    expect(r.content[0].text).toContain("## Sub-agent 1");
    expect(r.content[0].text).toContain("embedded-out");
    const results = r.details?.results as Array<{ task: string }>;
    expect(results[0]?.task).toBe(task);
  });

  it("background spawn with several tasks is rejected", async () => {
    await expect(
      loadSpawnAgent()("t", { tasks: ["a", "b"], action: "spawn" }, null, null, ctx),
    ).rejects.toThrow(/仅支持单任务/);
  });
});


describe("spawn_agent · a foreground run moves to the background when the user speaks", () => {
  type RunResult = Awaited<ReturnType<typeof runEmbeddedSubagent>>;
  const done = (output: string, sessionPath = "/tmp/child.jsonl"): RunResult => ({
    ok: true,
    output,
    exitCode: 0,
    transcript: "",
    sessionPath,
    stopReason: "completed",
  });
  function deferredRun() {
    let resolve!: (r: RunResult) => void;
    const promise = new Promise<RunResult>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  const talkingCtx = (talking: () => boolean) => ({
    ...ctx,
    sessionManager: { getSessionFile: () => "/sessions/parent.jsonl", getSessionId: () => "parent-1" },
    hasPendingMessages: talking,
  });
  // 父会话这一轮里来了一条 steer（pi 的 input 事件），detach.ts 只认它。
  const steer = (h: ReturnType<typeof loadSpawnHarness>, streamingBehavior: "steer" | "followUp" = "steer") =>
    h.handlers.input?.({ type: "input", text: "hi", source: "interactive", streamingBehavior }, {});
  const settledNotices = (h: ReturnType<typeof loadSpawnHarness>) =>
    h.sendMessage.mock.calls.map((c) => c[0] as { customType?: string; content?: string; details?: { childId?: string } })
      .filter((m) => m.customType === "subagent-settled");

  it("single task: returns at once with a background receipt; the child keeps running and reports back with a notice", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    steer(h);
    const r = await h.execute("t-detach", { task: "write 400 numbers" }, null, null, talkingCtx(() => true) as never);

    expect(r.content[0].text).toContain("moved to the background");
    expect(r.content[0].text).toContain("A new message arrived");
    expect(r.content[0].text).not.toContain("user");
    expect(r.details).toMatchObject({ agentId: "sa_test", status: "running", detached: true });
    expect(registryRows.rows.get("sa_test")?.status).toBe("running");
    const { runningChildrenOf } = await import("./child-runs.js");
    expect(runningChildrenOf("parent-1")).toEqual(["sa_test"]);

    slow.resolve(done("four hundred"));
    await vi.waitFor(() => expect(settledNotices(h)).toHaveLength(1));
    expect(settledNotices(h)[0]).toMatchObject({ details: { childId: "sa_test" } });
    expect(settledNotices(h)[0]!.content).toContain("four hundred");
    expect(registryRows.rows.get("sa_test")?.status).toBe("done");
    expect(runningChildrenOf("parent-1")).toEqual([]);
  });

  it("after moving to the background, interrupting the parent's turn no longer cancels the child; before it, it still does", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const turn = new AbortController();
    const h = loadSpawnHarness();
    steer(h);
    await h.execute("t-esc", { task: "x" }, turn.signal, null, talkingCtx(() => true) as never);
    const childSignal = vi.mocked(runEmbeddedSubagent).mock.calls[0]![0].signal!;
    turn.abort();
    expect(childSignal.aborted).toBe(false);
    slow.resolve(done("ok"));

    const second = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(second.promise);
    const turn2 = new AbortController();
    const waiting = loadSpawnHarness().execute("t-esc2", { task: "y" }, turn2.signal, null, talkingCtx(() => false) as never);
    await vi.waitFor(() => expect(runEmbeddedSubagent).toHaveBeenCalledTimes(2));
    const secondSignal = vi.mocked(runEmbeddedSubagent).mock.calls[1]![0].signal!;
    turn2.abort();
    expect(secondSignal.aborted).toBe(true);
    second.resolve({ ...done(""), ok: false, stopReason: "aborted", error: "aborted" });
    await waiting.catch(() => {});
  });

  it("a spawn_agent call made by a codemode script never moves to the background", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    h.handlers.tool_call?.({ type: "tool_call", toolName: "spawn_agent", toolCallId: "nested-1", parentToolCallId: "cm-1", input: {} }, {});
    steer(h);
    const pending = h.execute("nested-1", { task: "x" }, null, null, talkingCtx(() => true) as never);
    await new Promise((r) => setTimeout(r, 450));
    slow.resolve(done("script needs this"));
    const r = await pending;
    expect(r.content[0].text).toBe("script needs this");
    expect(r.details).not.toHaveProperty("detached");
  });

  it("chain always waits for its steps", async () => {
    const h = loadSpawnHarness();
    steer(h);
    const r = await h.execute(
      "t-chain",
      { chain: [{ task: "a" }, { task: "b {previous}" }] },
      null,
      null,
      talkingCtx(() => true) as never,
    );
    expect(r.details).not.toHaveProperty("detached");
    expect(runEmbeddedSubagent).toHaveBeenCalledTimes(2);
  });

  it("parallel: finished tasks come back in the result, unfinished ones move to the background", async () => {
    const { SubAgentRegistry } = await import("./registry.js");
    vi.spyOn(SubAgentRegistry, "genId").mockReturnValueOnce("sa_fast").mockReturnValueOnce("sa_slow");
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) =>
      opts.task === "slow" ? slow.promise : done("fast result", "/tmp/fast.jsonl"),
    );
    let talking = false;
    const h = loadSpawnHarness();
    const pending = h.execute("t-par", { tasks: ["fast", "slow"] }, null, null, talkingCtx(() => talking) as never);
    await vi.waitFor(() => expect(registryRows.rows.get("sa_fast")?.status).toBe("done"));
    steer(h);
    talking = true;
    const r = await pending;

    expect(r.content[0].text).toContain("fast result");
    expect(r.content[0].text).toContain("## Sub-agent 2 (moved to background)");
    expect(r.details).toMatchObject({ mode: "parallel", detached: true });
    const results = r.details?.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ ok: true, output: "fast result", agentId: "sa_fast" });
    expect(results[1]).toMatchObject({ status: "running", detached: true, agentId: "sa_slow" });
    expect(settledNotices(h)).toHaveLength(0);

    slow.resolve(done("slow result", "/tmp/slow.jsonl"));
    await vi.waitFor(() => expect(settledNotices(h)).toHaveLength(1));
    expect(settledNotices(h)[0]).toMatchObject({ details: { childId: "sa_slow" } });
    expect(registryRows.rows.get("sa_slow")?.status).toBe("done");
  });

  it("a detached child keeps its per-session slot until it ends", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "1" : undefined));
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    steer(h);
    await h.execute("t-slot", { task: "x" }, null, null, talkingCtx(() => true) as never);
    await expect(h.execute("t-slot2", { task: "y" }, null, null, talkingCtx(() => false) as never)).rejects.toThrow(/单会话子代理上限/);
    slow.resolve(done("ok"));
    await vi.waitFor(() => expect(registryRows.rows.get("sa_test")?.status).toBe("done"));
    await expect(h.execute("t-slot3", { task: "z" }, null, null, talkingCtx(() => false) as never)).resolves.toBeDefined();
  });

  it("a queued follow-up does not move the run to the background; it means after this is done", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    steer(h, "followUp");
    const pending = h.execute("t-follow", { task: "x" }, null, null, talkingCtx(() => true) as never);
    await new Promise((r) => setTimeout(r, 450));
    slow.resolve(done("waited for it"));
    const r = await pending;
    expect(r.content[0].text).toBe("waited for it");
    expect(r.details).not.toHaveProperty("detached");
  });

  it("a steer from before this turn started was already handed to the model and does not count", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    steer(h);
    h.handlers.turn_start?.({ type: "turn_start", turnIndex: 1, timestamp: 0 }, {});
    const pending = h.execute("t-old-steer", { task: "x" }, null, null, talkingCtx(() => true) as never);
    await new Promise((r) => setTimeout(r, 450));
    slow.resolve(done("waited"));
    expect((await pending).details).not.toHaveProperty("detached");
  });

  it("a steer that never reached the queue (another input hook handled it) does not move the run", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    steer(h);
    const pending = h.execute("t-handled", { task: "x" }, null, null, talkingCtx(() => false) as never);
    await new Promise((r) => setTimeout(r, 450));
    slow.resolve(done("waited"));
    expect((await pending).details).not.toHaveProperty("detached");
  });

  it("agent_end forgets nested codemode calls that never reached execute", async () => {
    const slow = deferredRun();
    vi.mocked(runEmbeddedSubagent).mockReturnValueOnce(slow.promise);
    const h = loadSpawnHarness();
    h.handlers.tool_call?.({ type: "tool_call", toolName: "spawn_agent", toolCallId: "blocked-1", parentToolCallId: "cm-1", input: {} }, {});
    h.handlers.agent_end?.({ type: "agent_end", messages: [] }, {});
    steer(h);
    const r = await h.execute("blocked-1", { task: "x" }, null, null, talkingCtx(() => true) as never);
    expect(r.details).toMatchObject({ detached: true });
    slow.resolve(done("ok"));
    await vi.waitFor(() => expect(settledNotices(h)).toHaveLength(1));
  });

  it("parallel: a detached child still reports back when writing its registry row fails", async () => {
    const { SubAgentRegistry } = await import("./registry.js");
    vi.spyOn(SubAgentRegistry, "genId").mockReturnValueOnce("sa_fast").mockReturnValueOnce("sa_slow");
    const realFinish = SubAgentRegistry.prototype.finish;
    const finish = vi.spyOn(SubAgentRegistry.prototype, "finish").mockImplementation(function (
      this: InstanceType<typeof SubAgentRegistry>,
      id: string,
      patch: Parameters<InstanceType<typeof SubAgentRegistry>["finish"]>[1],
    ) {
      if (id === "sa_slow") throw new Error("database is locked");
      return realFinish.call(this, id, patch);
    });
    try {
      const slow = deferredRun();
      vi.mocked(runEmbeddedSubagent).mockImplementation(async (opts) =>
        opts.task === "slow" ? slow.promise : done("fast result", "/tmp/fast.jsonl"),
      );
      let talking = false;
      const h = loadSpawnHarness();
      const pending = h.execute("t-par-fail", { tasks: ["fast", "slow"] }, null, null, talkingCtx(() => talking) as never);
      await vi.waitFor(() => expect(registryRows.rows.get("sa_fast")?.status).toBe("done"));
      steer(h);
      talking = true;
      expect((await pending).details).toMatchObject({ detached: true });

      slow.resolve(done("slow result", "/tmp/slow.jsonl"));
      await vi.waitFor(() => expect(settledNotices(h)).toHaveLength(1));
      expect(settledNotices(h)[0]).toMatchObject({ details: { childId: "sa_slow" } });
      expect(settledNotices(h)[0]!.content).toContain("database is locked");
    } finally {
      finish.mockRestore();
    }
  });
});
