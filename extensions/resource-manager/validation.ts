import { remoteTransportKind } from "../mcp/config.js";

export type McpScope = "global" | "project";
export type McpTransportInput = "stdio" | "sse" | "http" | "remote";

export interface AddMcpServerInput {
  name: string;
  scope: McpScope;
  transport: McpTransportInput;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  replace?: boolean;
}

const STDIO_FIELDS = ["command", "args", "env", "cwd"] as const;
type StdioField = (typeof STDIO_FIELDS)[number];

export interface NormalizedMcp {
  input: AddMcpServerInput;
  /** remote 请求里被丢掉的 stdio 字段。这些字段不会写入配置。 */
  ignored: StdioField[];
}

export type SkillSource =
  | { type: "content"; content: string }
  | { type: "file"; path: string }
  | { type: "directory"; path: string };

export interface AddSkillInput {
  name: string;
  source: SkillSource;
  description?: string;
  replace?: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateResourceName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "名称只能包含字母、数字、点、连字符和下划线，且长度不超过 64";
}

function stringRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    if (name && typeof item === "string") out[name] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function definedStdioFields(input: AddMcpServerInput): StdioField[] {
  return STDIO_FIELDS.filter((key) => input[key] !== undefined);
}

function remoteUrlError(url: string | undefined): string | undefined {
  if (!url) return "remote MCP 必须提供 URL";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "URL 必须使用 http/https";
  } catch {
    return "URL 格式无效";
  }
}

/** 把工具入参收成实际要写入的配置。remote 上多带的 stdio 字段只记入 ignored，不当成错误。 */
export function normalizeMcpInput(input: AddMcpServerInput): { ok: true; value: NormalizedMcp } | { ok: false; error: string } {
  const nameError = validateResourceName(input.name);
  if (nameError) return { ok: false, error: nameError };
  if (input.scope !== "global" && input.scope !== "project") return { ok: false, error: "MCP 作用域无效" };

  if (input.transport === "stdio") {
    if (!input.command?.trim()) return { ok: false, error: "stdio MCP 必须提供 command" };
    if (input.url !== undefined) return { ok: false, error: "stdio MCP 不支持 URL" };
    if (input.headers !== undefined) return { ok: false, error: "stdio MCP 不支持 headers" };
    const env = stringRecord(input.env);
    return {
      ok: true,
      value: {
        input: {
          name: input.name,
          scope: input.scope,
          transport: "stdio",
          command: input.command.trim(),
          ...(input.args ? { args: input.args } : {}),
          ...(env ? { env } : {}),
          ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
        },
        ignored: [],
      },
    };
  }

  if (input.transport !== "sse" && input.transport !== "http" && input.transport !== "remote") {
    return { ok: false, error: "MCP 传输类型无效" };
  }
  const urlError = remoteUrlError(input.url);
  if (urlError) return { ok: false, error: urlError };
  const headers = stringRecord(input.headers);
  return {
    ok: true,
    value: {
      input: {
        name: input.name,
        scope: input.scope,
        transport: remoteTransportKind(input.url!),
        url: input.url,
        ...(headers ? { headers } : {}),
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
      },
      ignored: definedStdioFields(input),
    },
  };
}

export function validateMcpInput(input: AddMcpServerInput): string | undefined {
  const normalized = normalizeMcpInput(input);
  return normalized.ok ? undefined : normalized.error;
}

function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, "[REDACTED]"]));
}

function presentHeader(value: string): string {
  return /\$\{[A-Za-z0-9_]+\}/.test(value) ? value : "[REDACTED]";
}

/** 给确认框和工具卡片看的参数。env 值不露出；header 里的占位符保留，明文密钥打码。 */
export function publicMcpView(
  input: AddMcpServerInput,
  ignored: readonly StdioField[] = [],
  source?: AddMcpServerInput,
): Record<string, unknown> {
  const headers = input.headers
    ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, presentHeader(value)]))
    : undefined;
  const view: Record<string, unknown> = {
    name: input.name,
    scope: input.scope,
    transport: input.transport,
  };
  if (input.command) view.command = input.command;
  if (input.args?.length) view.args = input.args;
  if (input.cwd) view.cwd = input.cwd;
  if (input.env && Object.keys(input.env).length) view.env = redactEnv(input.env);
  if (input.url) view.url = input.url;
  if (headers) view.headers = headers;
  if (!ignored.length || !source) return view;
  const dropped: Record<string, unknown> = {};
  if (ignored.includes("command") && source.command !== undefined) dropped.command = source.command;
  if (ignored.includes("args") && source.args !== undefined) dropped.args = source.args;
  if (ignored.includes("cwd") && source.cwd !== undefined) dropped.cwd = source.cwd;
  if (ignored.includes("env") && source.env) dropped.env = redactEnv(source.env);
  if (Object.keys(dropped).length) view.dropped = dropped;
  return view;
}

function frontmatterName(markdown: string): { hasFrontmatter: boolean; name?: string; end: number } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return { hasFrontmatter: false, end: -1 };

  const closing = lines.slice(1).findIndex((line) => line === "---");
  if (closing < 0) throw new Error("Skill frontmatter 缺少结束标记");

  const nameLine = lines.slice(1, closing + 1).find((line) => /^\s*name\s*:/i.test(line));
  if (!nameLine) return { hasFrontmatter: true, end: closing + 1 };

  const value = nameLine.replace(/^\s*name\s*:/i, "").trim();
  const name = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
  return { hasFrontmatter: true, name, end: closing + 1 };
}

export function normalizeSkillMarkdown(name: string, description: string | undefined, markdown: string): string {
  const nameError = validateResourceName(name);
  if (nameError) throw new Error(nameError);

  const parsed = frontmatterName(markdown);
  if (parsed.hasFrontmatter) {
    if (parsed.name === undefined) throw new Error("Skill frontmatter 必须包含 name");
    if (parsed.name !== name) throw new Error(`Skill frontmatter name \"${parsed.name}\" 与参数 \"${name}\" 不一致`);
    return markdown;
  }

  const header = ["---", `name: ${name}`];
  if (description) header.push(`description: ${JSON.stringify(description)}`);
  header.push("---");
  return `${header.join("\n")}\n${markdown}`;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}
