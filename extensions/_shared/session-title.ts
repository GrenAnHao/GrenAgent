// 会话标题的输入整理。纯函数，扩展（auto-title）、主进程（侧栏列表、重新生成标题）、渲染层（发送瞬间的占位标题）共用，
// 不能引入 node 模块。
//
// 首条用户消息里常有几种包装，原样当标题会显示成 `<pi:attachment …` / `<skill name=…`：
//   - pi 展开的技能：<skill name="x" location="…">\nSKILL.md\n</skill>\n\n用户正文
//   - 发送前的技能调用：/skill:x 正文、/skill:"带 空格" 正文
//   - prompt-commands 展开的命令：<command name="x" args="{JSON}">\n模板正文\n</command>
//   - 输入框的粘贴块 / 拖入文件：<pi:attachment type="text|file" …>\n内容\n</pi:attachment>
//   - pi 给图片补的说明：[Image: original …] / [Image omitted: …]
// 见 .agents/notes/implemented/feature/2026-10-19-session-title-quality.md

import { findCommandBlocks, type CommandArg } from "../prompt-commands/syntax.js";

export interface TitleAttachment {
  type: "text" | "file";
  /** 文件块的路径；文本块没有。 */
  path?: string;
  content: string;
}

export interface TitleCommand {
  name: string;
  args: CommandArg[];
  /** 模板展开后的正文。发送前的调用文本没有。 */
  body: string;
}

export interface ParsedFirstMessage {
  /** 用户自己写的正文：包装块都已拿掉，首尾空白已去。 */
  text: string;
  skills: string[];
  commands: TitleCommand[];
  attachments: TitleAttachment[];
  images: number;
}

/** 侧栏标题最长保留的字符数（按 code point）。显示时还会被行宽省略。 */
export const FALLBACK_TITLE_MAX = 80;

const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
const SKILL_INVOCATION_RE = /^\/skill:(?:"((?:\\.|[^"\\])*)"|(\S+))(?:\s+|$)/;
const ATTACHMENT_RE = /<pi:attachment\s+([^>]*)>\n?([\s\S]*?)\n?<\/pi:attachment>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const IMAGE_HINT_RE = /\[Image(?: omitted)?:[^\]\n]*\]/g;
const MENTION_RE = /(^|\s)@(\S+)/g;

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function codePoints(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripAttachments(text: string, out: TitleAttachment[]): string {
  return text.replace(ATTACHMENT_RE, (_full, rawAttrs: string, content: string) => {
    const attrs: Record<string, string> = {};
    for (const match of rawAttrs.matchAll(ATTR_RE)) attrs[match[1]] = unescapeAttr(match[2]);
    out.push({
      type: attrs.type === "file" ? "file" : "text",
      ...(attrs.type === "file" && attrs.path ? { path: attrs.path } : {}),
      // 输入框写块时把内容里的 </pi:attachment> 插了零宽字符，这里还原。
      content: content.split("</pi:attachment\u200b>").join("</pi:attachment>"),
    });
    return "\n";
  });
}

function stripCommands(text: string, out: TitleCommand[]): string {
  let rest = "";
  let last = 0;
  for (const hit of findCommandBlocks(text)) {
    if (!hit.block) continue;
    const raw = text.slice(hit.start, hit.end);
    const body = raw.slice(raw.indexOf("\n") + 1, raw.length - "\n</command>".length).replace(/<\\\/command>/g, "</command>");
    out.push({ name: hit.block.name, args: hit.block.args, body });
    rest += `${text.slice(last, hit.start)}\n`;
    last = hit.end;
  }
  return rest + text.slice(last);
}

/** 把首条用户消息拆成用户正文和各种附带内容。images 是消息里图片块的个数（文本里的图片说明另算）。 */
export function parseFirstMessage(raw: string, images = 0): ParsedFirstMessage {
  const skills: string[] = [];
  const commands: TitleCommand[] = [];
  const attachments: TitleAttachment[] = [];
  let hints = 0;
  let text = stripAttachments(raw, attachments);
  text = stripCommands(text, commands);
  text = text.replace(SKILL_BLOCK_RE, (_full, name: string) => {
    skills.push(name.replace(/^skill:/, ""));
    return "\n";
  });
  text = text.replace(IMAGE_HINT_RE, () => {
    hints += 1;
    return " ";
  });
  text = text.trim();
  const invocation = SKILL_INVOCATION_RE.exec(text);
  if (invocation) {
    const name = invocation[1] !== undefined ? invocation[1].replace(/\\(.)/g, "$1") : invocation[2];
    skills.push(name.replace(/^skill:/, ""));
    text = text.slice(invocation[0].length).trim();
  }
  return { text, skills, commands, attachments, images: Math.max(images, hints) };
}

/** 正文里的 `@路径` 换成文件名：拖入文件的 `.pi/dropped/<哈希>/` 对人没有意义，长路径也挤掉了正文。 */
function shortenMentions(text: string): string {
  return text.replace(MENTION_RE, (_full, lead: string, path: string) => `${lead}${basename(path)}`);
}

function commandLabel(command: TitleCommand): string {
  const values = command.args.map((arg) => arg.value.trim()).filter(Boolean);
  return [`/${command.name}`, ...values].join(" ");
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * 没有生成标题时侧栏显示的标题。用户自己的正文优先；没有正文时依次用命令、技能、粘贴文本的首行、
 * 文件名，只有图片时写「图片」。什么都没有返回 null，由调用方退回时间标题。
 */
export function fallbackSessionTitle(raw: string, images = 0, max = FALLBACK_TITLE_MAX): string | null {
  const parsed = parseFirstMessage(raw, images);
  const text = oneLine(shortenMentions(parsed.text));
  const command = parsed.commands[0];
  let title = "";
  if (command) title = text ? `${commandLabel(command)} ${text}` : commandLabel(command);
  else if (text) title = text;
  else if (parsed.skills[0]) title = `/skill:${parsed.skills[0]}`;
  else {
    const attachment = parsed.attachments.find((item) => item.type === "text" && firstLine(item.content))
      ?? parsed.attachments.find((item) => item.type === "file" && item.path);
    if (attachment?.type === "text") title = oneLine(firstLine(attachment.content));
    else if (attachment?.path) title = basename(attachment.path);
    else if (parsed.images > 0) title = "图片";
  }
  title = codePoints(title, max).trim();
  return title || null;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * 给标题模型的输入：用户正文放在 <request> 里，附带内容按类别列在 <attachments> 里并截短。
 * 没有任何可概括的文字（比如只发了图片）时返回空串，调用方不起名。
 */
export function titleModelInput(raw: string, images = 0, budget = 2400): string {
  const parsed = parseFirstMessage(raw, images);
  const text = shortenMentions(parsed.text).trim();
  const hasWords = Boolean(text) || parsed.commands.length > 0 || parsed.skills.length > 0
    || parsed.attachments.some((item) => item.content.trim() || item.path);
  if (!hasWords) return "";
  // 附带内容最多占一半预算，每项再分摊；用户正文至少留一半。
  const blocks = parsed.commands.length + parsed.attachments.length;
  const share = Math.max(200, Math.floor(budget / 2 / Math.max(1, blocks)));
  const parts: string[] = [];
  for (const skill of parsed.skills) parts.push(`Skill: ${skill}`);
  for (const command of parsed.commands) {
    parts.push(`Command: ${commandLabel(command)}`);
    if (command.body.trim()) parts.push(`Command prompt:\n${clip(command.body.trim(), share)}`);
  }
  for (const attachment of parsed.attachments) {
    const content = clip(attachment.content.trim(), share);
    if (attachment.type === "file") parts.push(`Attached file ${basename(attachment.path ?? "")}:\n${content}`);
    else if (content) parts.push(`Pasted text:\n${content}`);
  }
  if (parsed.images > 0) parts.push(`Images: ${parsed.images}`);
  const request = clip(text, parts.length > 0 ? Math.floor(budget / 2) : budget);
  const sections = [`<request>\n${request || "(empty)"}\n</request>`];
  if (parts.length > 0) sections.push(`<attachments>\n${parts.join("\n\n")}\n</attachments>`);
  return sections.join("\n\n");
}

/** 会话条目里第一条用户消息的文本和图片数。条目形如 {type:"message", message:{role, content}}。 */
export function firstUserMessage(entries: readonly unknown[]): { text: string; images: number } | null {
  for (const entry of entries) {
    const record = (entry ?? {}) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (record.type !== "message" || record.message?.role !== "user") continue;
    const content = record.message.content;
    if (typeof content === "string") {
      if (content.trim()) return { text: content, images: 0 };
      continue;
    }
    if (!Array.isArray(content)) continue;
    let text = "";
    let images = 0;
    for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === "text" && typeof part.text === "string") text += (text ? "\n" : "") + part.text;
      else if (part?.type === "image") images += 1;
    }
    if (text.trim() || images > 0) return { text, images };
  }
  return null;
}
