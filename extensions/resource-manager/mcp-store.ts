import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, watch } from "node:fs";
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "../mcp/config.js";
import { parseMcpServers } from "../mcp/config.js";
import type { AddMcpServerInput, McpScope } from "./validation.js";

export interface McpFileServer { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; }
export interface McpDocument { mcpServers: Record<string, McpFileServer>; disabledMcpServers: Record<string, McpFileServer>; }
const empty = (): McpDocument => ({ mcpServers: {}, disabledMcpServers: {} });
const asMap = (v: unknown): Record<string, McpFileServer> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, McpFileServer> : {};

export function mcpConfigPaths(cwd: string, home = homedir()) {
  return { global: join(home, ".pi", "agent", "mcp.json"), project: join(cwd, ".pi", "mcp.json") } as const;
}
export async function readMcpDocument(path: string): Promise<McpDocument> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw new Error("读取 MCP 配置失败 (" + path + "): " + String(e)); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("MCP 配置 JSON 损坏: " + path); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP 配置必须是对象: " + path);
  const root = parsed as Record<string, unknown>;
  if (root.mcpServers !== undefined && (typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))) throw new Error("mcpServers 必须是对象: " + path);
  if (root.disabledMcpServers !== undefined && (typeof root.disabledMcpServers !== "object" || Array.isArray(root.disabledMcpServers))) throw new Error("disabledMcpServers 必须是对象: " + path);
  return { mcpServers: asMap(root.mcpServers), disabledMcpServers: asMap(root.disabledMcpServers) };
}
function toConfig(name: string, c: McpFileServer): McpServerConfig | undefined {
  if (typeof c.url === "string") return { name, transport: "sse", url: c.url };
  if (typeof c.command === "string") return { name, transport: "stdio", command: c.command, args: c.args ?? [], env: c.env, cwd: c.cwd };
  return undefined;
}
export async function readLayeredMcpServers(cwd: string, desktopJson: string, home = homedir()): Promise<McpServerConfig[]> {
  const result = new Map<string, McpServerConfig>();
  for (const s of parseMcpServers(desktopJson)) result.set(s.name, s);
  const paths = mcpConfigPaths(cwd, home);
  for (const path of [paths.global, paths.project]) {
    const doc = await readMcpDocument(path);
    for (const [name, config] of Object.entries(doc.mcpServers)) { const s = toConfig(name, config); if (s) result.set(name, s); }
  }
  return [...result.values()];
}
export function readLayeredMcpServersSync(cwd: string, desktopJson: string, home = homedir()): McpServerConfig[] {
  const result = new Map<string, McpServerConfig>();
  for (const s of parseMcpServers(desktopJson)) result.set(s.name, s);
  const paths = mcpConfigPaths(cwd, home);
  for (const path of [paths.global, paths.project]) {
    let doc: McpDocument;
    try { doc = JSON.parse(readFileSync(path, "utf8")) as McpDocument; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const [name, config] of Object.entries(asMap(doc.mcpServers))) { const s = toConfig(name, config); if (s) result.set(name, s); }
  }
  return [...result.values()];
}
export function watchMcpConfigFiles(cwd: string, onChange: () => void, home = homedir()): () => void {
  const paths = mcpConfigPaths(cwd, home);
  const watchers = [dirname(paths.global), dirname(paths.project)].map((dir) => {
    try { return watch(dir, () => onChange()); } catch { return undefined; }
  }).filter(Boolean) as import("node:fs").FSWatcher[];
  return () => watchers.forEach((w) => w.close());
}
export async function findMcpConflict(name: string, cwd: string, desktopJson: string, home = homedir()): Promise<McpScope | "settings" | undefined> {
  if (parseMcpServers(desktopJson).some((s) => s.name === name)) return "settings";
  const paths = mcpConfigPaths(cwd, home);
  if (Object.prototype.hasOwnProperty.call((await readMcpDocument(paths.project)).mcpServers, name)) return "project";
  if (Object.prototype.hasOwnProperty.call((await readMcpDocument(paths.global)).mcpServers, name)) return "global";
  return undefined;
}
export async function writeMcpServer(input: AddMcpServerInput, cwd: string, home = homedir(), desktopJson = ""): Promise<string> {
  const paths = mcpConfigPaths(cwd, home); const path = paths[input.scope]; const doc = await readMcpDocument(path);
  const conflict = await findMcpConflict(input.name, cwd, desktopJson, home);
  if (conflict && !input.replace) throw new Error("MCP \"" + input.name + "\" 已存在，请显式设置 replace=true");
  const config: McpFileServer = input.transport === "sse" ? { url: input.url } : { command: input.command, args: input.args ?? [], env: input.env, cwd: input.cwd };
  doc.mcpServers[input.name] = config; delete doc.disabledMcpServers[input.name];
  await mkdir(dirname(path), { recursive: true }); const tmp = path + "." + randomUUID() + ".tmp";
  try { await writeFile(tmp, JSON.stringify({ mcpServers: doc.mcpServers, ...(Object.keys(doc.disabledMcpServers).length ? { disabledMcpServers: doc.disabledMcpServers } : {}) }, null, 2), { mode: 0o600 }); await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
  return path;
}
