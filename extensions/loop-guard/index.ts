// loop-guard: 相同工具调用的建议性提醒。对齐 deepseek-harness repeat-tool-reminder。
//
// 只跟踪「同一会话、同一工具、规范化参数完全相同」的连续次数。默认在第 3、5、8 次
// 把提醒追加到该次工具结果后面，调用本身照常执行。超过最高阈值后不再提醒。
// 不拦截，也不限制单轮工具调用总数。
//
// 计数在 tool_result：被更早扩展 block 的调用不会进入这个钩子（Pi 的 beforeToolCall
// 一旦 block 就跳过 afterToolCall），因此安全闸拒绝的尝试计不到。能产生结果的调用
// （含工具自己报错）都会计数。
//
// 配置（留空＝默认；写了非法值则该次工具结果报错，不悄悄改成别的数字）：
//   LOOP_GUARD=0                         关闭
//   LOOP_GUARD_THRESHOLDS=3,5,8          提醒次数，整数 >= 2，不可重复
//   LOOP_GUARD_INCLUDE=                  只跟踪这些工具（`*` 通配）；空表示全部
//   LOOP_GUARD_EXCLUDE=                  这些工具不计数也不重置连续次数
//   LOOP_GUARD_ARGUMENTS_PREVIEW=500     详细提醒中的参数预览长度
// 桌面设置页「安全 → 循环保护」写的是同一批键，保存后下一次工具调用即生效。
// LOOP_GUARD_REPEAT 与 LOOP_GUARD_MAX_CALLS 已停用。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { type Chain, appendReminder, nextChain, parseRepeatGuardConfig } from "./chain.js";

const enabled = () => (getConfig("LOOP_GUARD") ?? "1") !== "0";

function readConfig() {
  return parseRepeatGuardConfig({
    thresholds: getConfig("LOOP_GUARD_THRESHOLDS"),
    include: getConfig("LOOP_GUARD_INCLUDE"),
    exclude: getConfig("LOOP_GUARD_EXCLUDE"),
    argumentsPreviewChars: getConfig("LOOP_GUARD_ARGUMENTS_PREVIEW"),
  });
}

interface SessionState {
  chain?: Chain;
}

type SessionCtx = {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
};

function sessionKey(ctx: SessionCtx): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (id && id.length > 0) return id;
  return ctx.cwd ?? "";
}

let warnedRetired = false;
function warnRetired(): void {
  if (warnedRetired) return;
  if (getConfig("LOOP_GUARD_MAX_CALLS") === undefined && getConfig("LOOP_GUARD_REPEAT") === undefined) return;
  warnedRetired = true;
  console.error(
    "[loop-guard] LOOP_GUARD_REPEAT / LOOP_GUARD_MAX_CALLS 已停用。" +
      "现在只在相同调用达到 LOOP_GUARD_THRESHOLDS（默认 3,5,8）时追加提醒，不拦截，也不限制单轮总次数。",
  );
}

export default function (pi: ExtensionAPI) {
  console.error("[loop-guard] extension loaded");
  const bySession = new Map<string, SessionState>();

  const clear = (ctx: SessionCtx) => {
    bySession.delete(sessionKey(ctx));
  };

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled()) return undefined;
    warnRetired();
    const config = readConfig();
    const key = sessionKey(ctx);
    const prev = bySession.get(key);
    const step = nextChain(prev?.chain, event.toolName, event.input, config);
    if (step.kind === "skip") return undefined;
    bySession.set(key, { chain: step.chain });
    if (!step.reminder) return undefined;
    return {
      content: appendReminder(event.content ?? [], step.reminder) as typeof event.content,
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });

  // 新的用户消息换了任务上下文，跨消息的重复不算循环。压缩不重置。
  pi.on("before_agent_start", async (_event, ctx) => {
    clear(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clear(ctx);
  });
}
