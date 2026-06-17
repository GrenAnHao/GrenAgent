// auto-title: 首轮结束(agent_end)时用「当前模型、进程内」生成一个简短会话标题并写回。
//
// 取代 Tauri 侧起一次性冷 `pi -p` 子进程的老做法——那种冷进程要加载全局 MCP
// （deepwiki 等需 OAuth/网络）、且对 token-plan provider 无法在一次性进程里鉴权，
// 会卡在 agent_start 之前永不返回。这里在已鉴权的常驻 sidecar 内直接用 ctx.model
// 生成（无子进程、无 MCP 冷启动），经 pi.setSessionName 写回——其内部会
// appendSessionInfo + 广播 session_info_changed，Tauri 侧边栏据此刷新。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getConfig } from "../_shared/runtime-config.js";

const ENABLED = (process.env.AUTO_TITLE ?? "1") !== "0";

/**
 * 解析标题生成模型：优先用设置里的「对话标题模型」(titleModel, 形如 provider/id)，
 * 经 modelRegistry 解析；留空或解析不到则回退当前对话模型 ctx.model。
 * 与 long-term-memory 的 resolveMemoryModel 同构。
 */
function resolveTitleModel(ctx: ExtensionContext): Model<never> | undefined {
  const spec = (getConfig("titleModel") ?? "").trim();
  if (spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
    console.error("[auto-title] titleModel 未在 registry 找到:", JSON.stringify(spec), "→ 回退当前对话模型");
  }
  return ctx.model as Model<never> | undefined;
}

/** 首条 user 消息的纯文本。messages 形如 {role,content} 或 {message:{role,content}}。 */
function firstUserText(messages: unknown[]): string {
  for (const m of messages) {
    const obj = (m ?? {}) as {
      role?: string;
      content?: unknown;
      message?: { role?: string; content?: unknown };
    };
    const role = obj.role ?? obj.message?.role ?? "";
    if (role !== "user") continue;
    const content = obj.content ?? obj.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (p): p is { type: string; text: string } =>
            !!p && typeof p === "object" && (p as { type?: string }).type === "text",
        )
        .map((p) => p.text)
        .join(" ");
    }
    if (text.trim()) return text.trim();
  }
  return "";
}

/** 会话是否已有名字（用户手动命名或此前已生成）。扫描 session_info entry。 */
function alreadyNamed(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; name?: unknown }>;
    const hit = entries.find(
      (e) => e?.type === "session_info" && typeof e.name === "string" && e.name.trim().length > 0,
    );
    // [DEBUG] 打印命中的已有名字：用于判断是否被「第一句话/pi 内置命名」抢先写入而跳过 AI 生成。
    if (hit) console.error("[auto-title] alreadyNamed: existing session_info name =", JSON.stringify((hit as { name?: unknown }).name));
    return !!hit;
  } catch (e) {
    console.error("[auto-title] alreadyNamed: getEntries threw:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** 清洗模型输出为标题：取首个非空行、去首尾引号、按字符截断到 80。 */
function cleanTitle(raw: string): string {
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
  return chars.length > 80 ? `${chars.slice(0, 77).join("")}...` : unquoted;
}

/**
 * 进程内用标题模型生成标题（无子进程，关闭推理求快）。
 * apiKey/headers 必须由调用方经 modelRegistry.getApiKeyAndHeaders 解析后传入——
 * completeSimple 从 options.apiKey 取密钥，缺失会对 token-plan/OAuth 供应商报 "No API key"。
 */
async function generateTitle(
  model: Model<never>,
  firstUser: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
  signal?: AbortSignal,
): Promise<string> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const msg = await completeSimple(
    model,
    {
      systemPrompt:
        "You generate a very short chat title (3 to 6 words) summarizing the user's request. " +
        "Use Title Case, no surrounding quotes, no trailing punctuation. Reply with ONLY the title.",
      messages: [{ role: "user", content: firstUser.slice(0, 4000), timestamp: Date.now() }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, reasoning: "off", signal } as never,
  );
  // [DEBUG] 打印原始返回：确认 content 里到底有没有 text 块（vs 只有 thinking / 被截断）。排查完删除。
  try {
    console.error("[auto-title] raw msg =", JSON.stringify(msg)?.slice(0, 900));
  } catch {
    console.error("[auto-title] raw msg unstringifiable; keys =", Object.keys((msg ?? {}) as object).join(","));
  }
  const text = msg.content
    .filter(
      (c: unknown): c is { type: "text"; text: string } =>
        !!c && typeof c === "object" && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
  console.error("[auto-title] extracted text len =", text.length, "preview =", JSON.stringify(text.slice(0, 150)));
  return cleanTitle(text);
}

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;
  console.error("[auto-title] extension loaded");

  pi.on("agent_end", async (event, ctx) => {
    // [DEBUG] 临时埋点：定位「标题不自动设置 / 不走 AI 摘要」的断裂点。排查完应删除这些 console.error。
    try {
      console.error("[auto-title] agent_end fired");
      // 子代理(--no-session, PI_IS_SUBAGENT)不需要标题，跳过以省一次模型调用。
      if (process.env.PI_IS_SUBAGENT === "1") {
        console.error("[auto-title] skip: PI_IS_SUBAGENT=1");
        return;
      }
      let currentName: string | undefined;
      try {
        currentName = pi.getSessionName();
      } catch (e) {
        console.error("[auto-title] getSessionName threw:", e instanceof Error ? e.message : String(e));
      }
      console.error("[auto-title] getSessionName() =", JSON.stringify(currentName));
      if (alreadyNamed(ctx)) {
        console.error("[auto-title] skip: alreadyNamed → 不生成 AI 摘要");
        return;
      }
      const model = resolveTitleModel(ctx);
      console.error(
        "[auto-title] title model =", JSON.stringify(getConfig("titleModel") ?? ""),
        "resolved id =", (model as { id?: string } | undefined)?.id ?? "(none)",
      );
      if (!model) {
        console.error("[auto-title] skip: 无可用标题模型（titleModel 未配且 ctx.model 为空）");
        return;
      }
      const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
        ? (event as { messages: unknown[] }).messages
        : [];
      const firstUser = firstUserText(messages);
      console.error("[auto-title] messages =", messages.length, "firstUser len =", firstUser.length, "preview =", JSON.stringify(firstUser.slice(0, 60)));
      if (!firstUser) {
        console.error("[auto-title] skip: 取不到首条用户文本");
        return;
      }
      // 关键：completeSimple 从 options.apiKey 取密钥；这里经 modelRegistry 解析
      // （含 OAuth/token-plan token 刷新），否则对 token-plan 供应商会 "No API key"。
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        console.error("[auto-title] skip: 鉴权解析失败 →", auth.error);
        return;
      }
      console.error("[auto-title] auth ok, apiKey present =", !!auth.apiKey);
      const title = await generateTitle(model, firstUser, { apiKey: auth.apiKey, headers: auth.headers }, ctx.signal);
      console.error("[auto-title] generated title =", JSON.stringify(title));
      if (title) {
        await pi.setSessionName(title);
        console.error("[auto-title] setSessionName done →", JSON.stringify(title));
      } else {
        console.error("[auto-title] skip: 生成的标题为空");
      }
    } catch (err) {
      // [DEBUG] 原本这里是静默 catch{}，正是它把真实报错吞了。临时打印出来。
      console.error("[auto-title] ERROR:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  });
}
