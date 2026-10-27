// 推给设置页的每个 server 状态。扩展（会话订阅）和重载（manager 直接回报）用同一份形状。
import { sanitize } from "./config.js";
import type { McpAuthKind, McpSnapshot } from "./manager.js";
import { normalizeExposure, type McpExposure } from "./merge.js";

export interface ServerSummary {
  name: string;
  status: string;
  tools: number;
  toolNames: string[];
  exposure: McpExposure;
  auth: McpAuthKind;
  loginUrl?: string;
}

function summaryAuth(auth: string | undefined): McpAuthKind {
  return auth === "oauth" || auth === "provider" ? auth : "none";
}

// 每 server 的 status / 工具数 / 注册全名，加上 exposure、auth，以及需要登录时的 loginUrl。
export function summary(snap: McpSnapshot): ServerSummary[] {
  return [...snap.servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.length,
    toolNames: e.tools.map((t) => `mcp__${sanitize(name)}__${sanitize(t.name)}`),
    exposure: normalizeExposure(e.exposure) ?? "codemode",
    auth: summaryAuth(e.auth),
    ...(e.loginUrl ? { loginUrl: e.loginUrl } : {}),
  }));
}
