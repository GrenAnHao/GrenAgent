// session-memory: maintain a structured working-state markdown for the session
// and re-anchor the agent after compaction by injecting the latest state.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { buildInjection } from "./injector.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { readState, statePath, writeState } from "./store.js";
import { flattenMessages } from "./transcript.js";
import { extractState } from "./writer.js";

const enabled = () => (getConfig("SESSION_STATE_ENABLED") ?? "1") !== "0";
const everyTurns = () => Number(getConfig("SESSION_STATE_EVERY_TURNS") ?? "8") || 8;
const maxChars = () => Number(getConfig("SESSION_STATE_MAX_CHARS") ?? "4000") || 4000;
const stateModel = () => getConfig("SESSION_STATE_MODEL");

export default function (pi: ExtensionAPI) {
  let turnsSinceWrite = 0;
  let needReanchor = false;

  const makeAsk = (ctx: ExtensionContext): AskFn | undefined => {
    const model = resolveModel(
      ctx.model as never,
      (ctx.modelRegistry ?? { find: () => undefined }) as never,
      stateModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, ctx.signal);
  };

  const pathFor = (ctx: ExtensionContext) => statePath(ctx.cwd, ctx.sessionManager.getSessionId());

  const writeFrom = async (ctx: ExtensionContext, messages: unknown[]) => {
    const ask = makeAsk(ctx);
    if (!ask) return;
    const path = pathFor(ctx);
    const md = await extractState(ask, flattenMessages(messages), readState(path));
    if (md) writeState(path, md);
    turnsSinceWrite = 0;
  };

  pi.on("turn_end", async () => {
    turnsSinceWrite += 1;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled()) return;
    if (turnsSinceWrite < everyTurns()) return;
    // 后台非阻塞：状态提炼是一次额外模型调用，不该拖住 agent_end / UI「运行中」。先同步重置计数，
    // 避免后台写入在途时下一轮 agent_end 重复触发（writeFrom 内部仍会再置 0，幂等无害）。
    turnsSinceWrite = 0;
    void writeFrom(ctx, event.messages as unknown[]).catch(() => {});
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled()) return;
    const entries = (event as { branchEntries?: Array<{ type: string; message?: unknown }> }).branchEntries ?? [];
    const messages = entries.filter((e) => e.type === "message" && e.message).map((e) => e.message);
    if (messages.length) await writeFrom(ctx, messages);
  });

  pi.on("session_compact", async () => {
    needReanchor = true;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!enabled() || !needReanchor) return undefined;
    needReanchor = false;
    const md = readState(pathFor(ctx));
    if (!md) return undefined;
    return { message: buildInjection(md, maxChars()) };
  });

  pi.registerCommand("session-state", {
    description: "查看当前会话的结构化工作状态：/session-state show",
    handler: async (_args, ctx) => {
      ctx.ui.notify(readState(pathFor(ctx)) ?? "暂无会话状态。", "info");
    },
  });
}
