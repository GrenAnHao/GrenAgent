import { describe, expect, it } from "vitest";
import { namedExtensions } from "./index.js";
import { project } from "./mcp/index.js";

type Registered = { name: string; promptSnippet?: string; promptGuidelines?: string[] };

function collectTools(): Registered[] {
  const tools: Registered[] = [];
  const pi = {
    registerTool: (tool: Registered) => {
      tools.push(tool);
    },
    on() {},
    registerCommand() {},
    getActiveTools() {
      return tools.map((tool) => tool.name);
    },
    setActiveTools() {},
    getAllTools() {
      return tools;
    },
    appendEntry() {},
    sendMessage() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  for (const { name, factory } of namedExtensions) {
    try {
      factory(pi as never);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
  }
  return tools;
}

describe("official tool prompt metadata", () => {
  it("does not register removed long-term memory tools", () => {
    const names = collectTools().map((tool) => tool.name);
    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("conversation_search");
    expect(names).toEqual(expect.arrayContaining(["code_explore"]));
    expect(names).not.toContain("wiki_search");
  });

  it("gives every statically registered tool a promptSnippet", () => {
    const tools = collectTools();
    expect(tools.map((tool) => tool.name).length).toBeGreaterThan(20);
    expect(tools.filter((tool) => !tool.promptSnippet?.trim()).map((tool) => tool.name)).toEqual([]);
  });

  it("gives each AgentData family one primary tool with named promptGuidelines", () => {
    const tools = collectTools();
    const primaries = tools.filter((tool) => tool.name === "code_explore");
    // 资料 Wiki 下线后只剩代码检索这一类主工具；原先按“两类各一个”计数。
    expect(primaries.length).toBeGreaterThan(0);
    for (const tool of primaries) {
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
      for (const guideline of tool.promptGuidelines ?? []) {
        expect(guideline).toMatch(/code_[a-z0-9_*]+|wiki_[a-z]+/);
        expect(guideline).not.toMatch(/\bthis tool\b/i);
      }
    }
  });

  it("projects MCP tools with a promptSnippet so Pi lists them", () => {
    const tools: Registered[] = [];
    project(
      {
        registerTool: (tool: Registered) => {
          tools.push(tool);
        },
        getActiveTools: () => [],
        setActiveTools() {},
      } as never,
      {
        servers: new Map([
          [
            "docs",
            {
              status: "connected",
              tools: [{ name: "lookup", description: "Look up a docs page." }],
            },
          ],
        ]),
      } as never,
      { callTool: async () => ({ text: "" }) },
    );
    expect(tools).toEqual([
      expect.objectContaining({
        name: "mcp__docs__lookup",
        promptSnippet: "Look up a docs page.",
      }),
    ]);
  });
});
