// Ultra 路由域：spawn 时固定进 subagent_meta，冷恢复在子会话自己的域里初始化扩展与新轮。
// 这里用真实 embedded-runner / activation 路径，只把 SDK 边界换成假实现。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  open: vi.fn(),
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
  resolveCliModel: vi.fn(({ cliModel }: { cliModel: string }) => {
    const [provider, id] = cliModel.split("/");
    return { model: { provider, id }, error: undefined };
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionServices: (...args: unknown[]) => sdk.createAgentSessionServices(...args),
  createAgentSessionFromServices: (...args: unknown[]) => sdk.createAgentSessionFromServices(...args),
  resolveCliModel: (...args: unknown[]) => sdk.resolveCliModel(...(args as [{ cliModel: string }])),
  SessionManager: {
    create: (...args: unknown[]) => sdk.create(...args),
    open: (...args: unknown[]) => sdk.open(...args),
  },
  getAgentDir: () => "/agent",
}));

import { __resetAgentModeForTest, setAgentMode, type AgentMode } from "../agent-mode/modes.js";
import { currentWorkspaceContext, runInWorkspace, type WorkspaceContext } from "../_shared/workspace-context.js";
import { __resetForTest as resetRuntimeConfig } from "../_shared/runtime-config.js";
import { __resetApprovalRoutesForTest } from "../_shared/approval-route.js";
import { __resetLeakOwnerForTest } from "../_shared/leak-owner.js";
import {
  __resetActivationsForTest,
  deliverToChild,
  getActivation,
  installActivation,
  openResumedChildSession,
} from "./activation.js";
import { runEmbeddedSubagent } from "./embedded-runner.js";
import { lastSubagentMeta } from "./subagent-meta.js";
import { ROUTING_MODE_KEY, isUltraRouting } from "../_shared/ultra-context.js";

const ultra = "ultra" as unknown as AgentMode;

function fakeSession(seen: { prompts: Array<WorkspaceContext | undefined>; binds: Array<WorkspaceContext | undefined> }) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" }],
    sessionId: "sa-child",
    isStreaming: false,
    pendingMessageCount: 0,
    prompt: vi.fn(async (_text: string, opts?: { preflightResult?: (disposition: unknown) => void }) => {
      seen.prompts.push(currentWorkspaceContext());
      opts?.preflightResult?.("started");
    }),
    waitForIdle: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {
      seen.binds.push(currentWorkspaceContext());
    }),
    subscribe: vi.fn(() => () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function sessionManager(seenEntries: unknown[] = []) {
  const entries = [...seenEntries];
  return {
    entries,
    appendMessage: vi.fn(),
    appendCustomEntry: vi.fn((type: string, data: unknown) => entries.push({ type: "custom", customType: type, data })),
    appendModelChange: vi.fn(),
    getSessionFile: () => "/ws/.pi/sessions/sa-child.jsonl",
    getEntries: () => entries,
    getCwd: () => "/ws",
  };
}

const originalSystemWorker = process.env.PI_SYSTEM_WORKER;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAgentModeForTest();
  __resetActivationsForTest();
  __resetApprovalRoutesForTest();
  __resetLeakOwnerForTest();
  delete process.env.PI_RUNTIME_CONFIG;
  process.env.PI_SYSTEM_WORKER = "1";
  resetRuntimeConfig();
  sdk.createAgentSessionServices.mockResolvedValue({ modelRuntime: { id: "runtime" } });
  sdk.create.mockReturnValue(sessionManager());
});

afterEach(() => {
  __resetAgentModeForTest();
  if (originalSystemWorker === undefined) delete process.env.PI_SYSTEM_WORKER;
  else process.env.PI_SYSTEM_WORKER = originalSystemWorker;
});

function writtenMeta(): Record<string, unknown> | undefined {
  const manager = sdk.create.mock.results.at(-1)?.value as ReturnType<typeof sessionManager>;
  return lastSubagentMeta(manager.entries);
}

describe("routing domain is fixed into subagent_meta at spawn", () => {
  it("records ultra when the spawn env pins ultra, keeping model and thinking as given", async () => {
    const seen = { prompts: [], binds: [] };
    sdk.createAgentSessionFromServices.mockResolvedValue({ session: fakeSession(seen) });

    const r = await runEmbeddedSubagent({
      cwd: "/ws",
      task: "do work",
      agentId: "sa-child",
      model: "vendor/model-a",
      thinkingLevel: "medium",
      env: { [ROUTING_MODE_KEY]: "ultra" },
    });

    expect(r.ok).toBe(true);
    const meta = writtenMeta();
    expect(meta?.routingMode).toBe("ultra");
    expect(meta?.model).toBe("vendor/model-a");
    expect(meta?.thinkingLevel).toBe("medium");
    // 域标记不扩大权限：只加域键，不设模式、不改 deny 之外的任何东西。
    expect(meta).not.toHaveProperty("agentMode");
    const spawnArg = sdk.createAgentSessionFromServices.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArg.model).toEqual({ provider: "vendor", id: "model-a" });
    expect(spawnArg.thinkingLevel).toBe("medium");
  });

  it("records ordinary when nothing pins ultra", async () => {
    const seen = { prompts: [], binds: [] };
    sdk.createAgentSessionFromServices.mockResolvedValue({ session: fakeSession(seen) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-c2" });
    expect(writtenMeta()?.routingMode).toBe("ordinary");
  });

  it("root session in ultra mode spawns an ultra child; after the root switches back, spawns ordinary", async () => {
    const seen = { prompts: [], binds: [] };
    sdk.createAgentSessionFromServices.mockResolvedValue({ session: fakeSession(seen) });
    setAgentMode(ultra, "/ws", "root-session");

    await runInWorkspace(
      { origin: "main", workspace: "/ws", cwd: "/ws", config: {}, sessionId: () => "root-session" },
      async () => {
        await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-u" });
      },
    );
    expect(writtenMeta()?.routingMode).toBe("ultra");
    expect(isUltraRouting(undefined)).toBe(false); // 进程里没有残留的固定域

    setAgentMode("agent", "/ws", "root-session");
    await runInWorkspace(
      { origin: "main", workspace: "/ws", cwd: "/ws", config: {}, sessionId: () => "root-session" },
      async () => {
        await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-o" });
      },
    );
    expect(writtenMeta()?.routingMode).toBe("ordinary");
  });
});

describe("cold resume runs the child in its own domain", () => {
  type Seen = { prompts: Array<WorkspaceContext | undefined>; binds: Array<WorkspaceContext | undefined>; services?: WorkspaceContext };

  /** 假 ModelRuntime：只实现恢复要用的 getModel / hasConfiguredAuth。 */
  function runtime(models: string[] = ["vendor/model-a"], unauth: string[] = []) {
    const known = new Map(models.map((route) => [route, { provider: route.split("/")[0], id: route.split("/")[1] }]));
    return {
      id: "runtime",
      getModel: (provider: string, id: string) => known.get(`${provider}/${id}`),
      hasConfiguredAuth: (provider: string) => !unauth.includes(provider),
    };
  }

  function openWithMeta(
    meta: Record<string, unknown> | undefined,
    seen: Seen,
    modelRuntime = runtime(),
    branch: unknown[] = [],
  ) {
    const manager = {
      ...sessionManager(meta ? [{ type: "custom", customType: "subagent_meta", data: meta }] : []),
      getBranch: () => branch,
    };
    sdk.open.mockReturnValue(manager);
    const session = fakeSession(seen);
    sdk.createAgentSessionServices.mockImplementationOnce((async () => {
      seen.services = currentWorkspaceContext();
      return { modelRuntime };
    }) as never);
    sdk.createAgentSessionFromServices.mockResolvedValue({ session });
    return { manager, session };
  }

  const parentUltra: WorkspaceContext = {
    origin: "main",
    workspace: "/ws",
    cwd: "/ws",
    config: { PARENT_ONLY: "1", [ROUTING_MODE_KEY]: "ultra" },
  };
  const parentOrdinary: WorkspaceContext = { ...parentUltra, config: { PARENT_ONLY: "1", [ROUTING_MODE_KEY]: "ordinary" } };

  it("extension init, bind and prompt all see ordinary for an ordinary child even while the parent is ultra", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    openWithMeta(
      { mode: "continuable", routingMode: "ordinary", parentSessionId: "p1", workspace: "/ws", agentId: "sa-1" },
      seen,
    );

    const resumed = await runInWorkspace(parentUltra, () => openResumedChildSession("/ws/child.jsonl"));

    expect(seen.services?.config[ROUTING_MODE_KEY]).toBe("ordinary");
    expect(seen.binds.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ordinary");
    await resumed.session.prompt("next turn");
    expect(seen.prompts.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ordinary");
    // 既有继承面不变（父会话的其它配置照旧），被换掉的只有域。
    expect(seen.prompts.at(-1)?.config.PARENT_ONLY).toBe("1");
    // 不改变子会话已保存的模型 / 档位：重建时哪一项都不传。
    const args = sdk.createAgentSessionFromServices.mock.calls[0][0] as Record<string, unknown>;
    expect("model" in args).toBe(false);
    expect("thinkingLevel" in args).toBe(false);
  });

  it("keeps ultra for an ultra child even when the parent has since switched to ordinary", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    const branch = [
      { type: "message", role: "user" },
      { type: "model_change", provider: "vendor", modelId: "model-a" },
    ];
    openWithMeta({ mode: "continuable", routingMode: "ultra", workspace: "/ws", agentId: "sa-2" }, seen, runtime(), branch);

    const resumed = await runInWorkspace(parentOrdinary, () => openResumedChildSession("/ws/child.jsonl"));

    expect(seen.services?.config[ROUTING_MODE_KEY]).toBe("ultra");
    await resumed.session.prompt("more");
    expect(seen.prompts.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ultra");
    // Ultra 续聊显式传回会话记录里的模型，SDK 没有机会回退到别的模型。
    const args = sdk.createAgentSessionFromServices.mock.calls[0][0] as Record<string, unknown>;
    expect(args.model).toEqual({ provider: "vendor", id: "model-a" });
    // 档位仍由会话记录恢复，不在这里重设。
    expect("thinkingLevel" in args).toBe(false);
  });

  it("ultra resume falls back to subagent_meta.model when the log has no model_change", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    openWithMeta(
      { mode: "continuable", routingMode: "ultra", workspace: "/ws", agentId: "sa-4", model: "vendor/model-a" },
      seen,
    );
    await runInWorkspace(parentOrdinary, () => openResumedChildSession("/ws/child.jsonl"));
    const args = sdk.createAgentSessionFromServices.mock.calls[0][0] as Record<string, unknown>;
    expect(args.model).toEqual({ provider: "vendor", id: "model-a" });
  });

  it("ultra resume refuses instead of letting the SDK fall back when the recorded model is gone", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    const branch = [{ type: "model_change", provider: "gone", modelId: "model-x" }];
    openWithMeta(
      { mode: "continuable", routingMode: "ultra", workspace: "/ws", agentId: "sa-5" },
      seen,
      runtime(["vendor/model-a"]),
      branch,
    );

    await expect(runInWorkspace(parentOrdinary, () => openResumedChildSession("/ws/child.jsonl"))).rejects.toThrow(
      /gone\/model-x.*not available/,
    );
    // 没有在别的模型上建会话。
    expect(sdk.createAgentSessionFromServices).not.toHaveBeenCalled();
  });

  it("ultra resume refuses when the recorded provider has no configured credentials", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    const branch = [{ type: "model_change", provider: "vendor", modelId: "model-a" }];
    openWithMeta(
      { mode: "continuable", routingMode: "ultra", workspace: "/ws", agentId: "sa-6" },
      seen,
      runtime(["vendor/model-a"], ["vendor"]),
      branch,
    );
    await expect(runInWorkspace(parentOrdinary, () => openResumedChildSession("/ws/child.jsonl"))).rejects.toThrow(
      /vendor\/model-a.*no configured credentials/,
    );
    expect(sdk.createAgentSessionFromServices).not.toHaveBeenCalled();
  });

  it("ultra resume refuses when the session never recorded a model", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    openWithMeta({ mode: "continuable", routingMode: "ultra", workspace: "/ws", agentId: "sa-7" }, seen);
    await expect(runInWorkspace(parentOrdinary, () => openResumedChildSession("/ws/child.jsonl"))).rejects.toThrow(
      /without a recorded model/,
    );
  });

  it("a legacy child session without a routing mark resumes as ordinary", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    openWithMeta({ mode: "continuable", workspace: "/ws", agentId: "sa-3" }, seen);

    const resumed = await runInWorkspace(parentUltra, () => openResumedChildSession("/ws/child.jsonl"));

    expect(seen.services?.config[ROUTING_MODE_KEY]).toBe("ordinary");
    await resumed.session.prompt("hello");
    expect(seen.prompts.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ordinary");
    // 普通旧恢复保持原行为：不显式传模型，交给 SDK 按会话恢复。
    expect("model" in (sdk.createAgentSessionFromServices.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });
});

describe("resident follow-ups run in the child's domain", () => {
  type Seen = { prompts: Array<WorkspaceContext | undefined>; binds: Array<WorkspaceContext | undefined> };

  const parentUltra: WorkspaceContext = {
    origin: "main",
    workspace: "/ws",
    cwd: "/ws",
    config: { PARENT_ONLY: "1", [ROUTING_MODE_KEY]: "ultra" },
  };

  it("an ordinary child delivered to by an ultra parent still prompts under ordinary", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    const session = fakeSession(seen);
    const manager = sessionManager([
      { type: "custom", customType: "subagent_meta", data: { mode: "continuable", routingMode: "ordinary", workspace: "/ws" } },
    ]);
    installActivation({
      childId: "sa-resident",
      sessionPath: "/ws/.pi/sessions/sa-resident.jsonl",
      parentSessionId: "p1",
      parentSessionPath: "/ws/parent.jsonl",
      workspace: "/ws",
      session: session as never,
      sessionManager: manager,
      announced: true,
      routingMode: "ordinary",
      keepResident: true,
    });
    expect(getActivation("sa-resident")?.routingMode).toBe("ordinary");

    await runInWorkspace(parentUltra, () => deliverToChild("sa-resident", "next", "followUp"));
    await vi.waitFor(() => expect(seen.prompts.length).toBeGreaterThan(0));
    expect(seen.prompts.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ordinary");
  });

  it("an ultra child delivered to by an ordinary parent still prompts under ultra", async () => {
    const seen: Seen = { prompts: [], binds: [] };
    const session = fakeSession(seen);
    const manager = sessionManager([
      { type: "custom", customType: "subagent_meta", data: { mode: "continuable", routingMode: "ultra", workspace: "/ws" } },
    ]);
    installActivation({
      childId: "sa-ultra-resident",
      sessionPath: "/ws/.pi/sessions/sa-ultra.jsonl",
      parentSessionId: "p1",
      parentSessionPath: "/ws/parent.jsonl",
      workspace: "/ws",
      session: session as never,
      sessionManager: manager,
      announced: true,
      keepResident: true,
    });

    await runInWorkspace(
      { ...parentUltra, config: { PARENT_ONLY: "1", [ROUTING_MODE_KEY]: "ordinary" } },
      () => deliverToChild("sa-ultra-resident", "next", "followUp"),
    );
    await vi.waitFor(() => expect(seen.prompts.length).toBeGreaterThan(0));
    expect(seen.prompts.at(-1)?.config[ROUTING_MODE_KEY]).toBe("ultra");
  });
});
