// Pure helpers for the mcp extension: parse the MCP_SERVERS JSON config and
// sanitize names for tool registration. No I/O so the logic stays testable.

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asStrRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v))) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// Parse a `{ name: { command/args/env } | { url } }` map. `url` ⇒ SSE, `command` ⇒ stdio.
// Tolerates empty / invalid JSON and entries missing both command and url.
export function parseMcpServers(json: string): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(asRecord(parsed))) {
    const cfg = asRecord(raw);
    const url = typeof cfg.url === "string" ? cfg.url : undefined;
    const command = typeof cfg.command === "string" ? cfg.command : undefined;
    if (url) {
      servers.push({ name, transport: "sse", url });
    } else if (command) {
      servers.push({ name, transport: "stdio", command, args: asStrArray(cfg.args), env: asStrRecord(cfg.env) });
    }
  }
  return servers;
}

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}
