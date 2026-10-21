// The MCP server list is not injected into the conversation any more.
//
// Earlier versions appended a hidden custom message (`customType: "mcp-servers"`) with lines such as
// "antd codemode" on every run where the list changed. pi sends custom messages to the model as user
// messages right after the user's own text, so the model read the list as part of the request and
// called those servers on prompts that had nothing to do with them. The model still learns of the
// tools where it needs them: the codemode tool description declares codemode servers' tools, direct
// tools are declared as tools, and tool_search finds deferred ones.
//
// Sessions written by those versions still carry the messages; they are left out of the context.
export const LEGACY_SERVERS_MESSAGE = "mcp-servers";

export function isLegacyServersMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as { role?: unknown; customType?: unknown };
  return record.role === "custom" && record.customType === LEGACY_SERVERS_MESSAGE;
}
