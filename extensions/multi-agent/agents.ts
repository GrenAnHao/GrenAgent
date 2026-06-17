// Named sub-agents discovered from markdown files (aligned with pi's official
// examples/extensions/subagent). Each agent is a `.md` with YAML frontmatter
// (name / description / tools / model) plus a body that becomes its system
// prompt. User agents live in <agentDir>/agents; project agents in the nearest
// .pi/agents up from cwd. Pure-ish (only fs reads), so resolution stays testable.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!existsSync(dir)) return agents;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from cwd to the nearest `.pi/agents` directory (project-local agents). */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** Discover named agents. Default scope "user"; project agents override user on name clash under "both". */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  if (scope === "both") {
    for (const a of userAgents) agentMap.set(a.name, a);
    for (const a of projectAgents) agentMap.set(a.name, a); // project overrides user
  } else if (scope === "user") {
    for (const a of userAgents) agentMap.set(a.name, a);
  } else {
    for (const a of projectAgents) agentMap.set(a.name, a);
  }
  return { agents: [...agentMap.values()], projectAgentsDir };
}
