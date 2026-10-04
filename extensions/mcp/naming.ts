import { createHash } from "node:crypto";
import { sanitize } from "./config.js";

export function registerToolName(
  server: string,
  tool: string,
  taken: Set<string>,
): { name: string; originalToolName: string } {
  let name = `mcp__${sanitize(server)}__${sanitize(tool)}`;

  if (name.length > 64 || taken.has(name)) {
    const hash = createHash("sha256")
      .update(server + "\0" + tool)
      .digest("hex")
      .slice(0, 8);
    name = `${name.slice(0, 55)}_${hash}`;
  }

  return { name, originalToolName: tool };
}

export function serverNamesConflict(a: string, b: string): boolean {
  return a.replace(/-/g, "_") === b.replace(/-/g, "_");
}
