// 命令模板语法。纯函数，扩展、主进程、渲染层共用，不能引入 node 模块。
//   占位符：{名} / {名=默认值}；{{ 和 }} 输出字面量花括号。
//   调用文本：/名 "参数" …，双引号内用 \" 和 \\ 转义。
//   展开结果：<command name=… args=…>正文</command>，气泡据此还原成命令胶囊。

export interface PromptParam {
  name: string;
  defaultValue?: string;
}

export interface CommandArg {
  name: string;
  value: string;
}

export interface CommandBlock {
  name: string;
  args: CommandArg[];
}

export interface PromptSegment {
  text: string;
  /** 这一段是占位符时为参数名。 */
  param?: string;
}

export interface CommandBlockHit {
  start: number;
  end: number;
  /** args 解析失败时为 null，调用方按普通文本显示。 */
  block: CommandBlock | null;
}

export const COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

const TOKEN_RE = /\{\{|\}\}|\{([\p{L}_][\p{L}\p{N}_-]*)(?:=([^}\n]*))?\}/gu;
const INVOCATION_RE = /^\/([\p{L}\p{N}][\p{L}\p{N}_-]{0,63})(?=\s|$)/u;
const COMMAND_BLOCK_RE = /<command name="([^"]*)" args="([^"]*)">\n[\s\S]*?\n<\/command>/g;

export function parsePromptParams(body: string): PromptParam[] {
  const params: PromptParam[] = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (!name) continue;
    const defaultValue = match[2];
    const index = params.findIndex((param) => param.name === name);
    if (index === -1) {
      params.push(defaultValue === undefined ? { name } : { name, defaultValue });
    } else if (params[index].defaultValue === undefined && defaultValue !== undefined) {
      params[index] = { name, defaultValue };
    }
  }
  return params;
}

export function tokenizePromptBody(body: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (!name) continue;
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: body.slice(last, start) });
    segments.push({ text: match[0], param: name });
    last = start + match[0].length;
  }
  if (last < body.length) segments.push({ text: body.slice(last) });
  return segments;
}

export function renderPromptBody(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(TOKEN_RE, (token: string, name: string | undefined) => {
    if (token === "{{") return "{";
    if (token === "}}") return "}";
    return name !== undefined && Object.hasOwn(values, name) ? values[name] : token;
  });
}

export function argumentHint(params: readonly PromptParam[]): string {
  return params.map((param) => (param.defaultValue === undefined ? `<${param.name}>` : `[${param.name}]`)).join(" ");
}

export function resolveArgs(
  params: readonly PromptParam[],
  raw: readonly string[],
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  params.forEach((param, index) => {
    const given = raw[index] ?? "";
    if (given !== "") values[param.name] = given;
    else if (param.defaultValue !== undefined) values[param.name] = param.defaultValue;
    else missing.push(param.name);
  });
  return { values, missing };
}

export function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatInvocation(name: string, values: readonly string[]): string {
  return [`/${name}`, ...values.map(quoteArg)].join(" ");
}

export function parseInvocation(text: string): { name: string; argsText: string } | null {
  const match = INVOCATION_RE.exec(text);
  if (!match) return null;
  return { name: match[1], argsText: text.slice(match[0].length) };
}

/** 按顺序取 count 个参数：双引号内只转义 \" 和 \\，其它反斜杠原样，单引号原样，其余按空白切。剩下的原文是补充正文。 */
export function splitArgs(text: string, count: number): { args: string[]; rest: string } {
  const args: string[] = [];
  let i = 0;
  while (args.length < count) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const quote = text[i];
    let value = "";
    if (quote === '"' || quote === "'") {
      i++;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) i++;
        value += text[i];
        i++;
      }
      i++;
    } else {
      while (i < text.length && !/\s/.test(text[i])) {
        value += text[i];
        i++;
      }
    }
    args.push(value);
  }
  return { args, rest: text.slice(Math.min(i, text.length)).trim() };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function buildCommandBlock(name: string, args: readonly CommandArg[], body: string): string {
  const json = JSON.stringify(Object.fromEntries(args.map((arg) => [arg.name, arg.value])));
  const safeBody = body.replace(/<\/command>/g, "<\\/command>");
  return `<command name="${escapeAttr(name)}" args="${escapeAttr(json)}">\n${safeBody}\n</command>`;
}

export function decodeCommandBlock(nameAttr: string, argsAttr: string): CommandBlock | null {
  try {
    const parsed: unknown = JSON.parse(unescapeAttr(argsAttr));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const args = Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    return { name: unescapeAttr(nameAttr), args };
  } catch {
    return null;
  }
}

export function findCommandBlocks(text: string): CommandBlockHit[] {
  return Array.from(text.matchAll(COMMAND_BLOCK_RE), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    block: decodeCommandBlock(match[1], match[2]),
  }));
}
