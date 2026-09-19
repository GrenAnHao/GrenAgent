import type { McpServerConfig } from "./config.js";

export interface ServerDiff {
  added: McpServerConfig[];
  removed: string[]; // names
  changed: McpServerConfig[]; // 配置变化（需先断后连）
}

function sig(s: McpServerConfig): string {
  return JSON.stringify({ t: s.transport, c: s.command, a: s.args, u: s.url, e: s.env, w: s.cwd, h: s.headers });
}

export function diffServers(prev: McpServerConfig[], next: McpServerConfig[]): ServerDiff {
  const prevByName = new Map(prev.map((s) => [s.name, s]));
  const nextByName = new Map(next.map((s) => [s.name, s]));
  const added: McpServerConfig[] = [];
  const changed: McpServerConfig[] = [];
  for (const s of next) {
    const p = prevByName.get(s.name);
    if (!p) added.push(s);
    else if (sig(p) !== sig(s)) changed.push(s);
  }
  const removed = prev.filter((s) => !nextByName.has(s.name)).map((s) => s.name);
  return { added, removed, changed };
}
