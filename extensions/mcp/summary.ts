// 推给设置页的每个 server 状态。扩展（会话订阅）和重载（manager 直接回报）用同一份形状。
import { definitionChars, type ToolFootprint } from "./definitionSize.js";
import { catalogTools } from "./catalog.js";
import type { McpAuthKind, McpSnapshot, McpStatus } from "./manager.js";
import { exposureForTool, normalizeExposure, type McpExposure } from "./merge.js";

export interface ServerSummary {
  name: string;
  status: McpStatus;
  tools: number;
  toolNames: string[];
  /** Aligned with toolNames; no schema bodies in the status channel. */
  footprints?: ToolFootprint[];
  exposure: McpExposure;
  auth: McpAuthKind;
  loginUrl?: string;
  error?: string;
  attemptedAt?: string;
}

function summaryAuth(auth: string | undefined): McpAuthKind {
  return auth === "oauth" || auth === "provider" ? auth : "none";
}

// 每 server 的 status / 工具数 / 注册全名，加上 exposure、auth，以及需要登录时的 loginUrl。
const sizes = new WeakMap<object, { name: string; chars: number }>();
export function summary(snap: McpSnapshot): ServerSummary[] {
  const taken = new Set<string>();
  return [...snap.servers.entries()].map(([name, e]) => {
    const catalog = catalogTools(name, e.tools, taken);
    const footprints = catalog.map((t, i): ToolFootprint => {
      const def = e.tools[i];
      let size = sizes.get(def);
      if (!size || size.name !== t.fullName) { size = { name: t.fullName, chars: definitionChars(t.fullName, def) }; sizes.set(def, size); }
      return [size.chars, exposureForTool(t.name, e)];
    });
    return {
      name,
      status: e.status,
      tools: e.tools.length,
      toolNames: catalog.map(t => t.fullName),
      ...(footprints.length && { footprints }),
      ...(e.error && { error: e.error }),
      ...(e.diagnostics && { attemptedAt: e.diagnostics.attemptedAt }),
      exposure: normalizeExposure(e.exposure) ?? "codemode",
      auth: summaryAuth(e.auth),
      ...(e.loginUrl ? { loginUrl: e.loginUrl } : {}),
    };
  });
}
