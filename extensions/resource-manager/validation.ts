export type McpScope = "global" | "project";

export interface AddMcpServerInput {
  name: string;
  scope: McpScope;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  replace?: boolean;
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

export function validateMcpInput(input: AddMcpServerInput): string | undefined {
  const nameError = validateResourceName(input.name);
  if (nameError) return nameError;
  if (input.scope !== "global" && input.scope !== "project") return "MCP 作用域无效";

  if (input.transport === "stdio") {
    if (!input.command?.trim()) return "stdio MCP 必须提供 command";
    if (input.url !== undefined) return "stdio MCP 不支持 URL";
    return undefined;
  }

  if (input.transport !== "sse") return "MCP 传输类型无效";
  if (!input.url) return "sse MCP 必须提供 URL";
  if (input.command !== undefined || input.args !== undefined || input.env !== undefined || input.cwd !== undefined) {
    return "sse MCP 不支持 command、args、env 或 cwd";
  }

  try {
    const url = new URL(input.url);
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : "URL 必须使用 http/https";
  } catch {
    return "URL 格式无效";
  }
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
