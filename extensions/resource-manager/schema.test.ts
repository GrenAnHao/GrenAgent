import { describe, expect, it } from "vitest";
import resourceManager from "./index.js";

describe("add_mcp_server schema", () => {
  it("keeps a JSON Schema object root so providers accept the tool", () => {
    const tools: Array<{ name: string; parameters?: { type?: string; anyOf?: unknown } }> = [];
    resourceManager({
      registerTool: (tool: { name: string; parameters?: { type?: string; anyOf?: unknown } }) => {
        tools.push(tool);
      },
      on() {},
    } as never);

    const mcp = tools.find((tool) => tool.name === "add_mcp_server");
    expect(mcp?.parameters?.type).toBe("object");
    expect(mcp?.parameters?.anyOf).toBeUndefined();
    expect(mcp?.parameters).toMatchObject({
      properties: {
        transport: expect.anything(),
        url: expect.anything(),
        headers: expect.anything(),
      },
    });
  });
});
