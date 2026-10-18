// Which still-connecting MCP servers a tool call has to wait for (pi 1.2 `ToolDefinition.reachesTools`).
//
// codemode and tool_search declare `reachesTools`: codemode answers "all" when the script uses a
// discovery global (searchTools / describeNamespace / describeTool / ALL_TOOLS) and otherwise the
// words of its source; tool_search always answers "all". Matching is the same as pi's built-in MCP
// extension (`reachesServer`): a server is reached when a word contains its namespace `mcp__<server>`.
// The words come from the raw source, comments and strings included, so they may over-match; that
// only costs a wait while the server is still connecting, never a wrong result.
import { sanitize } from "./config.js";

export type ToolReach = "all" | readonly string[];

/**
 * The namespace prefix as it appears in a script: `mcp__<server>` written like the tool names. For
 * the names pi accepts ([A-Za-z0-9_-]) this is pi's `mcpNamespace(server)` (`-` becomes `_`).
 */
function serverNamespace(server: string): string {
  return `mcp__${sanitize(server)}`;
}

export function reachesServer(reach: ToolReach, server: string): boolean {
  if (reach === "all") return true;
  const namespace = serverNamespace(server);
  return reach.some((word) => word.includes(namespace));
}

/**
 * Servers among `connecting` that the call must wait for. A tool with `reachesTools` waits for the
 * servers it may reach; the resource tools take a server argument and wait for all of them; an MCP
 * tool waits for its own server (a reconnect that is still closing the old transport).
 */
export function serversToWait(input: {
  toolName: string;
  reach: ToolReach | undefined;
  connecting: readonly string[];
  /** Tools that take a server argument (the MCP resource tools). */
  resourceTools: readonly string[];
}): string[] {
  const { toolName, reach, connecting, resourceTools } = input;
  if (connecting.length === 0) return [];
  if (reach !== undefined) return connecting.filter((server) => reachesServer(reach, server));
  if (resourceTools.includes(toolName)) return [...connecting];
  return connecting.filter((server) => toolName.startsWith(`mcp__${sanitize(server)}__`));
}
