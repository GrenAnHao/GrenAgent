import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetActiveRunsForTest, acquireActiveSlot } from "./active-runs.js";
import { __resetChildRunsForTest, markChildRunning } from "./child-runs.js";
import { formatListedAgents, listChildren, registerListAgents } from "./list-agents.js";

const catalog = (childId: string, mode: "one-shot" | "continuable", label: string) => ({
  type: "custom",
  customType: "subagent_catalog",
  data: { version: 0, childId, sessionPath: `/s/${childId}.jsonl`, childCreatedAt: 1, mode, label },
});

function ctx(entries: unknown[]) {
  return {
    cwd: "/ws",
    sessionManager: { getSessionId: () => "parent-1", buildContextEntries: () => entries },
  } as never;
}

beforeEach(() => {
  __resetChildRunsForTest();
  __resetActiveRunsForTest();
});
afterEach(() => {
  __resetChildRunsForTest();
  __resetActiveRunsForTest();
});

describe("list_agents", () => {
  it("lists the caller's own catalog children with running / inactive projected from runtime state", async () => {
    markChildRunning("sa-bg", "parent-1");
    await acquireActiveSlot({ childId: "sa-fg", backend: "in-process", depth: 1 });
    const agents = listChildren(
      ctx([
        catalog("sa-bg", "continuable", "background review"),
        catalog("sa-fg", "one-shot", "foreground scan"),
        catalog("sa-old", "continuable", "earlier task"),
        { type: "custom", customType: "subagent_catalog_base", data: { version: 0 } },
        catalog("sa-bg", "continuable", "background review"),
        catalog("sa-fg", "one-shot", "foreground scan"),
        catalog("sa-old", "continuable", "earlier task"),
      ]),
    );
    expect(agents.map((a) => `${a.childId}:${a.status}:${a.mode}`)).toEqual([
      "sa-bg:running:continuable",
      "sa-fg:running:one-shot",
      "sa-old:inactive:continuable",
    ]);
    const text = formatListedAgents(agents);
    expect(text).toContain("sa-old  [inactive]  earlier task");
    expect(text).toContain("sa-fg  [running]  foreground scan (one-shot: cannot receive messages)");
  });

  it("says so when the session has no children", () => {
    expect(formatListedAgents(listChildren(ctx([])))).toBe("You have not started any sub-agents in this session.");
  });

  it("registers with a snippet and a guideline that names the tool", () => {
    let tool: { name?: string; promptSnippet?: string; promptGuidelines?: string[] } = {};
    registerListAgents({ registerTool: (t: typeof tool) => (tool = t) } as never);
    expect(tool.name).toBe("list_agents");
    expect(tool.promptSnippet).toBeTruthy();
    for (const g of tool.promptGuidelines ?? []) expect(g).toContain("list_agents");
  });
});
