import { describe, expect, it } from "vitest";
import {
  AGENT_ALIASES,
  builtinDefaultAgents,
  inferNamedAgentProfile,
  resolveAgent,
  suggestAgent,
  withBuiltinDefaults,
  type AgentConfig,
} from "./agents.js";

function agent(name: string): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `prompt-${name}`,
    source: "user",
    filePath: `/agents/${name}.md`,
  };
}

const defaults = ["scout", "planner", "reviewer", "worker"].map(agent);

describe("resolveAgent", () => {
  it("exact name match", () => {
    expect(resolveAgent(defaults, "scout")?.name).toBe("scout");
    expect(resolveAgent(defaults, "worker")?.name).toBe("worker");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveAgent(defaults, "Scout")?.name).toBe("scout");
    expect(resolveAgent(defaults, "WORKER")?.name).toBe("worker");
    expect(resolveAgent(defaults, "  planner  ")?.name).toBe("planner");
  });

  it("resolves the reported bug: explorer/explore -> scout", () => {
    expect(resolveAgent(defaults, "explorer")?.name).toBe("scout");
    expect(resolveAgent(defaults, "explore")?.name).toBe("scout");
    expect(resolveAgent(defaults, "Exploration")?.name).toBe("scout");
  });

  it("resolves other role synonyms to canonical agents", () => {
    expect(resolveAgent(defaults, "plan")?.name).toBe("planner");
    expect(resolveAgent(defaults, "review")?.name).toBe("reviewer");
    expect(resolveAgent(defaults, "code-reviewer")?.name).toBe("reviewer");
    expect(resolveAgent(defaults, "executor")?.name).toBe("worker");
    expect(resolveAgent(defaults, "general")?.name).toBe("worker");
  });

  it("only applies an alias when the canonical target is present", () => {
    const onlyPlanner = [agent("planner")];
    // "explorer" aliases to scout, but scout is not present -> no match
    expect(resolveAgent(onlyPlanner, "explorer")).toBeUndefined();
    expect(resolveAgent(onlyPlanner, "plan")?.name).toBe("planner");
  });

  it("does not override a user agent literally named like an alias", () => {
    const withExplorer = [...defaults, agent("explorer")];
    // exact match wins over the alias->scout mapping
    expect(resolveAgent(withExplorer, "explorer")?.name).toBe("explorer");
  });

  it("returns undefined for empty or unknown names", () => {
    expect(resolveAgent(defaults, "")).toBeUndefined();
    expect(resolveAgent(defaults, "   ")).toBeUndefined();
    expect(resolveAgent(defaults, "totally-unrelated")).toBeUndefined();
  });
});

describe("suggestAgent", () => {
  it("suggests the closest agent for a typo", () => {
    expect(suggestAgent(defaults, "scuot")).toBe("scout");
    expect(suggestAgent(defaults, "wokrer")).toBe("worker");
  });

  it("suggests via alias terms and substrings", () => {
    expect(suggestAgent(defaults, "explorerr")).toBe("scout");
    expect(suggestAgent(defaults, "rev")).toBe("reviewer");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggestAgent(defaults, "qwertyuiop")).toBeUndefined();
  });

  it("returns undefined with no discovered agents", () => {
    expect(suggestAgent([], "scout")).toBeUndefined();
  });
});

describe("AGENT_ALIASES", () => {
  it("maps explorer/explore onto the scout agent", () => {
    expect(AGENT_ALIASES.scout).toContain("explorer");
    expect(AGENT_ALIASES.scout).toContain("explore");
  });

  it("maps ask onto the scout agent when no disk ask.md exists", () => {
    expect(AGENT_ALIASES.scout).toContain("ask");
    expect(resolveAgent(defaults, "ask")?.name).toBe("scout");
  });
});

describe("inferNamedAgentProfile", () => {
  it("maps canonical roles and aliases onto capability presets", () => {
    expect(inferNamedAgentProfile("scout")).toBe("explore");
    expect(inferNamedAgentProfile("ask")).toBe("explore");
    expect(inferNamedAgentProfile("explorer")).toBe("explore");
    expect(inferNamedAgentProfile("reviewer")).toBe("reviewer");
    expect(inferNamedAgentProfile("planner")).toBe("planner");
    expect(inferNamedAgentProfile("worker")).toBe("default");
  });

  it("infers explore when a custom agent tools list has no write/edit", () => {
    expect(inferNamedAgentProfile("custom-ask", ["read", "grep", "find", "ls", "ask_user"])).toBe("explore");
    expect(inferNamedAgentProfile(undefined, ["read", "grep"])).toBe("explore");
  });

  it("does not infer readonly when tools include write/edit", () => {
    expect(inferNamedAgentProfile("custom-worker", ["read", "write", "edit", "bash"])).toBeUndefined();
    expect(inferNamedAgentProfile("ask", ["read", "write"])).toBeUndefined();
    expect(inferNamedAgentProfile(undefined, ["write"])).toBeUndefined();
  });

  it("returns undefined without a name or tools", () => {
    expect(inferNamedAgentProfile()).toBeUndefined();
    expect(inferNamedAgentProfile("   ")).toBeUndefined();
    expect(inferNamedAgentProfile("totally-unrelated")).toBeUndefined();
  });
});

describe("builtinDefaultAgents", () => {
  it("parses the four bundled default agents with valid frontmatter", () => {
    const names = builtinDefaultAgents()
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(["planner", "reviewer", "scout", "worker"]);
    for (const a of builtinDefaultAgents()) {
      expect(a.description).toBeTruthy();
      expect(a.systemPrompt.trim()).toBeTruthy();
    }
  });

  it("gives read-only defaults CodeGraph tools so they do not fall back to bash search", () => {
    const byName = Object.fromEntries(builtinDefaultAgents().map((a) => [a.name, a]));
    for (const name of ["scout", "planner", "reviewer"]) {
      expect(byName[name]?.tools).toEqual(
        expect.arrayContaining(["code_search", "code_explore", "code_node", "code_files"]),
      );
      expect(byName[name]?.systemPrompt).toMatch(/code_\*/);
    }
    expect(byName.worker?.tools).toEqual(expect.arrayContaining(["code_search", "code_explore"]));
  });
});

describe("withBuiltinDefaults", () => {
  it("makes scout/planner/reviewer/worker resolvable when discovery is empty (the bug)", () => {
    const merged = withBuiltinDefaults([]);
    expect(resolveAgent(merged, "worker")?.name).toBe("worker");
    expect(resolveAgent(merged, "scout")?.name).toBe("scout");
    // aliases work through the fallback too
    expect(resolveAgent(merged, "executor")?.name).toBe("worker");
  });

  it("lets a disk agent win on name clash (case-insensitive)", () => {
    const custom: AgentConfig = {
      name: "worker",
      description: "custom worker",
      systemPrompt: "CUSTOM-WORKER-PROMPT",
      source: "project",
      filePath: "/repo/.pi/agents/worker.md",
    };
    const merged = withBuiltinDefaults([custom]);
    expect(merged.filter((a) => a.name.toLowerCase() === "worker")).toHaveLength(1);
    expect(resolveAgent(merged, "worker")?.systemPrompt).toBe("CUSTOM-WORKER-PROMPT");
  });

  it("keeps non-default disk agents and fills in missing defaults", () => {
    const dream: AgentConfig = {
      name: "dream",
      description: "dream",
      systemPrompt: "p",
      source: "user",
      filePath: "/agents/dream.md",
    };
    const merged = withBuiltinDefaults([dream]);
    const names = merged.map((a) => a.name);
    expect(names).toContain("dream");
    expect(names).toContain("worker");
    expect(names).toContain("scout");
  });
});
