// 会话标题的提示词和输出清洗。输入整理（拆技能 / 命令 / 粘贴块）在 _shared/session-title.ts。
// auto-title 扩展和主进程的「重新生成标题」共用这里。
// 见 .agents/notes/implemented/feature/2026-10-19-session-title-quality.md

export const TOPIC_TITLE_PROMPT_VERSION = "v2";

/**
 * 标题只有一行，但上限不能卡在标题长度上：实测本地网关关不掉思考（reasoning: off 仍会先想），
 * 常见 40~140 个 token，长一点的需求会想到 300~500 多。上限 64 / 512 时都见过思考把额度用完、以 length 结束、
 * 一个字正文都没有。每个会话只调一次，模型写成回答时也仍然封顶（回答会被 cleanGeneratedTitle 拒掉）。
 */
export const TITLE_MAX_TOKENS = 1024;

/**
 * 清洗后超过这个宽度就不是标题了，多半是模型在回答。中日韩字符计 2，其余计 1：
 * 大约 32 个汉字或 64 个拉丁字符。
 */
export const TITLE_MAX_WIDTH = 64;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char) ? 2 : 1;
  return width;
}

export function titleLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale && locale !== "und") return locale;
  } catch {
    // Intl 不可用时跟产品界面语言。
  }
  return "zh-CN";
}

const EXAMPLES = `Examples (message → title):
<request>输入框总是会对一些内容进行转义 这样很烦</request> → 输入框内容被转义
<request>给客户端登录失败限制改到10次错误 然后客户端提示剩余次数</request> → 登录失败次数限制与提示
<request>Why does the build fail after upgrading vite?</request> → Build failure after Vite upgrade
<request>(empty)</request> <attachments>Pasted text: 请对 lhr-capture 目录下的代码做一次完整的功能拆解…</attachments> → lhr-capture 功能拆解
<request>你看看这个气泡如何</request> <attachments>Images: 1</attachments> → 气泡样式评估`;

/**
 * 标题请求：系统提示 + 用户消息。input 是 titleModelInput 整理过的首条消息（<request> / <attachments>）。
 * 只给首条消息，不给助手回复和工具结果：模型会去处理路径和代码，而不是起名。
 *
 * 规则和示例全部放在用户消息里，系统提示是空串（供应商适配器遇到空串就不发 system）。实测本地 OpenAI 兼容网关（newapi）：
 * glm 只要带 system 就报「Incorrect role information」，deepseek 时不时丢掉较长的 system、去回答用户的问题。
 * 只发一条用户消息时三家都稳定。
 */
export function chainSummaryTitle(input: string, locale: string): { system: string; user: string } {
  return {
    system: "",
    user: `Name this chat session for the sidebar of a coding assistant. Read the user's first message below and reply with a short title for what the user wants.

Rules:
- Reply with the title only, on one line. No quotes, no markdown, no trailing punctuation, no prefix such as "Title:".
- Use the language of the user's request. If it is unclear, use the language of locale ${locale}.
- Chinese titles: 6 to 16 characters. English titles: 2 to 8 words.
- Describe the task or topic, as a verb phrase or noun phrase. Do not copy the whole message.
- Keep product names, file names, commands and code identifiers as written.
- Never answer the request, refuse, ask a question, or explain. If the request is vague, name what is visible.
- If the message is only a file path, file reference or command, title it after that file or command.
- <attachments> is material the user attached (skill, command template, pasted text, files, images). Name the request; use the attachments only when the request is empty or too vague.

${EXAMPLES}

The user's first message:

${input.trim()}

Title:`,
  };
}

// 只认「起不了标题」这类说法：「图片无法生成」「没有可用模型」本身就是合理的标题。
const REFUSAL_RE = /(无法|不能|没法)[^，,。]{0,8}(生成|确定|提供|给出|概括|总结)[^，,。]{0,8}(标题|题目)|抱歉|对不起|\bsorry\b|\bI (?:can(?:no|')t|am unable)\b|\bunable to (?:generate|determine|provide)\b|\bas an ai\b/i;
const LEADING_MARK_RE = /^(?:#{1,6}\s*|[-*+•]\s+|\d+[.)、]\s*|>\s*)/;
const LABEL_RE = /^(?:会话标题|对话标题|标题|title|session title)\s*[:：]\s*/i;
const WRAP_RE = /^[\s"'`“”‘’「」『』《》【】*]+|[\s"'`“”‘’「」『』《》【】*]+$/g;
const TRAILING_PUNCT_RE = /[\s。．.！!？?，,；;：:、…~～]+$/;
// 句中出现句号、问号、叹号后还有字：是两句话，不是标题（「当前环境无法读取路径。请运行」）。
const SENTENCE_BREAK_RE = /[。！？!?]\s*\S/;

function jsonTitle(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    return null;
  }
}

/**
 * 模型输出 → 会话标题。去掉 markdown 标记、「标题：」前缀、引号、末尾标点，兼容 {"title": "…"}；
 * 拒绝句、多句话、超长的输出当作没生成，返回空串（侧栏继续显示首条消息兜底）。
 */
export function cleanGeneratedTitle(raw: string): string {
  const fromJson = jsonTitle(raw);
  if (fromJson !== null) return fromJson ? cleanGeneratedTitle(fromJson) : "";
  let line = raw.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  for (let i = 0; i < 3; i++) {
    const before = line;
    line = line.replace(LEADING_MARK_RE, "").replace(LABEL_RE, "").replace(WRAP_RE, "").replace(TRAILING_PUNCT_RE, "");
    if (line === before) break;
  }
  line = line.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return "";
  if (REFUSAL_RE.test(line) || SENTENCE_BREAK_RE.test(line)) return "";
  if (displayWidth(line) > TITLE_MAX_WIDTH) return "";
  return line;
}
