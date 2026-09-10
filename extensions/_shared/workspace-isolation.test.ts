import { afterEach, describe, expect, it } from "vitest";
import { getApprovalPolicy, setApprovalPolicy, __resetApprovalForTest } from "./approval.js";
import { resolveToolOrigin } from "./desktop-control.js";
import { claimImBinding, currentImBinding, __resetImBindingForTest } from "./im-binding.js";
import { getConfig, __resetForTest } from "./runtime-config.js";
import { runInWorkspace } from "./workspace-context.js";

afterEach(() => {
  __resetForTest();
  __resetApprovalForTest();
  __resetImBindingForTest();
  delete process.env.AGENT_DATA_ENDPOINT;
  delete process.env.PI_HUMAN_ORIGIN_TOKEN;
  delete process.env.PI_GOAL_WORKER;
});

const ctx = (workspace: string, config: Record<string, string>, origin: "main" | "goal" = "main") =>
  ({ origin, workspace, cwd: workspace, config }) as const;

describe("跨 workspace 隔离回归", () => {
  it("A / B 的 AGENT_DATA_ENDPOINT 与 PI_MCP_CONFIG 互不可见", async () => {
    process.env.AGENT_DATA_ENDPOINT = "global-should-not-win";
    const [a, b] = await Promise.all([
      runInWorkspace(ctx("D:/a", { AGENT_DATA_ENDPOINT: "token-a", PI_MCP_CONFIG: "[a]" }), async () => ({
        endpoint: getConfig("AGENT_DATA_ENDPOINT"),
        mcp: getConfig("PI_MCP_CONFIG"),
      })),
      runInWorkspace(ctx("D:/b", { AGENT_DATA_ENDPOINT: "token-b", PI_MCP_CONFIG: "[b]" }), async () => ({
        endpoint: getConfig("AGENT_DATA_ENDPOINT"),
        mcp: getConfig("PI_MCP_CONFIG"),
      })),
    ]);
    expect(a).toEqual({ endpoint: "token-a", mcp: "[a]" });
    expect(b).toEqual({ endpoint: "token-b", mcp: "[b]" });
  });

  it("Goal 回合 origin=goal 且 token=0", async () => {
    process.env.PI_HUMAN_ORIGIN_TOKEN = "1";
    await runInWorkspace(ctx("D:/a", { PI_HUMAN_ORIGIN_TOKEN: "0" }, "goal"), async () => {
      expect(resolveToolOrigin()).toBe("goal");
      expect(getConfig("PI_HUMAN_ORIGIN_TOKEN")).toBe("0");
    });
  });

  it("getApprovalPolicy 按 cwd 匹配，不串到另一项目", () => {
    setApprovalPolicy("ask", "D:/a");
    setApprovalPolicy("full", "D:/b");
    expect(getApprovalPolicy("D:/a")).toBe("ask");
    expect(getApprovalPolicy("D:/b")).toBe("full");
  });

  it("ImBinding：第二 workspace 不覆盖；owner 关闭后可重新声明", () => {
    expect(claimImBinding("D:/a", "s1")).toEqual({ claimed: true });
    expect(claimImBinding("D:/b", "s2")).toMatchObject({ claimed: false });
    expect(currentImBinding()?.workspace).toBe("D:/a");
  });
});
