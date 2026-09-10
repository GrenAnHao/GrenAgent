// compaction-policy: 上下文控制集合——
//   - ephemeral prune（`context` 钩子裁旧工具输出，默认关）
//   - context 压力分级指示（默认开）
//   - 用户驱动的「删任意段」（按 timestamp 把任意消息移出 LLM 上下文，可恢复；不删盘）
//   - 压缩接管（session_before_compact 预览/取消，默认关，fail-open）
// 纯扩展。删段经 /ctx-exclude /ctx-restore slash 命令驱动（不进 LLM 对话），会话内 appendEntry 持久 + 分支安全。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig, refreshConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentCwd } from "../_shared/workspace-context.js";
import {
  buildExclusionSet,
  contextExclusionConfigKey,
  type ExclusionOp,
  filterExcludedByTs,
  parseContextExclusionPulse,
  shouldApplyContextExclusionPulse,
} from "./exclusion.js";
import { classify } from "./pressure.js";
import { pruneMessages } from "./prune.js";

const pruneEnabled = () => (getConfig("COMPACTION_POLICY_PRUNE") ?? "0") !== "0";
const keepTurns = () => Number(getConfig("COMPACTION_POLICY_KEEP_TURNS") ?? "6") || 6;
const minBody = () => Number(getConfig("COMPACTION_POLICY_MIN_BODY") ?? "1000") || 1000;
const pressureEnabled = () => (getConfig("COMPACTION_POLICY_PRESSURE") ?? "1") !== "0";
// 压缩前确认：默认开。压缩会把靠前的对话摘要化（模型只看摘要），用户反馈「会话开头内容像被吞了 /
// 压缩后用量显示未知」，故默认改为压缩前弹确认，让用户看得到、可拒绝，而不是悄悄压。headless（无 UI）
// 仍直接放行（下方 !ctx.hasUI 守卫），不阻塞自动化 / bot 场景。
const compactPreview = () => (getConfig("COMPACTION_PREVIEW") ?? "1") !== "0";
// 确认超时（ms）：到点仍无人应答则 fail-open 放行压缩，避免「hasUI=true 但无人值守」时回合永久挂起。
// 0/空/非法 → 默认 180s（够有人值守时从容决定）；想永远等用户可设一个很大的值。
const compactPreviewTimeoutMs = () => {
  const raw = getConfig("COMPACTION_PREVIEW_TIMEOUT_MS");
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 180000;
};

export default function (pi: ExtensionAPI) {
  // 用户驱动的上下文排除集（按消息 timestamp）。来源：会话内 context_exclusion 自定义条目（分支安全），
  // session_start 回放重建。AgentMessage 无稳定 id 但有 timestamp，故按 timestamp 关联。
  let excluded = new Set<number>();
  let lastPulseRev = 0;
  let workspaceCwd: string | undefined;

  const applyOp = (op: ExclusionOp) => {
    if (op.op === "add") excluded.add(op.ts);
    else excluded.delete(op.ts);
    pi.appendEntry("context_exclusion", op);
  };

  const consumeDesktopPulse = () => {
    refreshConfig();
    const pulse = parseContextExclusionPulse(getConfig(contextExclusionConfigKey(workspaceCwd ?? currentCwd())));
    if (!pulse) return;
    const decision = shouldApplyContextExclusionPulse(pulse, lastPulseRev, excluded);
    lastPulseRev = decision.nextRev;
    if (decision.apply) applyOp({ op: pulse.op, ts: pulse.ts });
  };

  watchConfig(() => consumeDesktopPulse());

  pi.on("session_start", async (_event, ctx) => {
    workspaceCwd = ctx.cwd;
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const ops = entries
      .filter((e) => e.type === "custom" && e.customType === "context_exclusion")
      .map((e) => e.data as ExclusionOp);
    excluded = buildExclusionSet(ops);
    consumeDesktopPulse();
  });

  // context 钩子：先按排除集过滤（删任意段），再 prune（裁旧工具输出）。两者独立、可叠加。
  pi.on("context", async (event) => {
    consumeDesktopPulse();
    let msgs = event.messages;
    if (excluded.size > 0) {
      msgs = filterExcludedByTs(msgs as Array<{ timestamp?: number }>, excluded) as typeof msgs;
    }
    if (!pruneEnabled()) {
      return msgs === event.messages ? undefined : { messages: msgs };
    }
    const res = pruneMessages(msgs, { keepRecentTurns: keepTurns(), minBodyChars: minBody() });
    if (res.prunedCount === 0 && msgs === event.messages) return undefined;
    return { messages: res.messages };
  });

  // 删任意段：桌面经 /ctx-exclude <ts> / /ctx-restore <ts> 驱动（slash 命令被扩展拦截执行，不进 LLM 对话）。
  pi.registerCommand("ctx-exclude", {
    description: "把某条消息移出上下文（参数：消息 timestamp）",
    handler: async (args, ctx) => {
      const ts = Number(args.trim());
      if (!Number.isFinite(ts)) {
        ctx.ui.notify("用法：/ctx-exclude <timestamp>", "warning");
        return;
      }
      applyOp({ op: "add", ts });
      ctx.ui.notify("已移出上下文（对模型不可见）", "info");
    },
  });
  pi.registerCommand("ctx-restore", {
    description: "恢复被移出上下文的消息（参数：消息 timestamp）",
    handler: async (args, ctx) => {
      const ts = Number(args.trim());
      if (!Number.isFinite(ts)) {
        ctx.ui.notify("用法：/ctx-restore <timestamp>", "warning");
        return;
      }
      applyOp({ op: "remove", ts });
      ctx.ui.notify("已恢复到上下文", "info");
    },
  });

  // 压缩接管：默认开；压缩前用 ctx.ui 预览/取消。fail-open：UI 异常或超时未应答都放行默认压缩，
  // 决不因为这道确认把回合卡死。headless（无 UI）直接放行。
  pi.on("session_before_compact", async (event, ctx) => {
    if (!compactPreview() || !ctx.hasUI) return undefined;
    try {
      const n =
        (event as { preparation?: { messagesToSummarize?: unknown[] } }).preparation?.messagesToSummarize?.length ?? 0;
      const confirmP = ctx.ui.confirm(
        "压缩上下文（会把靠前的对话压成摘要）",
        `上下文接近上限。继续＝把约 ${n} 条较早的消息压成摘要以腾出空间（此后模型只看摘要）；` +
          `取消＝本次不压缩、保留原文（上下文可能很快不够用）。`,
      );
      const timeoutMs = compactPreviewTimeoutMs();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ok =
        timeoutMs > 0
          ? await Promise.race([
              confirmP,
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), timeoutMs);
              }),
            ])
          : await confirmP;
      if (timer) clearTimeout(timer);
      if (!ok) return { cancel: true };
      return undefined;
    } catch {
      return undefined;
    }
  });

  const updatePressure = (ctx: ExtensionContext) => {
    if (!pressureEnabled()) return;
    ctx.ui.setStatus("ctx", classify(ctx.getContextUsage()?.percent ?? null).label);
  };
  pi.on("turn_end", async (_event, ctx) => updatePressure(ctx));
  pi.on("agent_end", async (_event, ctx) => updatePressure(ctx));

  pi.registerCommand("compaction", {
    description: "查看上下文压力与 prune / 排除状态",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const { level, label } = classify(usage?.percent ?? null);
      ctx.ui.notify(
        `上下文：${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens（${label}，级别 ${level}）\n` +
          `压缩前确认：${compactPreview() ? "开" : "关"}\n` +
          `prune: ${pruneEnabled() ? "开" : "关"}（保护窗口 ${keepTurns()} 轮，最小裁剪 ${minBody()} 字符）\n` +
          `已移出上下文：${excluded.size} 条`,
        "info",
      );
    },
  });
}
