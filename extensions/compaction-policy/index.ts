// compaction-policy: 上下文控制集合——
//   - 超大 toolResult 熔断（默认 80KB，不受 prune 开关 / keepTurns 限制）
//   - 按压力裁旧工具输出（`context` 钩子，默认开；缓存冷时定案、热时沿用，见 pressure-prune.ts）
//   - context 压力分级指示（默认开）
//   - 用户驱动的「删任意段」（按 timestamp 把任意消息移出 LLM 上下文，可恢复；不删盘）
//   - 上下文占用达到触发值时自动压缩（全局默认 80%，会话可覆盖；不再弹确认）
//     回合还没结束时，压完用隐藏消息续跑；模型已经说完则停住。手动压缩不走这里。
// 纯扩展。删段由宿主 agent_exclude_entry / agent_restore_entry 写 runtime pulse，
// watchConfig 应用；会话内 appendEntry 持久 + 分支安全。不再注册 TUI slash。
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
import { lastActivityMs, parsePruneTtlMs } from "./cache-warmth.js";
import { classify } from "./pressure.js";
import { emptyPruneState, runPressurePrune } from "./pressure-prune.js";
import { fuseOversizeToolResults } from "./prune.js";
import {
  AUTO_COMPACT_RESUME_TEXT,
  AUTO_COMPACT_RESUME_TYPE,
  isCompactionCancelled,
  shouldResumeAfterAutoCompact,
  viewAutoCompactTurn,
} from "./resume.js";
import { AUTO_COMPACT_OVERRIDES_KEY, AUTO_COMPACT_PERCENT_KEY, effectiveAutoCompactPercent } from "./threshold.js";

const pruneEnabled = () => (getConfig("COMPACTION_POLICY_PRUNE") ?? "1") !== "0";
const pruneTtlMs = () => parsePruneTtlMs(getConfig("COMPACTION_POLICY_PRUNE_TTL_MS"));
const keepTurns = () => Number(getConfig("COMPACTION_POLICY_KEEP_TURNS") ?? "6") || 6;
const minBody = () => Number(getConfig("COMPACTION_POLICY_MIN_BODY") ?? "1000") || 1000;
const pressureEnabled = () => (getConfig("COMPACTION_POLICY_PRESSURE") ?? "1") !== "0";
/** 单条 toolResult 超过该字符数即从本轮上下文裁掉（不受 prune 开关 / keepTurns 限制）。0 关闭。 */
const fuseChars = () => {
  const raw = getConfig("COMPACTION_POLICY_FUSE_CHARS");
  if (raw === "0") return 0;
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 80_000;
};
export default function (pi: ExtensionAPI) {
  // 用户驱动的上下文排除集（按消息 timestamp）。来源：会话内 context_exclusion 自定义条目（分支安全），
  // session_start 回放重建。AgentMessage 无稳定 id 但有 timestamp，故按 timestamp 关联。
  let excluded = new Set<number>();
  let lastPulseRev = 0;
  let workspaceCwd: string | undefined;
  // 进程内的裁剪计划：冷时定案、热时沿用。换会话、压缩后清空。
  let pruneState = emptyPruneState();

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
    pruneState = emptyPruneState();
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const ops = entries
      .filter((e) => e.type === "custom" && e.customType === "context_exclusion")
      .map((e) => e.data as ExclusionOp);
    excluded = buildExclusionSet(ops);
    consumeDesktopPulse();
  });

  // context 钩子：排除集 → 超大 toolResult 熔断 → 按压力裁旧工具输出。都只改发往模型的副本。
  pi.on("context", async (event, ctx) => {
    consumeDesktopPulse();
    let msgs = event.messages;
    if (excluded.size > 0) {
      msgs = filterExcludedByTs(msgs as Array<{ timestamp?: number }>, excluded) as typeof msgs;
    }
    const fused = fuseOversizeToolResults(msgs, fuseChars());
    if (fused.fusedCount > 0) msgs = fused.messages;
    if (pruneEnabled()) {
      const res = runPressurePrune(pruneState, {
        messages: msgs,
        now: Date.now(),
        lastActivity: lastActivityMs(event.messages, ctx.sessionManager?.getBranch?.() ?? []),
        ttlMs: pruneTtlMs(),
        usage: ctx.getContextUsage?.(),
        keepRecentTurns: keepTurns(),
        minBodyChars: minBody(),
      });
      pruneState = res.state;
      msgs = res.messages;
    }
    return msgs === event.messages ? undefined : { messages: msgs };
  });

  // 压缩不再询问。占用达到该会话的触发值就主动 compact，不等 pi 默认的「窗口减去固定 reserve」
  // （大窗口上那一档接近 100%，请求已经超过 max token，压缩调用自己也会失败）。
  // 未单独设置时用全局值，全局也未写时是 80。失败后先停手，直到占用掉回触发值以下再重新武装。
  let compactArmed = true;
  const maybeAutoCompact = (event: unknown, ctx: ExtensionContext) => {
    refreshConfig();
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null || !Number.isFinite(percent)) return;
    const threshold = effectiveAutoCompactPercent(
      {
        [AUTO_COMPACT_PERCENT_KEY]: getConfig(AUTO_COMPACT_PERCENT_KEY),
        [AUTO_COMPACT_OVERRIDES_KEY]: getConfig(AUTO_COMPACT_OVERRIDES_KEY),
      },
      ctx.sessionManager?.getSessionFile(),
    );
    if (percent < threshold) {
      compactArmed = true;
      return;
    }
    if (!compactArmed) return;
    compactArmed = false;
    // ctx.compact() 是手动压缩入口：先 abort 当前回合，压完不续跑。
    // 工具还没跑完、输出被截断、或还有排队消息时，压完再发一条隐藏消息把任务接上。
    const resume = shouldResumeAfterAutoCompact(
      viewAutoCompactTurn(event, ctx.hasPendingMessages?.() ?? false),
    );
    let resumed = false;
    const resumeAfterAutoCompact = (error?: { message?: string }) => {
      if (resumed || !resume) return;
      if (error && isCompactionCancelled(error.message ?? "")) return;
      resumed = true;
      pi.sendMessage(
        {
          customType: AUTO_COMPACT_RESUME_TYPE,
          content: AUTO_COMPACT_RESUME_TEXT,
          display: false,
        },
        { triggerTurn: true },
      );
    };
    ctx.compact({
      onComplete: () => resumeAfterAutoCompact(),
      onError: (error) => resumeAfterAutoCompact(error),
    });
  };
  pi.on("session_compact", async () => {
    compactArmed = true;
    pruneState = emptyPruneState();
  });
  pi.on("session_compact_failed", async () => {
    compactArmed = false;
  });

  const updatePressure = (ctx: ExtensionContext) => {
    if (!pressureEnabled()) return;
    ctx.ui.setStatus("ctx", classify(ctx.getContextUsage()?.percent ?? null).label);
  };
  pi.on("turn_end", async (event, ctx) => {
    updatePressure(ctx);
    maybeAutoCompact(event, ctx);
  });
  pi.on("agent_end", async (_event, ctx) => updatePressure(ctx));
}
