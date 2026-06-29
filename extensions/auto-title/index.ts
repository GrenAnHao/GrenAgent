// auto-title: 首轮结束(agent_end)时用「当前模型、进程内」生成一个简短会话标题并写回。
//
// 取代 Tauri 侧起一次性冷 `pi -p` 子进程的老做法——那种冷进程要加载全局 MCP
// （deepwiki 等需 OAuth/网络）、且对 token-plan provider 无法在一次性进程里鉴权，
// 会卡在 agent_start 之前永不返回。这里在已鉴权的常驻 sidecar 内直接用标题模型
// 生成（无子进程、无 MCP 冷启动），经 pi.setSessionName 写回——其内部会
// appendSessionInfo + 广播 session_info_changed，Tauri 侧边栏据此刷新。
//
// 标题生成本身复用 `_shared/summarize`（进程内摘要原语，生成物标题等也用它）。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSummaryModel, summarize } from "../_shared/summarize.js";
import { extractTextFromContent } from "../_shared/transcript.js";

const ENABLED = (process.env.AUTO_TITLE ?? "1") !== "0";

const TITLE_PROMPT =
  "You generate a very short chat title (3 to 6 words) summarizing the user's request. " +
  "Use Title Case, no surrounding quotes, no trailing punctuation. Reply with ONLY the title.";

/** 首条 user 消息的纯文本。messages 形如 {role,content} 或 {message:{role,content}}。 */
function firstUserText(messages: unknown[]): string {
  for (const m of messages) {
    const obj = (m ?? {}) as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    const role = obj.role ?? obj.message?.role ?? "";
    if (role !== "user") continue;
    const text = extractTextFromContent(obj.content ?? obj.message?.content).trim();
    if (text) return text;
  }
  return "";
}

/** 会话是否已有名字（用户手动命名或此前已生成）。扫描 session_info entry。 */
function alreadyNamed(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; name?: unknown }>;
    return entries.some(
      (e) => e?.type === "session_info" && typeof e.name === "string" && e.name.trim().length > 0,
    );
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;

  pi.on("agent_end", async (event, ctx) => {
    try {
      // 子代理(--no-session, PI_IS_SUBAGENT)不需要标题，跳过以省一次模型调用。
      if (process.env.PI_IS_SUBAGENT === "1") return;
      // 已命名（用户手动 / 此前已生成）则不覆盖。
      if (alreadyNamed(ctx)) return;
      // 无可用标题模型（titleModel 未配且 ctx.model 为空）则放弃。
      if (!resolveSummaryModel(ctx)) return;

      const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
        ? (event as { messages: unknown[] }).messages
        : [];
      const firstUser = firstUserText(messages);
      if (!firstUser) return;

      // 后台非阻塞：标题生成是一次额外模型调用，不该拖住首轮 agent_end / UI「运行中」。
      void (async () => {
        try {
          const title = await summarize(ctx, firstUser, {
            systemPrompt: TITLE_PROMPT,
            maxChars: 80,
            signal: ctx.signal,
          });
          if (title) await pi.setSessionName(title);
        } catch (err) {
          console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
        }
      })();
    } catch (err) {
      console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  });
}
