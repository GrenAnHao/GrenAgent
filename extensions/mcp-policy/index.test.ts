import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApprovalPolicy: vi.fn(() => "auto"),
  decide: vi.fn(() => ({ action: "pass" as const })),
}));

vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: mocks.getApprovalPolicy }));
vi.mock("./policy.js", async () => {
  const actual = await vi.importActual<typeof import("./policy.js")>("./policy.js");
  return { ...actual, decide: mocks.decide };
});

import mcpPolicy from "./index.js";

type ToolCall = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(): ToolCall {
  let handler: ToolCall | undefined;
  mcpPolicy({ on: (ev: string, h: ToolCall) => { if (ev === "tool_call") handler = h; } } as never);
  return (event, ctx) => handler!(event, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApprovalPolicy.mockReturnValue("auto");
  mocks.decide.mockReturnValue({ action: "pass" });
});

describe("mcp-policy approvalAsk mapping", () => {
  it("readonly is treated as approvalAsk so MCP is not prompted twice", async () => {
    mocks.getApprovalPolicy.mockReturnValue("readonly");
    await setup()({ toolName: "mcp__s__t", input: {} }, { hasUI: true });
    expect(mocks.decide.mock.calls[0]?.[4]).toBe(true);
  });
});
