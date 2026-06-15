// Pure policy logic for the mcp-policy extension. No I/O here so the decision
// logic stays unit-testable; all fs / ui side effects live in index.ts.

export type Permission = "auto" | "needs_approval" | "disabled";
export type RulePolicy = "never" | "required" | "always";

export interface Rule {
  match?: Record<string, string>;
  policy: RulePolicy;
}

export interface ToolEntry {
  permission?: Permission;
  rules?: Rule[];
}

export interface Policy {
  version: number;
  defaultPermission: Permission;
  tools: Record<string, ToolEntry>;
  audit: { enabled: boolean };
}

export type Decision =
  | { action: "pass" }
  | { action: "block"; code: "disabled" | "headless"; reason: string }
  | { action: "prompt"; recordable: boolean; summary: string };

const PERMISSIONS: Permission[] = ["auto", "needs_approval", "disabled"];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isPermission(v: unknown): v is Permission {
  return PERMISSIONS.includes(v as Permission);
}

export function parsePolicy(json: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = {};
  }
  const root = asRecord(raw);
  const tools: Record<string, ToolEntry> = {};
  for (const [name, entryRaw] of Object.entries(asRecord(root.tools))) {
    const entry = asRecord(entryRaw);
    const out: ToolEntry = {};
    if (isPermission(entry.permission)) out.permission = entry.permission;
    if (Array.isArray(entry.rules)) {
      const rules: Rule[] = [];
      for (const r of entry.rules) {
        const rr = asRecord(r);
        if (rr.policy === "never" || rr.policy === "required" || rr.policy === "always") {
          const rule: Rule = { policy: rr.policy };
          const matchRaw = asRecord(rr.match);
          if (Object.keys(matchRaw).length > 0) {
            const m: Record<string, string> = {};
            for (const [k, val] of Object.entries(matchRaw)) {
              if (typeof val === "string") m[k] = val;
            }
            rule.match = m;
          }
          rules.push(rule);
        }
      }
      out.rules = rules;
    }
    tools[name] = out;
  }
  const auditRaw = asRecord(root.audit);
  return {
    version: typeof root.version === "number" ? root.version : 1,
    defaultPermission: isPermission(root.defaultPermission) ? root.defaultPermission : "auto",
    tools,
    audit: { enabled: auditRaw.enabled !== false },
  };
}

// Minimal glob: `*` matches any run of characters (including `/`), `?` one char.
// All other regex metacharacters are escaped. Used to test rule patterns.
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

export function matchRules(rules: Rule[] | undefined, args: Record<string, unknown>): RulePolicy | undefined {
  if (!rules) return undefined;
  for (const rule of rules) {
    if (!rule.match) return rule.policy; // bare rule ⇒ catch-all
    const hit = Object.entries(rule.match).every(([k, pat]) => {
      const v = args[k];
      return typeof v === "string" && globMatch(pat, v);
    });
    if (hit) return rule.policy;
  }
  return undefined;
}

// Best-effort danger heuristics: scan the json blob of all args for risky shell
// fragments / system paths / secrets. Intentionally conservative; precise control
// is the user's per-tool rules.
const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  />\s*\/dev\/sd[a-z]/i,
  /\bchmod\b[^\n]*-R[^\n]*\b777\b/i,
  /(^|[\\/"])\/(etc|sys|proc)\//i,
  /[\\/]\.ssh[\\/]/i,
  /\.(pem|key)\b/i,
  /(^|[\\/"])\.env(\.|"|$)/i,
];

export function matchDanger(args: Record<string, unknown>): boolean {
  const blob = JSON.stringify(args ?? {});
  return DANGEROUS.some((re) => re.test(blob));
}

export function summarize(args: Record<string, unknown>, max = 500): string {
  const s = JSON.stringify(args ?? {});
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Priority: disabled > param rule > danger upgrade > tool permission > default.
// Explicit `never` outranks the danger heuristic (user opt-out). Only a pure
// permission=needs_approval prompt (no rule hit) is recordable ("总是允许").
export function decide(
  policy: Policy,
  toolName: string,
  args: Record<string, unknown>,
  hasUI: boolean,
): Decision {
  if (!toolName.startsWith("mcp__")) return { action: "pass" };

  const entry = policy.tools[toolName];
  const perm = entry?.permission ?? policy.defaultPermission ?? "auto";
  if (perm === "disabled") {
    return { action: "block", code: "disabled", reason: "该工具已被禁用，可在 MCP 权限设置中启用" };
  }

  const rulePolicy = matchRules(entry?.rules, args);
  const danger = matchDanger(args);

  let needApproval: boolean;
  let recordable: boolean;
  if (rulePolicy === "never") {
    needApproval = false;
    recordable = false;
  } else if (rulePolicy === "always" || rulePolicy === "required") {
    needApproval = true;
    recordable = false;
  } else {
    needApproval = perm === "needs_approval";
    recordable = needApproval;
  }
  if (danger && rulePolicy !== "never") {
    needApproval = true;
    recordable = false;
  }

  if (!needApproval) return { action: "pass" };
  if (!hasUI) return { action: "block", code: "headless", reason: "需要审批但当前无界面（headless），已阻止" };
  return { action: "prompt", recordable, summary: summarize(args) };
}
