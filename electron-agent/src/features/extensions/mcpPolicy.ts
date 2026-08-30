export type Perm = 'auto' | 'needs_approval' | 'disabled';
export type RulePolicy = 'never' | 'required' | 'always';

export interface RuleItem {
  match?: Record<string, string>;
  policy: RulePolicy;
}

export interface AuditEntry {
  ts: string;
  server: string;
  tool: string;
  decision: string;
  argsDigest: string;
}

const PERMS: Perm[] = ['auto', 'needs_approval', 'disabled'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parsePolicyDoc(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

function toolsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.tools) ? raw.tools : {};
}

export function getToolPerm(raw: Record<string, unknown>, fullName: string): Perm {
  const entry = toolsOf(raw)[fullName];
  const p = isRecord(entry) ? entry.permission : undefined;
  return PERMS.includes(p as Perm) ? (p as Perm) : 'auto';
}

export function getToolRules(raw: Record<string, unknown>, fullName: string): RuleItem[] {
  const entry = toolsOf(raw)[fullName];
  const rules = isRecord(entry) && Array.isArray(entry.rules) ? entry.rules : [];
  return rules.filter(isRecord).map((r): RuleItem => {
    const policy = r.policy === 'never' || r.policy === 'required' || r.policy === 'always' ? r.policy : 'required';
    const item: RuleItem = { policy };
    if (isRecord(r.match)) {
      const m: Record<string, string> = {};
      for (const [k, val] of Object.entries(r.match)) if (typeof val === 'string') m[k] = val;
      item.match = m;
    }
    return item;
  });
}

function ensureEntry(raw: Record<string, unknown>, fullName: string): {
  next: Record<string, unknown>;
  entry: Record<string, unknown>;
} {
  const next = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const tools = isRecord(next.tools) ? next.tools : {};
  const entry = isRecord(tools[fullName]) ? (tools[fullName] as Record<string, unknown>) : {};
  tools[fullName] = entry;
  next.tools = tools;
  return { next, entry };
}

export function setToolPerm(raw: Record<string, unknown>, fullName: string, perm: Perm): Record<string, unknown> {
  const { next, entry } = ensureEntry(raw, fullName);
  entry.permission = perm;
  return next;
}

export function setToolRules(raw: Record<string, unknown>, fullName: string, rules: RuleItem[]): Record<string, unknown> {
  const { next, entry } = ensureEntry(raw, fullName);
  if (rules.length === 0) delete entry.rules;
  else entry.rules = rules;
  return next;
}

export function serializePolicyDoc(raw: Record<string, unknown>): string {
  return JSON.stringify(raw, null, 2);
}

export function parseAuditLines(text: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (isRecord(v)) {
        out.push({
          ts: String(v.ts ?? ''),
          server: String(v.server ?? ''),
          tool: String(v.tool ?? ''),
          decision: String(v.decision ?? ''),
          argsDigest: String(v.argsDigest ?? ''),
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export function shortToolName(fullName: string): string {
  const rest = fullName.startsWith('mcp__') ? fullName.slice(5) : fullName;
  const i = rest.indexOf('__');
  return i >= 0 ? rest.slice(i + 2) : rest;
}
