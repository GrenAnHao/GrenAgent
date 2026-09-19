import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { remoteTransportKind, type McpServerConfig } from "./config.js";

export function remoteRequestInit(headers?: Record<string, string>): { requestInit?: RequestInit } {
  if (!headers) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    if (name && typeof value === "string") clean[name] = value;
  }
  if (Object.keys(clean).length === 0) return {};
  return { requestInit: { headers: clean } };
}

export function createMcpTransport(s: McpServerConfig): Transport {
  if (s.transport === "stdio" || !s.url) {
    return new StdioClientTransport({
      command: s.command ?? "",
      args: s.args ?? [],
      ...(s.cwd ? { cwd: s.cwd } : {}),
      env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
    });
  }
  const opts = remoteRequestInit(s.headers);
  const kind = s.transport === "sse" ? "sse" : remoteTransportKind(s.url);
  if (kind === "sse") return new SSEClientTransport(new URL(s.url), opts);
  return new StreamableHTTPClientTransport(new URL(s.url), opts);
}
