import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMode } from "../agent-mode/modes.js";
import { __resetAgentModeForTest, setAgentMode } from "../agent-mode/modes.js";
import { runInWorkspace } from "./workspace-context.js";
import {
  ROUTING_MODE_KEY,
  isUltraRouting,
  routingContextEnv,
  routingModeFromConfig,
  routingModeFromMeta,
  routingWorkspaceContext,
  withRoutingMode,
} from "./ultra-context.js";

const ultra = "ultra" as unknown as AgentMode;

function subagentCtx(meta: Record<string, unknown> | undefined, cwd = "/ws") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "child-session",
      getEntries: () => (meta ? [{ type: "custom", customType: "subagent_meta", data: meta }] : []),
    },
  };
}

function rootCtx(cwd = "/ws", sessionId = "root-session") {
  return { cwd, sessionManager: { getSessionId: () => sessionId, getEntries: () => [] } };
}

describe("routingContextEnv", () => {
  it("writes only the internal routing key", () => {
    expect(routingContextEnv(true)).toEqual({ PI_SUBAGENT_ROUTING_MODE: "ultra" });
    expect(routingContextEnv(false)).toEqual({ PI_SUBAGENT_ROUTING_MODE: "ordinary" });
    expect(ROUTING_MODE_KEY).toBe("PI_SUBAGENT_ROUTING_MODE");
  });
});

describe("routingMode helpers", () => {
  it("reads a pinned mode from config and ignores unknown values", () => {
    expect(routingModeFromConfig({ PI_SUBAGENT_ROUTING_MODE: "ultra" })).toBe("ultra");
    expect(routingModeFromConfig({ PI_SUBAGENT_ROUTING_MODE: "bogus" })).toBeUndefined();
    expect(routingModeFromConfig(undefined)).toBeUndefined();
  });

  it("treats legacy subagent_meta without routingMode as ordinary", () => {
    expect(routingModeFromMeta({ mode: "continuable" })).toBe("ordinary");
    expect(routingModeFromMeta(undefined)).toBe("ordinary");
    expect(routingModeFromMeta({ routingMode: "ultra" })).toBe("ultra");
  });

  it("builds a child context with its own routing key, keeping every other inherited key", () => {
    runInWorkspace({ origin: "main", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ultra", A: "1" } }, () => {
      const ctx = routingWorkspaceContext("ordinary", { workspace: "/ws", cwd: "/ws", config: { B: "2" } });
      expect(ctx.origin).toBe("subagent");
      expect(ctx.config.PI_SUBAGENT_ROUTING_MODE).toBe("ordinary");
      expect(ctx.config.B).toBe("2");
      // 不改变既有继承面：其它键照旧，只有域被换成子会话自己的。
      expect(ctx.config.A).toBe("1");
      expect(withRoutingMode(ctx, "ultra").config).toEqual({ A: "1", B: "2", PI_SUBAGENT_ROUTING_MODE: "ultra" });
    });
  });
});

describe("isUltraRouting", () => {
  const savedEnv = process.env[ROUTING_MODE_KEY];
  beforeEach(() => {
    __resetAgentModeForTest();
    delete process.env[ROUTING_MODE_KEY];
    delete process.env.PI_IS_SUBAGENT;
  });
  afterEach(() => {
    __resetAgentModeForTest();
    if (savedEnv === undefined) delete process.env[ROUTING_MODE_KEY];
    else process.env[ROUTING_MODE_KEY] = savedEnv;
    delete process.env.PI_IS_SUBAGENT;
  });

  it("root session: ultra mode for its own (cwd, sessionId), and only then", () => {
    expect(isUltraRouting(rootCtx())).toBe(false);
    setAgentMode(ultra, "/ws", "root-session");
    expect(isUltraRouting(rootCtx())).toBe(true);
    // 别的会话仍是普通
    expect(isUltraRouting(rootCtx("/ws", "other-session"))).toBe(false);
  });

  it("root session falls back to the project default mode when the session has none", () => {
    setAgentMode(ultra, "/ws", undefined);
    expect(isUltraRouting(rootCtx())).toBe(true);
    expect(isUltraRouting(rootCtx("/elsewhere"))).toBe(false);
  });

  it("child session: the pinned meta wins over a parent that later switches to ultra", () => {
    setAgentMode(ultra, "/ws", "root-session");
    const child = subagentCtx({ origin: "subagent", mode: "continuable", routingMode: "ordinary" });
    expect(isUltraRouting(child)).toBe(false);
    expect(isUltraRouting(subagentCtx({ origin: "subagent", mode: "continuable", routingMode: "ultra" }))).toBe(true);
  });

  it("legacy child without routingMode is ordinary even if the root is ultra", () => {
    setAgentMode(ultra, "/ws", "root-session");
    expect(isUltraRouting(subagentCtx({ origin: "subagent", mode: "continuable" }))).toBe(false);
    process.env.PI_IS_SUBAGENT = "1";
    expect(isUltraRouting(undefined)).toBe(false);
  });

  it("inherits the pinned mode from the contextual config (nested child in a worker)", () => {
    runInWorkspace(
      { origin: "subagent", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ultra" } },
      () => expect(isUltraRouting(undefined)).toBe(true),
    );
    runInWorkspace(
      { origin: "subagent", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ordinary" } },
      () => expect(isUltraRouting(subagentCtx({ origin: "subagent", mode: "continuable" }))).toBe(false),
    );
  });
});

// 边界：根会话只能由真实 AgentMode 决定；旧子会话缺 routingMode 就是 ordinary。
describe("isUltraRouting boundaries", () => {
  const savedEnv = process.env[ROUTING_MODE_KEY];
  beforeEach(() => {
    __resetAgentModeForTest();
    delete process.env[ROUTING_MODE_KEY];
    delete process.env.PI_IS_SUBAGENT;
  });
  afterEach(() => {
    __resetAgentModeForTest();
    if (savedEnv === undefined) delete process.env[ROUTING_MODE_KEY];
    else process.env[ROUTING_MODE_KEY] = savedEnv;
    delete process.env.PI_IS_SUBAGENT;
  });

  it("a root session stays ordinary even when the ALS / env carries an ultra marker", () => {
    process.env[ROUTING_MODE_KEY] = "ultra";
    runInWorkspace(
      { origin: "main", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ultra" } },
      () => expect(isUltraRouting(rootCtx())).toBe(false),
    );
    expect(isUltraRouting(rootCtx())).toBe(false);
    // 真实 Ultra 模式仍然是唯一入口
    setAgentMode(ultra, "/ws", "root-session");
    runInWorkspace(
      { origin: "main", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ultra" } },
      () => expect(isUltraRouting(rootCtx())).toBe(true),
    );
  });

  it("a parent callback uses its own SDK identity rather than the sending child's ALS domain", () => {
    for (const [mode, inherited, expected] of [["agent", "ultra", false], ["ultra", "ordinary", true]] as const) {
      setAgentMode(mode, "/ws", "root-session");
      runInWorkspace({ origin: "subagent", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: inherited } }, () => {
        expect(isUltraRouting(rootCtx())).toBe(expected);
      });
    }
  });

  it("a legacy child with subagent_meta but no routingMode is ordinary, not the parent's ultra marker", () => {
    runInWorkspace(
      { origin: "subagent", workspace: "/ws", cwd: "/ws", config: { PI_SUBAGENT_ROUTING_MODE: "ultra" } },
      () => {
        expect(isUltraRouting(subagentCtx({ origin: "subagent", mode: "continuable" }))).toBe(false);
        expect(isUltraRouting(undefined)).toBe(true); // 这个上下文本身还是 Ultra 域
      },
    );
    process.env[ROUTING_MODE_KEY] = "ultra";
    expect(isUltraRouting(subagentCtx({ origin: "subagent", mode: "one-shot" }))).toBe(false);
  });
});
