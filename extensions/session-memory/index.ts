// session-memory: maintain a structured working-state markdown for the session.
// 周期写入看对话末尾；压缩时读 Pi 准备好的待丢弃消息做唯一一次抽取，结果同时写状态文件、作压缩摘要。
// 状态文件第一行是分支锚点，不属于当前分支时不用。
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import {
  buildStateCompaction,
  canUseStateSummary,
  isStateCompaction,
  mergeFileLists,
  previousStateFileLists,
} from "./compaction.js";
import { buildInjection } from "./injector.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { serializeForSummary } from "./serialize.js";
import { readStateDoc, stateOnBranch, statePath, writeStateDoc } from "./store.js";
import { flattenMessages } from "./transcript.js";
import { extractCompactionState, extractState } from "./writer.js";

const enabled = () => (getConfig("SESSION_STATE_ENABLED") ?? "1") !== "0";
const everyTurns = () => Number(getConfig("SESSION_STATE_EVERY_TURNS") ?? "8") || 8;
const maxChars = () => Number(getConfig("SESSION_STATE_MAX_CHARS") ?? "4000") || 4000;
const stateModel = () => getConfig("SESSION_STATE_MODEL");

type BranchEntry = { type?: string; id?: string; message?: unknown; details?: unknown };

export default function (pi: ExtensionAPI) {
  let turnsSinceWrite = 0;
  let needReanchor = false;
  /** 写入序号：只有最新开始的写入能落盘，先开始后完成的作废。 */
  let writeSeq = 0;

  const makeAsk = (ctx: ExtensionContext, signal: AbortSignal | undefined): AskFn | undefined => {
    const model = resolveModel(
      ctx.model,
      ctx.modelRegistry ?? { find: () => undefined },
      stateModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, signal);
  };

  const pathFor = (ctx: ExtensionContext) => statePath(ctx.cwd, ctx.sessionManager.getSessionId());
  const branchOf = (ctx: ExtensionContext) => (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];

  /** 周期写入：对话末尾 12000 字符 + 属于当前分支的上一份状态。结果没变就不重写。 */
  const writeFrom = async (
    ctx: ExtensionContext,
    messages: unknown[],
    signal: AbortSignal | undefined,
    branch: BranchEntry[],
  ) => {
    const ask = makeAsk(ctx, signal);
    if (!ask) return;
    const seq = ++writeSeq;
    const path = pathFor(ctx);
    const anchor = branch.at(-1)?.id;
    const prev = stateOnBranch(readStateDoc(path), branch);
    const md = await extractState(ask, flattenMessages(messages), prev);
    if (md && md !== prev && seq === writeSeq) writeStateDoc(path, md, anchor);
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
    void writeFrom(ctx, event.messages as unknown[], ctx.signal, branchOf(ctx)).catch(() => {});
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled()) return undefined;
    const e = event as SessionBeforeCompactEvent;
    const branch = (e.branchEntries ?? []) as BranchEntry[];
    if (!canUseStateSummary(e)) {
      // 调用方带了附言或准备数据不全：摘要交给 Pi，状态照旧按对话末尾刷新，供压缩后注入。
      const messages = branch.filter((x) => x.type === "message" && x.message).map((x) => x.message);
      if (messages.length) await writeFrom(ctx, messages, e.signal, branch);
      return undefined;
    }
    const ask = makeAsk(ctx, e.signal);
    if (!ask) return undefined;
    const seq = ++writeSeq;
    const path = pathFor(ctx);
    const anchor = branch.at(-1)?.id;
    const p = e.preparation;
    const body = await extractCompactionState(ask, {
      prevState: stateOnBranch(readStateDoc(path), branch),
      previousSummary: p.previousSummary,
      conversation: serializeForSummary(p.messagesToSummarize ?? []),
      turnPrefix:
        p.isSplitTurn && p.turnPrefixMessages?.length ? serializeForSummary(p.turnPrefixMessages) : undefined,
    });
    if (!body || e.signal?.aborted) return undefined;
    if (seq === writeSeq) writeStateDoc(path, body, anchor);
    turnsSinceWrite = 0;
    const lists = mergeFileLists(p.fileOps, previousStateFileLists(branch));
    return { compaction: buildStateCompaction(body, p, lists) };
  });

  pi.on("session_compact", async (event) => {
    // 摘要就是状态时，下一轮不再注入同一份。
    needReanchor = !isStateCompaction(event as SessionCompactEvent);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!enabled() || !needReanchor) return undefined;
    needReanchor = false;
    const body = stateOnBranch(readStateDoc(pathFor(ctx)), branchOf(ctx));
    if (!body) return undefined;
    return { message: buildInjection(body, maxChars()) };
  });

  pi.registerCommand("session-state", {
    description: "查看当前会话的结构化工作状态：/session-state show",
    handler: async (_args, ctx) => {
      ctx.ui.notify(readStateDoc(pathFor(ctx))?.body ?? "暂无会话状态。", "info");
    },
  });
}
