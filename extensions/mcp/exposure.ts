export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

const EXPOSURES = new Set<McpExposure>(["codemode", "deferred", "direct", "hidden"]);

export function normalizeExposure(value: unknown): McpExposure | undefined {
  if (value === undefined) return "codemode";
  if (value === "codemode-deferred") return "codemode";
  if (typeof value === "string" && EXPOSURES.has(value as McpExposure)) return value as McpExposure;
  return undefined;
}



export function exposureForTool(
  toolName: string,
  server: { exposure?: string; toolExposure?: Record<string, string> },
): McpExposure {
  const table = server.toolExposure;
  if (table && Object.prototype.hasOwnProperty.call(table, toolName)) {
    const exact = normalizeListedExposure(table[toolName]);
    if (exact) return exact;
  }
  if (table) {
    for (const [pattern, value] of Object.entries(table)) {
      if (!pattern.includes("*") || !exposurePatternMatches(pattern, toolName)) continue;
      const matched = normalizeListedExposure(value);
      if (matched) return matched;
    }
  }
  return normalizeListedExposure(server.exposure) ?? "codemode";
}



function normalizeListedExposure(value: string | undefined): McpExposure | undefined {
  if (value === undefined) return undefined;
  return normalizeExposure(value);
}

function exposurePatternMatches(pattern: string, toolName: string): boolean {
  const body = pattern.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${body}$`).test(toolName);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
