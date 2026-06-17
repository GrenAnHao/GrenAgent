// Capability profiles: a composable, declarative description of what a sub-agent
// is allowed to do. Resolves preset + extends + inline overrides into one
// effective profile, then translates it into spawn-time model + child env.
// Pure module (no I/O) so it is fully unit-testable.

export interface CapabilityProfile {
  name?: string;
  /** Tool gating. P0 consumes `deny` only; `allow` is reserved for a later phase. */
  tools?: { allow?: string[]; deny?: string[] };
  /** Filesystem capability: read-only, full workspace, or write-only under prefixes. */
  fs?: "readonly" | "workspace" | { writeAllow: string[] };
  /** Allow web_search / web_fetch / web_crawler. */
  net?: boolean;
  /** MCP: false = off (P0 default); string[] = server allowlist. `true` (full) treated as off in P0. */
  mcp?: boolean | string[];
  /** Allow this sub-agent to itself spawn sub-agents. Reserved (P3 enforces). */
  spawn?: boolean;
  /** Isolation tier. P0 implements `process` only. */
  isolation?: "process" | "worktree" | "sandbox";
  /** Model: provider/id, or alias `cheap` / `strong` resolved via env. */
  model?: string;
  limits?: { timeoutMs?: number; maxConcurrency?: number; tokenBudget?: number };
}

/** Inline profile may reference a preset to extend. */
export type ProfileInput = string | (CapabilityProfile & { extends?: string });

export const PRESETS: Record<string, CapabilityProfile> = {
  default: { name: "default", fs: "workspace", net: true, mcp: false, spawn: false, isolation: "process" },
  explore: { name: "explore", fs: "readonly", net: true, mcp: false, spawn: false, isolation: "process", model: "cheap" },
  planner: {
    name: "planner",
    fs: { writeAllow: ["plans/", "docs/"] },
    net: true,
    mcp: false,
    spawn: false,
    isolation: "process",
    model: "strong",
  },
  // executor writes inside an isolated git worktree (P2); its diff is returned for review.
  executor: { name: "executor", fs: "workspace", net: false, mcp: false, spawn: false, isolation: "worktree", model: "cheap" },
  reviewer: { name: "reviewer", fs: "readonly", net: false, mcp: false, spawn: false, isolation: "process", model: "strong" },
};

function mergeProfile(base: CapabilityProfile, over: CapabilityProfile): CapabilityProfile {
  return {
    ...base,
    ...over,
    name: over.name ?? base.name,
    tools:
      base.tools || over.tools
        ? { allow: over.tools?.allow ?? base.tools?.allow, deny: over.tools?.deny ?? base.tools?.deny }
        : undefined,
    limits: base.limits || over.limits ? { ...base.limits, ...over.limits } : undefined,
  };
}

/** Resolve a profile input into one effective profile (inline > extends > default). */
export function resolveProfile(
  input: ProfileInput | undefined,
  userPresets: Record<string, CapabilityProfile> = {},
): CapabilityProfile {
  const presets = { ...PRESETS, ...userPresets };
  if (input === undefined) return { ...presets.default };
  if (typeof input === "string") return { ...(presets[input] ?? presets.default) };
  const base = input.extends ? presets[input.extends] ?? presets.default : presets.default;
  const { extends: _extends, ...inline } = input;
  return mergeProfile(base, inline);
}

/** Resolve model alias (cheap/strong) via env getter, or pass a literal through. */
export function profileToModel(
  p: CapabilityProfile,
  getEnv: (key: string) => string | undefined,
): string | undefined {
  const m = p.model?.trim();
  if (!m) return undefined;
  if (m === "cheap") return getEnv("SUBAGENT_MODEL_CHEAP")?.trim() || getEnv("SUBAGENT_MODEL")?.trim() || undefined;
  if (m === "strong") return getEnv("SUBAGENT_MODEL_STRONG")?.trim() || getEnv("SUBAGENT_MODEL")?.trim() || undefined;
  return m;
}

/** Translate an effective profile into child-process env consumed by the safety extension. */
export function profileToEnv(p: CapabilityProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (p.fs === "readonly") {
    env.SAFETY_READONLY = "1";
    env.SAFETY_WRITE_ALLOW = "";
  } else if (p.fs && typeof p.fs === "object" && Array.isArray(p.fs.writeAllow)) {
    env.SAFETY_READONLY = "1";
    env.SAFETY_WRITE_ALLOW = p.fs.writeAllow.join(",");
  }
  // NOTE: MCP_SERVERS is intentionally NOT set here. A sub-agent's MCP access
  // depends on the PARENT's MCP_SERVERS (a JSON blob) which this pure transform
  // can't see, so resolveMcpServers(profile.mcp, parentMcp) is applied by the
  // runner when it derives the child runtime config.
  const deny: string[] = [];
  if (p.net === false) deny.push("web_search", "web_fetch", "web_crawler");
  if (p.tools?.deny?.length) deny.push(...p.tools.deny);
  if (deny.length) env.SAFETY_DENY_TOOLS = deny.join(",");
  return env;
}

/** Extract sanitized resource quotas (positive integers only) from a profile. */
export function profileLimits(p: CapabilityProfile): { timeoutMs?: number; maxConcurrency?: number } {
  const t = p.limits?.timeoutMs;
  const c = p.limits?.maxConcurrency;
  return {
    ...(typeof t === "number" && t > 0 ? { timeoutMs: Math.floor(t) } : {}),
    ...(typeof c === "number" && c >= 1 ? { maxConcurrency: Math.floor(c) } : {}),
  };
}

/**
 * Resolve a sub-agent's MCP_SERVERS from its `profile.mcp` and the PARENT's
 * MCP_SERVERS (the JSON blob `{"mcpServers": {...}}` the main agent runs with).
 *
 * On-demand allocation + least privilege — a sub-agent never gets more than the
 * parent already has:
 *   - false / undefined → "" (no MCP; the safe, fast default — each sub-agent is
 *     its own process, so granting MCP means it cold-starts its own stdio servers)
 *   - true              → the parent's full set (same MCP tools as the main agent)
 *   - string[]          → the parent trimmed down to the named servers (config cut)
 *
 * Unknown allowlist names are dropped (can't grant what the parent lacks). Any
 * parse failure falls back to "" (deny) rather than leaking the full set.
 */
export function resolveMcpServers(
  mcp: boolean | string[] | undefined,
  parentMcp: string | undefined,
): string {
  if (!mcp) return "";
  const parent = (parentMcp ?? "").trim();
  if (mcp === true) return parent;
  if (!parent) return "";
  try {
    const obj = JSON.parse(parent) as { mcpServers?: Record<string, unknown> };
    const servers = obj?.mcpServers;
    if (!servers || typeof servers !== "object") return "";
    const allow = new Set(mcp);
    const filtered: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(servers)) {
      if (allow.has(name)) filtered[name] = def;
    }
    return Object.keys(filtered).length ? JSON.stringify({ mcpServers: filtered }) : "";
  } catch {
    return "";
  }
}
