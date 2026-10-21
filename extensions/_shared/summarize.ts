// 进程内「摘要成一行短标题」原语：复用 auto-title 验证过的做法——用标题模型在已鉴权的常驻
// sidecar 内直接 completeSimple（无子进程、无 MCP 冷启动、关推理求快）。auto-title（会话标题）、
// 生成物标题（语音/图片）等共用这一个原语，避免各处重复一份模型解析 + 鉴权 + 清洗逻辑。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getConfig } from "./runtime-config.js";

const DEFAULT_PROMPT =
  "You generate a very short title (3 to 6 words) summarizing the content. " +
  "Use the same language as the input, Title Case where applicable, " +
  "no surrounding quotes, no trailing punctuation. Reply with ONLY the title.";

/**
 * 解析摘要模型：优先 modelSpec（或设置里的 titleModel，形如 provider/id）经 registry 解析；
 * 留空或解析不到则回退当前对话模型 ctx.model。与 auto-title 原 resolveTitleModel 同构。
 */
export function resolveSummaryModel(
  ctx: ExtensionContext,
  modelSpec?: string,
): Model<never> | undefined {
  const spec = (modelSpec ?? getConfig("titleModel") ?? "").trim();
  if (spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
  }
  return ctx.model as Model<never> | undefined;
}

/** 清洗模型输出为一行标题：取首个非空行、去首尾引号、按字符截断到 maxChars。 */
export function cleanLine(raw: string, maxChars = 80): string {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const unquoted = line
    .replace(/^["'“”「『]+/, "")
    .replace(/["'“”」』]+$/, "")
    .trim();
  if (!unquoted) return "";
  const chars = [...unquoted];
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 3).join("")}...` : unquoted;
}

export interface SummarizeOptions {
  /** 系统提示（覆盖默认的「短标题」提示）。 */
  systemPrompt?: string;
  /** 标题最大字符数（按 code point 截断）。默认 80。 */
  maxChars?: number;
  /** 指定模型 provider/id（覆盖 titleModel / ctx.model）。 */
  modelSpec?: string;
  signal?: AbortSignal;
  /** 补全请求的 max_tokens。标题调用传小值，避免按模型默认输出上限计费。 */
  maxTokens?: number;
  /** 返回模型原文（只去首尾空白），由调用方自己清洗。会话标题要看整段输出才认得出 JSON 和拒绝句。 */
  raw?: boolean;
}

/**
 * 进程内 LLM 摘要：把一段文本概括成一行短标题/摘要。
 * 任何失败（无可用模型 / 鉴权失败 / 返回空）都安静返回 ''，由调用方兜底——
 * 摘要是锦上添花，绝不应让它的失败阻断主流程。
 */
export async function summarize(
  ctx: ExtensionContext,
  input: string,
  opts: SummarizeOptions = {},
): Promise<string> {
  const text = input.trim();
  if (!text) return "";
  const model = resolveSummaryModel(ctx, opts.modelSpec);
  if (!model) return "";
  const context = {
    systemPrompt: opts.systemPrompt ?? DEFAULT_PROMPT,
    // 摘要不是代理：不声明工具，模型只能根据这段提示词和用户文本回答。
    tools: [],
    messages: [{ role: "user" as const, content: text.slice(0, 4000), timestamp: Date.now() }],
  };
  const options = {
    // 类型只声明到 ThinkingLevel（不含 "off"），运行时（EXTENDED_THINKING_LEVELS）接受。
    reasoning: "off" as SimpleStreamOptions["reasoning"],
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  };

  // pi 1.3 让扩展的嵌套模型调用走 ctx.modelRegistry.streamSimple：请求时取鉴权，虚拟模型、只注册在
  // ModelRuntime 上的 provider（faux、扩展自带的）也能用。旧版没有这个方法时退回 pi-ai 的全局 completeSimple。
  const registry = ctx.modelRegistry as unknown as {
    streamSimple?: (m: unknown, c: unknown, o: unknown) => { result(): Promise<{ content: unknown }> };
  };
  let msg: { content: unknown };
  if (typeof registry.streamSimple === "function") {
    msg = await registry.streamSimple(model, context, options).result();
  } else {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return "";
    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    msg = await completeSimple(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
  }
  const out = (msg.content as unknown[])
    .filter(
      (c): c is { type: "text"; text: string } =>
        !!c && typeof c === "object" && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
  return opts.raw ? out.trim() : cleanLine(out, opts.maxChars ?? 80);
}
