function replaceOnce(source, needle, replacement, label) {
  if (source.split(needle).length !== 2) {
    throw new Error(`unexpected TencentDB upstream layout while patching ${label}`);
  }
  return source.replace(needle, replacement);
}

function stdinShutdownBridge(shutdownCall) {
  return [
    "  let stdinShutdownRequested = false;",
    "  const shutdownOnStdinClose = () => {",
    "    if (stdinShutdownRequested) return;",
    "    stdinShutdownRequested = true;",
    '    console.info("managed runtime stdin closed");',
    `    void ${shutdownCall};`,
    "  };",
    '  process.stdin.once("end", shutdownOnStdinClose);',
    '  process.stdin.once("close", shutdownOnStdinClose);',
    "  process.stdin.resume();",
  ].join("\n");
}

export function patchCoreStdinShutdown(source) {
  const needle = [
    '  process.on("SIGINT", shutdown);',
    '  process.on("SIGTERM", shutdown);',
    "",
    "  await gateway.start();",
  ].join("\n");
  return replaceOnce(
    source,
    needle,
    [
      '  process.on("SIGINT", shutdown);',
      '  process.on("SIGTERM", shutdown);',
      "",
      stdinShutdownBridge('shutdown("SIGTERM")'),
      "",
      "  await gateway.start();",
    ].join("\n"),
    "MemoryCore stdin shutdown",
  );
}

export function patchCoreManagedIdentityBootstrap({ schema, types, service }) {
  const patchedSchema = replaceOnce(
    schema,
    [
      "export const initAdminSchema = z.object({",
      "  username: nonEmpty,",
      "  user_key: z.string().min(1).optional(),",
      "});",
    ].join("\n"),
    [
      "export const initAdminSchema = z.object({",
      "  username: nonEmpty,",
      "  user_key: z.string().min(1).optional(),",
      "  user_id: z.string().min(1).optional(),",
      "  team_id: z.string().min(1).optional(),",
      "  agent_id: z.string().min(1).optional(),",
      "});",
    ].join("\n"),
    "managed identity bootstrap schema",
  );
  const patchedTypes = replaceOnce(
    types,
    [
      "export interface InitAdminInput {",
      "  username: string;",
      "  user_key?: string;",
      "}",
    ].join("\n"),
    [
      "export interface InitAdminInput {",
      "  username: string;",
      "  user_key?: string;",
      "  user_id?: string;",
      "  team_id?: string;",
      "  agent_id?: string;",
      "}",
    ].join("\n"),
    "managed identity bootstrap types",
  );
  let patchedService = replaceOnce(
    service,
    [
      "    const created = await this.createUserWithType(",
      "      { username: input.username, default_key_value: input.user_key },",
      '      "system_admin",',
      "    );",
    ].join("\n"),
    [
      "    const created = await this.createUserWithType(",
      "      { user_id: input.user_id, username: input.username, default_key_value: input.user_key },",
      '      "system_admin",',
      "    );",
    ].join("\n"),
    "managed identity user ID",
  );
  patchedService = replaceOnce(
    patchedService,
    "      const team = await this.createTeam({\n        name: DEFAULT_TEAM_NAME,",
    "      const team = await this.createTeam({\n        team_id: input.team_id,\n        name: DEFAULT_TEAM_NAME,",
    "managed identity team ID",
  );
  patchedService = replaceOnce(
    patchedService,
    "        await this.createAgent({\n          team_id: team.team_id,",
    "        await this.createAgent({\n          agent_id: input.agent_id,\n          team_id: team.team_id,",
    "managed identity agent ID",
  );
  return { schema: patchedSchema, types: patchedTypes, service: patchedService };
}

export function patchKnowledgeStdinShutdown(source) {
  const needle = [
    '  process.once("SIGTERM", () => void shutdown("SIGTERM"));',
    '  process.once("SIGINT", () => void shutdown("SIGINT"));',
  ].join("\n");
  return replaceOnce(
    source,
    needle,
    [needle, stdinShutdownBridge('shutdown("stdin EOF")')].join("\n"),
    "MemoryKnowledge stdin shutdown",
  );
}

const knowledgeApiAuthHelper = `
function knowledgeApiAuth(): MiddlewareHandler {
  const configuredToken = process.env.KNOWLEDGE_API_TOKEN?.trim();
  if (!configuredToken) throw new Error("KNOWLEDGE_API_TOKEN is required");
  const expectedToken = Buffer.from(configuredToken, "utf8");

  return async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Bearer\\s+(.+)$/i.exec(authorization);
    const providedToken = Buffer.from(match?.[1] ?? "", "utf8");
    if (
      providedToken.length !== expectedToken.length ||
      !timingSafeEqual(providedToken, expectedToken)
    ) {
      return c.json(wrapError(401, "unauthorized"), 401);
    }
    await next();
  };
}
`.trim();

export function patchKnowledgeApiAuth(source) {
  let patched = replaceOnce(
    source,
    'import { Hono } from "hono";',
    [
      'import { Hono, type MiddlewareHandler } from "hono";',
      'import { timingSafeEqual } from "node:crypto";',
    ].join("\n"),
    "MemoryKnowledge auth imports",
  );
  patched = replaceOnce(
    patched,
    'import { accessLog } from "./middleware/response-envelope.js";',
    [
      'import { accessLog } from "./middleware/response-envelope.js";',
      'import { wrapError } from "./api-helpers.js";',
    ].join("\n"),
    "MemoryKnowledge auth envelope",
  );
  patched = replaceOnce(
    patched,
    "export function createApp() {",
    `${knowledgeApiAuthHelper}\n\nexport function createApp() {`,
    "MemoryKnowledge auth middleware",
  );
  return replaceOnce(
    patched,
    "  const api = new Hono();",
    '  const api = new Hono();\n  api.use("*", knowledgeApiAuth());',
    "MemoryKnowledge protected routes",
  );
}

export function patchKnowledgeMcpHttpClient(source) {
  let patched = replaceOnce(
    source,
    "  token?: string;\n}",
    [
      "  token?: string;",
      "  /** Current user identity required by every MemoryKnowledge route. */",
      "  userKey?: string;",
      "  /** Tenant identity required by every MemoryKnowledge route. */",
      "  serviceId?: string;",
      "  /** Current workspace assets used when the model omits an explicit ID. */",
      "  defaultCodeGraphId?: string;",
      "  defaultWikiId?: string;",
      "}",
    ].join("\n"),
    "MCP client options",
  );
  patched = replaceOnce(
    patched,
    '  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;',
    [
      '  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;',
      '  if (opts.userKey) headers["x-tdai-user-key"] = opts.userKey;',
      '  if (opts.serviceId) headers["x-tdai-service-id"] = opts.serviceId;',
    ].join("\n"),
    "MCP tenant header",
  );
  return patched;
}

const serverHelpers = `
function assetIdField(endpoint: string): "code_graph_id" | "wiki_id" | undefined {
  if (endpoint.startsWith("/code-graph/")) return "code_graph_id";
  if (endpoint.startsWith("/wiki/")) return "wiki_id";
  return undefined;
}

function defaultAssetId(tool: McpToolDef, opts: HttpClientOptions): string | undefined {
  const field = assetIdField(tool.endpoint);
  return field === "code_graph_id" ? opts.defaultCodeGraphId : field === "wiki_id" ? opts.defaultWikiId : undefined;
}

function schemaWithAssetDefault(tool: McpToolDef, opts: HttpClientOptions): McpToolDef["inputSchema"] {
  const field = assetIdField(tool.endpoint);
  if (!field || !defaultAssetId(tool, opts)) return tool.inputSchema;
  return { ...tool.inputSchema, required: tool.inputSchema.required.filter((name) => name !== field) };
}

function argumentsWithAssetDefault(
  tool: McpToolDef,
  args: Record<string, unknown> | undefined,
  opts: HttpClientOptions,
): Record<string, unknown> {
  const body = { ...(args ?? {}) };
  const field = assetIdField(tool.endpoint);
  const fallback = defaultAssetId(tool, opts);
  if (field && fallback) body[field] = fallback;
  return body;
}
`;

export function patchKnowledgeMcpServer(source) {
  let patched = replaceOnce(
    source,
    "export function createMcpServer(httpOpts: HttpClientOptions): Server {",
    `${serverHelpers}\nexport function createMcpServer(httpOpts: HttpClientOptions): Server {`,
    "MCP default helpers",
  );
  patched = replaceOnce(
    patched,
    "        inputSchema: t.inputSchema,",
    "        inputSchema: schemaWithAssetDefault(t, httpOpts),",
    "MCP tool schemas",
  );
  patched = replaceOnce(
    patched,
    "    const body = (args ?? {}) as Record<string, unknown>;",
    "    const body = argumentsWithAssetDefault(tool, args as Record<string, unknown> | undefined, httpOpts);",
    "MCP tool arguments",
  );
  patched = replaceOnce(
    patched,
    "  const token = process.env.KNOWLEDGE_API_TOKEN;",
    [
      "  const token = process.env.KNOWLEDGE_API_TOKEN;",
      "  const userKey = process.env.KNOWLEDGE_USER_KEY;",
      "  const serviceId = process.env.TDAI_KNOWLEDGE_SERVICE_ID || process.env.KNOWLEDGE_SERVICE_ID || process.env.TDAI_MEMORY_SERVICE_ID;",
      "  const defaultCodeGraphId = process.env.TDAI_CODE_GRAPH_ID;",
      "  const defaultWikiId = process.env.TDAI_WIKI_ID;",
    ].join("\n"),
    "MCP environment defaults",
  );
  patched = replaceOnce(
    patched,
    "  const server = createMcpServer({ baseUrl, token });",
    "  const server = createMcpServer({ baseUrl, token, userKey, serviceId, defaultCodeGraphId, defaultWikiId });",
    "MCP server options",
  );
  return patched;
}

export function patchKnowledgeSourceRegistry(source) {
  let patched = replaceOnce(
    source,
    'import { GitSourceFetcher } from "./git-fetcher.js";',
    [
      'import { GitSourceFetcher } from "./git-fetcher.js";',
      'import { LocalSourceFetcher } from "./local-fetcher.js";',
    ].join("\n"),
    "local source import",
  );
  patched = replaceOnce(
    patched,
    "    this.register(new GitSourceFetcher());\n    // 未来：this.register(new LocalSourceFetcher());",
    "    this.register(new GitSourceFetcher());\n    this.register(new LocalSourceFetcher());",
    "local source registration",
  );
  patched = replaceOnce(
    patched,
    '    if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("./")) {',
    '    if (url.startsWith("file://") || (url.startsWith("/") && !url.startsWith("//")) || /^[A-Za-z]:[\\\\/]/.test(url)) {',
    "local source detection",
  );
  return patched;
}

export function patchKnowledgeWikiWindowsContainment(source) {
  let patched = replaceOnce(
    source,
    'import { join, resolve, normalize } from "node:path";',
    'import { join, resolve, normalize, sep } from "node:path";',
    "Wiki path separator import",
  );
  patched = replaceOnce(
    patched,
    '    const dirWithSep = base.endsWith("/") ? base : base + "/";',
    "    const dirWithSep = base.endsWith(sep) ? base : base + sep;",
    "Wiki raw path containment",
  );
  patched = replaceOnce(
    patched,
    '    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";',
    "    const wikiDirSep = wikiDir.endsWith(sep) ? wikiDir : wikiDir + sep;",
    "Wiki page path containment",
  );
  patched = replaceOnce(
    patched,
    '    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";',
    "    const prefix = wikiDir.endsWith(sep) ? wikiDir : wikiDir + sep;",
    "Wiki page ref containment",
  );
  return patched;
}

export const localSourceFetcherSource = `/**
 * Local workspace fetcher for the managed desktop runtime.
 * It is never selected for remote Knowledge endpoints: the desktop only sends
 * local paths to the loopback service it owns.
 */
import { cp, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import simpleGit from "simple-git";

import type { FetchResult, ISourceFetcher, SourceType } from "./types.js";

const SKIPPED = new Set([".git", ".codegraph", "node_modules", "target", "dist", "build", ".next"]);

function isNetworkPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(await canonicalDestination(parent), basename(path));
}

async function readAllowedSources(): Promise<Set<string>> {
  const allowListPath = process.env.TDAI_LOCAL_SOURCE_ALLOWLIST;
  if (!allowListPath) throw new Error("TDAI_LOCAL_SOURCE_ALLOWLIST is required for local sources");
  const allowedSources = new Set<string>();
  const lines = (await readFile(allowListPath, "utf8")).split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(\`invalid local source allow-list JSONL at line \${index + 1}\`);
    }
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(\`local source allow-list entry must be a path string at line \${index + 1}\`);
    }
    allowedSources.add(entry);
  }
  return allowedSources;
}

export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";

  validate(sourceUrl: string): void {
    const path = this.path(sourceUrl);
    if (!isAbsolute(path)) throw new Error(\`local source must be absolute: \${sourceUrl}\`);
  }

  async fetch(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const sourcePath = await realpath(this.path(sourceUrl));
    const allowedSources = await readAllowedSources();
    if (!allowedSources.has(sourcePath)) throw new Error(\`local source is not allow-listed: \${sourcePath}\`);
    const metadata = await stat(sourcePath);
    if (!metadata.isDirectory()) throw new Error(\`local source is not a directory: \${sourcePath}\`);
    const destination = resolve(localPath);
    const canonical = await canonicalDestination(destination);
    if (
      isSameOrInside(sourcePath, destination) ||
      isSameOrInside(sourcePath, canonical) ||
      isSameOrInside(destination, sourcePath) ||
      isSameOrInside(canonical, sourcePath)
    ) {
      throw new Error("local CodeGraph destination must not overlap the workspace");
    }
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(sourcePath, destination, {
      recursive: true,
      dereference: false,
      filter: async (candidate) => {
        const parts = relative(sourcePath, candidate).split(/[\\\\/]/).filter(Boolean);
        if (parts.some((part) => SKIPPED.has(part))) return false;
        return !(await lstat(candidate)).isSymbolicLink();
      },
    });
    let version: string | null = null;
    try { version = (await simpleGit(sourcePath).revparse(["HEAD"])).trim().slice(0, 12) || null; } catch { /* non-git workspace */ }
    return { localPath: destination, version, sourceType: "local" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    return this.fetch(sourceUrl, branch, localPath);
  }

  private path(sourceUrl: string): string {
    if (sourceUrl.startsWith("file://")) {
      const url = new URL(sourceUrl);
      if (url.hostname && url.hostname !== "localhost") {
        throw new Error(\`local source must not be a network path: \${sourceUrl}\`);
      }
      const path = fileURLToPath(url);
      if (isNetworkPath(path)) throw new Error(\`local source must not be a network path: \${sourceUrl}\`);
      return path;
    }
    if (isNetworkPath(sourceUrl)) throw new Error(\`local source must not be a network path: \${sourceUrl}\`);
    if (!isAbsolute(sourceUrl)) throw new Error(\`local source must be absolute: \${sourceUrl}\`);
    return sourceUrl;
  }
}
`;
