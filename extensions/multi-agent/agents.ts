// Named sub-agents discovered from markdown files (aligned with pi's official
// examples/extensions/subagent). Each agent is a `.md` with YAML frontmatter
// (name / description / tools / model) plus a body that becomes its system
// prompt. User agents live in <agentDir>/agents; project agents in the nearest
// .pi/agents up from cwd. Pure-ish (only fs reads), so resolution stays testable.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT_TEMPLATES } from "../fable-behavior/default-agents.js";

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

/**
 * Discover named agents. Default scope "user"; project agents override user on name clash under "both".
 *
 * 安全提示：project agent 来自仓库内 `.pi/agents/*.md`——其 body 会成为子代理 system prompt、
 * frontmatter.tools 会成为子代理工具白名单。clone 不可信仓库时，恶意 agent 定义可借此影响
 * 子代理行为，故默认 scope "user"（不读仓库内定义）是安全默认；仅在确认仓库可信后才用 "both"/"project"。
 */
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

let builtinCache: AgentConfig[] | undefined;

/**
 * Built-in default agents (scout/planner/reviewer/worker) parsed from the bundled
 * `DEFAULT_AGENT_TEMPLATES`. These ship inside the binary, so they are available
 * regardless of disk state — used as a resolution fallback so a request for a known
 * default never hard-fails when discovery is empty (project scope with no repo
 * agents, cold start before seeding, a deleted/relocated agent dir). Memoized:
 * templates are static constants.
 */
export function builtinDefaultAgents(): AgentConfig[] {
  if (builtinCache) return builtinCache;
  const out: AgentConfig[] = [];
  for (const [name, content] of Object.entries(DEFAULT_AGENT_TEMPLATES)) {
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source: "user",
      filePath: `<builtin:${name}>`,
    });
  }
  builtinCache = out;
  return out;
}

/**
 * Union discovered agents with the built-in defaults; disk-discovered agents win on
 * name clash (case-insensitive), so user/project customizations always take
 * precedence and only MISSING defaults are filled in. Built-ins are bundled and
 * trusted (they never read an untrusted repo), so this is safe to apply under any
 * `agentScope` — it guarantees scout/planner/reviewer/worker stay resolvable even
 * when discovery returns nothing.
 */
export function withBuiltinDefaults(discovered: AgentConfig[]): AgentConfig[] {
  const have = new Set(discovered.map((a) => a.name.toLowerCase()));
  const merged = [...discovered];
  for (const d of builtinDefaultAgents()) {
    if (!have.has(d.name.toLowerCase())) merged.push(d);
  }
  return merged;
}

// Semantic aliases for the default seeded agents (scout/planner/reviewer/worker).
// Models routinely guess a synonym for the role they want — most commonly
// "explorer"/"explore" for the recon agent (which is actually `scout`, and which
// collides lexically with the `explore` capability *profile*). Mapping canonical
// agent name → accepted aliases (all lowercase) lets resolveAgent recover instead
// of hard-failing the whole spawn. An alias only resolves when its canonical
// target is actually present among the discovered agents, so user customizations
// (renames/deletions) never get silently overridden.
export const AGENT_ALIASES: Record<string, string[]> = {
  scout: ["explorer", "explore", "exploration", "researcher", "research", "recon", "finder", "search", "investigator"],
  planner: ["plan", "planning", "architect", "designer", "design"],
  reviewer: ["review", "code-reviewer", "code_reviewer", "codereviewer", "critic", "qa", "auditor"],
  worker: ["executor", "execute", "implementer", "implement", "general", "builder", "build", "coder", "developer", "dev"],
};

/** Classic Levenshtein edit distance (small inputs — agent names). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Resolve a requested agent name to a discovered agent, tolerant of the natural
 * variations a model produces. Resolution order (first hit wins):
 *   1. exact name match
 *   2. case-insensitive / trimmed match
 *   3. semantic alias (AGENT_ALIASES) whose canonical target is present
 * Returns undefined when nothing matches (caller renders a helpful error).
 */
export function resolveAgent(agents: AgentConfig[], rawName: string): AgentConfig | undefined {
  const name = rawName.trim();
  if (!name) return undefined;

  const exact = agents.find((a) => a.name === name);
  if (exact) return exact;

  const lower = name.toLowerCase();
  const ci = agents.find((a) => a.name.toLowerCase() === lower);
  if (ci) return ci;

  for (const [canonical, aliases] of Object.entries(AGENT_ALIASES)) {
    if (canonical === lower || aliases.includes(lower)) {
      const target = agents.find((a) => a.name.toLowerCase() === canonical);
      if (target) return target;
    }
  }
  return undefined;
}

/**
 * Best-effort "did you mean" suggestion for an unresolved agent name. Considers
 * both discovered agent names and alias terms (mapped back to their canonical
 * agent), returning the closest present agent name within a small edit-distance
 * budget, or undefined when nothing is close enough.
 */
export function suggestAgent(agents: AgentConfig[], rawName: string): string | undefined {
  const name = rawName.trim().toLowerCase();
  if (!name || agents.length === 0) return undefined;

  // candidate term -> canonical agent name to suggest
  const candidates: Array<{ term: string; agentName: string }> = [];
  for (const a of agents) {
    candidates.push({ term: a.name.toLowerCase(), agentName: a.name });
    const aliases = AGENT_ALIASES[a.name.toLowerCase()];
    if (aliases) for (const al of aliases) candidates.push({ term: al, agentName: a.name });
  }

  let best: { agentName: string; dist: number } | undefined;
  for (const c of candidates) {
    const dist = c.term.includes(name) || name.includes(c.term) ? 0 : editDistance(name, c.term);
    if (!best || dist < best.dist) best = { agentName: c.agentName, dist };
  }
  if (!best) return undefined;
  const budget = Math.max(2, Math.floor(name.length / 3));
  return best.dist <= budget ? best.agentName : undefined;
}
