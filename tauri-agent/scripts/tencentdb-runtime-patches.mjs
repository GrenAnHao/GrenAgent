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

export function patchPanelStdinShutdown(source) {
  if (source.includes("managed runtime stdin closed")) return source;
  const handlers = [...source.matchAll(/process\.on\((['"])SIG(?:INT|TERM)\1,\s*shutdown\);/g)];
  if (handlers.length < 2) {
    throw new Error("unexpected TencentDB upstream layout while patching MemoryPanel stdin shutdown");
  }
  const last = handlers[handlers.length - 1];
  const end = (last.index ?? 0) + last[0].length;
  const bridge = [
    "",
    "  let stdinShutdownRequested = false;",
    "  const shutdownOnStdinClose = () => {",
    "    if (stdinShutdownRequested) return;",
    "    stdinShutdownRequested = true;",
    '    console.info("managed runtime stdin closed");',
    "    process.exit(0);",
    "  };",
    '  process.stdin.once("end", shutdownOnStdinClose);',
    '  process.stdin.once("close", shutdownOnStdinClose);',
    "  process.stdin.resume();",
  ].join("\n");
  return source.slice(0, end) + bridge + source.slice(end);
}

export function patchPanelMetaLogRedaction(source) {
  if (source.includes("TDAI_PANEL_LOG_REDACTION_V1")) return source;
  const needle = `function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return \`${"${value}"}…\`;
  return \`${"${value.slice(0, 8)}"}…\`;
}`;
  const replacement = `// TDAI_PANEL_LOG_REDACTION_V1: credentials never appear in Panel logs.
function maskSecret(_value: string): string {
  return "[redacted]";
}`;
  return replaceOnce(source, needle, replacement, "MemoryPanel metadata log redaction");
}

export function patchPanelInstanceRegistry(source) {
  if (source.includes("TDAI_PANEL_INSTANCES_JSON")) return source;
  const needle = /static load\(configPath[^)]*\)[^{]*\{/;
  const match = needle.exec(source);
  if (!match) {
    throw new Error("unexpected TencentDB upstream layout while patching MemoryPanel instance registry");
  }
  const envLoad = [
    match[0],
    "    const envConfig = process.env.TDAI_PANEL_INSTANCES_JSON?.trim();",
    "    if (envConfig) {",
    "      let raw: unknown;",
    "      try { raw = JSON.parse(envConfig) as unknown; } catch {",
    '        throw new InstanceRegistryError(500, "invalid TDAI_PANEL_INSTANCES_JSON");',
    "      }",
    "      const parsed = fileSchema.safeParse(Array.isArray(raw) ? { instances: raw } : raw);",
    "      if (!parsed.success) throw new InstanceRegistryError(500, \"TDAI_PANEL_INSTANCES_JSON validation failed\");",
    "      const entries = parsed.data.instances.map((row) => ({",
    "        instance_id: row.id, name: row.name, gateway_endpoint: row.gateway_endpoint,",
    "        proxy_endpoint: row.proxy_endpoint, api_key: row.api_key,",
    "      }));",
    "      return new InstanceRegistry(entries);",
    "    }",
  ].join("\n");
  return source.replace(match[0], envLoad);
}

export function panelBootstrapHtml() {
  return `<!doctype html><meta charset="utf-8"><title>GrenAgent</title><script>
(async()=>{let bootstrapSucceeded=false;try{const prefix='#tdai-bootstrap=';const token=location.hash.startsWith(prefix)?decodeURIComponent(location.hash.slice(prefix.length)):'';if(!token)throw new Error('missing token');const response=await fetch('/__grenagent/bootstrap/consume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(!response.ok)throw new Error('bootstrap failed');const payload=await response.json();localStorage['tdai-panel.session']=JSON.stringify(payload.session);bootstrapSucceeded=true;}finally{if(!bootstrapSucceeded)localStorage.removeItem('tdai-panel.session');location.replace('/');}})();
</script>`;
}

export function patchPanelPortFile(source) {
  if (source.includes("TDAI_PANEL_PORT_FILE")) return source;
  const importNeedle = "import { serve } from '@hono/node-server';";
  const patchedImport = `${importNeedle}\nimport { writeFileSync } from 'node:fs';`;
  const withImport = replaceOnce(source, importNeedle, patchedImport, "MemoryPanel managed port file import");
  const callbackNeedle = "    deps.logger.info('panel listening', {";
  const callbackBody = [
    "    // TDAI_PANEL_PORT_FILE: report the atomically assigned listener port to the parent.",
    "    const managedPortFile = process.env.TDAI_PANEL_PORT_FILE?.trim();",
    "    if (managedPortFile) writeFileSync(managedPortFile, String(info.port), { encoding: 'utf8', mode: 0o600 });",
    callbackNeedle,
  ].join("\n");
  return replaceOnce(withImport, callbackNeedle, callbackBody, "MemoryPanel managed port file callback");
}

export function patchPanelBootstrapRoutes(source) {
  if (source.includes("__grenagent/bootstrap")) return source;
  const needle = "const app = new Hono();";
  if (!source.includes(needle)) {
    throw new Error("unexpected TencentDB upstream layout while patching MemoryPanel bootstrap routes");
  }
  const wrapper = JSON.stringify(panelBootstrapHtml());
  const routes = `${needle}

  const panelBootstrapTokens = new Map<string, { instanceId: string; userKey: string; expiresAt: number }>();
  const panelSharedSecret = process.env.TDAI_PANEL_BOOTSTRAP_SECRET?.trim() ?? "";
  const panelRequestIsLoopback = (c: any): boolean => {
    const address = c.env?.incoming?.socket?.remoteAddress;
    return !address || address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };
  const panelBootstrapSecret = (c: any): boolean => {
    const provided = c.req.header("x-tdai-panel-shared-secret") ?? c.req.header("x-tdai-panel-secret") ?? "";
    return Boolean(panelSharedSecret) && provided === panelSharedSecret;
  };
  app.get("/__grenagent/health", (c) => {
    if (!panelRequestIsLoopback(c) || !panelBootstrapSecret(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ status: "ok", service: "tencentdb-panel" });
  });
  app.post("/__grenagent/bootstrap/register", async (c) => {
    if (!panelRequestIsLoopback(c) || !panelBootstrapSecret(c)) return c.json({ error: "unauthorized" }, 401);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_request" }, 400); }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const instanceId = typeof body?.instance_id === "string" ? body.instance_id.trim() : "";
    const userKey = typeof body?.user_key === "string" ? body.user_key.trim() : "";
    const rawExpiry = body?.expires_at;
    const expiresAt = typeof rawExpiry === "number" ? rawExpiry : Date.parse(String(rawExpiry ?? ""));
    if (!token || !instanceId || !userKey || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 60_000) {
      return c.json({ error: "invalid_request" }, 400);
    }
    panelBootstrapTokens.set(token, { instanceId, userKey, expiresAt });
    return c.json({ ok: true });
  });
  app.post("/__grenagent/bootstrap/consume", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "unauthorized" }, 401); }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const record = panelBootstrapTokens.get(token);
    panelBootstrapTokens.delete(token);
    if (!record || record.expiresAt <= Date.now()) return c.json({ error: "unauthorized" }, 401);
    let entry;
    try { entry = deps.instanceRegistry.resolve(record.instanceId); } catch { return c.json({ error: "unauthorized" }, 401); }
    const verified = await deps.metaKernel.invoke("auth/verify", { user_key: record.userKey }, {
      instanceId: entry.instance_id, gatewayEndpoint: entry.gateway_endpoint, gatewayApiKey: entry.api_key,
      reqId: c.get("reqId"),
    });
    if (verified.code !== 0) return c.json({ error: "unauthorized" }, 401);
    const data: any = verified.data ?? {};
    if (data.valid !== true || !data.user || typeof data.user !== "object") {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ session: { instanceId: entry.instance_id, instanceName: entry.name, userKey: record.userKey, user: data.user } });
  });
  app.get("/__grenagent/bootstrap", (c) => c.html(${wrapper}));`;
  return source.replace(needle, routes);
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
