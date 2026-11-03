// gpt-with-taste：把 NB-Corp/gpt-with-taste 的行为配方接进 Pi。
//
// 为什么不是直接 `pi install git:github.com/NB-Corp/gpt-with-taste`：本仓库的扩展是编译进
// sidecar 的工厂清单（extensions/index.ts → allExtensions），装成独立包会和产品加载清单、
// 打包资源（copyPiAdjacentAssets）对不上。这里把上游 recipe/ 的六份文本落到 texts/，
// 由本工厂按请求投影，等价于上游 adapters/pi 的行为。
//
// 与上游 Pi 适配器的差别：
//   - 上游用 index.js / sub.js / independent.js 三个入口区分角色；这里一个工厂按会话身份判断
//     （subagent_meta / PI_IS_SUBAGENT / ALS origin → sub），显式角色可经 GPT_WITH_TASTE_ROLE 指定。
//   - 上游按 provider（openai / openai-codex）筛模型；本机 GPT 走自建 provider id，故按模型 id
//     前缀 gpt- 判（GPT_WITH_TASTE_MODEL_PATTERN 可覆盖）。
//
// 与 fable-behavior 的分工：两者都是行为层，同时注入会互相覆盖语气与纪律。taste 生效的那一轮
// 由它接管，fable 让位（判据共用 _shared/taste-scope.ts）；切回其他模型 fable 自动恢复。
//
// 文本与 steer 都是请求期投影，不写进会话日志：后台唤醒、goal 续跑不会重复累积整段文本。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentSession, subagentProbeOf } from "../agent-mode/ultra-rules.js";
import {
  branchEntriesOf,
  readTasteState,
  tasteApplies,
  tasteConfigEnabled,
  tasteScopeMatches,
  tasteScopeRegex,
  TASTE_STATE_TYPE,
  type TasteEntry,
  type TasteState,
} from "../_shared/taste-scope.js";
import { ensurePayloadInstructions } from "./payload.js";
import { projectMessages, TASTE_SECTION, tasteBlock, type ProjectedMessage } from "./projection.js";
import { loadTasteTexts, tasteTextsDir, type TasteRole } from "./texts.js";

/** 视为「协作方已完成」的自定义消息：后台子代理结算、代理间消息。 */
export const COMPLETED_RESULT_TYPES = ["subagent-settled", "agent-message"] as const;

const ROLE_OVERRIDE = "GPT_WITH_TASTE_ROLE";

/** 显式角色只能由加载方经环境变量指定（对应上游 sub.js / independent.js 两个入口）。 */
export function roleFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TasteRole | undefined {
  const override = (env[ROLE_OVERRIDE] ?? "").trim().toLowerCase();
  return override === "main" || override === "sub" || override === "independent" ? override : undefined;
}

export function roleOf(ctx: ExtensionContext): TasteRole {
  return roleFromEnv() ?? (isSubagentSession(subagentProbeOf(ctx)) ? "sub" : "main");
}

export interface TasteStatus {
  role: TasteRole;
  active: boolean;
  steering: boolean;
  provider: string;
  model: string;
}

/** 状态快照；`pending` 是命令刚写、尚未进分支的那份状态。 */
export function statusOf(
  ctx: ExtensionContext,
  entries: readonly TasteEntry[],
  pending?: TasteState,
): TasteStatus {
  const scopeEntries: readonly TasteEntry[] = pending
    ? [...entries, { type: "custom", customType: TASTE_STATE_TYPE, data: pending }]
    : entries;
  const effective = readTasteState(scopeEntries);
  return {
    role: roleOf(ctx),
    active:
      tasteConfigEnabled() &&
      tasteScopeMatches(ctx.model, tasteScopeRegex()) &&
      effective.enabled !== false,
    steering: tasteConfigEnabled() && effective.steering !== false,
    provider: String(ctx.model?.provider ?? "(unknown)"),
    model: ctx.model?.id ?? "(none)",
  };
}

export function formatStatus(status: TasteStatus): string {
  const lines = [
    `GPT with Taste · 角色 ${status.role}`,
    `生效：${status.active ? "是" : "否"} · 模型 ${status.provider}/${status.model}（匹配 ${tasteScopeRegex()}）`,
    `Steer：${status.steering ? "开" : "关"}`,
    `文本：${tasteTextsDir()}`,
  ];
  if (!status.active) {
    lines.push("未生效：当前模型不在范围内，或本会话已 /taste off，或 GPT_WITH_TASTE=0。");
  }
  return lines.join("\n");
}

export default function gptWithTaste(pi: ExtensionAPI) {
  const completedResultTypes = new Set<string>(COMPLETED_RESULT_TYPES);

  pi.on("context_with_system", (event, ctx) => {
    const texts = loadTasteTexts();
    if (!texts) return undefined;
    const entries = branchEntriesOf(ctx);
    const messages = projectMessages(event.messages as unknown as ProjectedMessage[], texts, {
      role: roleOf(ctx),
      active: tasteApplies({ model: ctx.model, entries }),
      steering: readTasteState(entries).steering !== false,
      completedResultTypes,
    });
    return { messages: messages as unknown as AgentMessage[] };
  });

  // 兜底：宿主或其它扩展用 forceSystemPrompt 顶掉结构化 sections 时，把整块补回报文。
  // 只补不改：已有指令、工具声明、结果正文一律保持原样。
  let warnedUnsupported = false;
  pi.on("before_provider_request", (event, ctx) => {
    const entries = branchEntriesOf(ctx);
    if (!tasteApplies({ model: ctx.model, entries })) return undefined;
    const texts = loadTasteTexts();
    if (!texts) return undefined;
    const result = ensurePayloadInstructions(event.payload, tasteBlock(texts, roleOf(ctx)));
    if (!result.supported && !warnedUnsupported) {
      ctx.ui.notify("GPT with Taste：最终报文格式无法识别，守卫未生效（系统段落注入仍然有效）。", "warning");
    }
    warnedUnsupported = !result.supported;
    return result.supported ? result.payload : undefined;
  });

  pi.registerCommand("taste", {
    description: "GPT with Taste：status / on / off / steer on / steer off / reset",
    handler: async (args, ctx) => {
      const command = (args ?? "").trim() || "status";
      if (!["status", "on", "off", "steer on", "steer off", "reset"].includes(command)) {
        ctx.ui.notify("用法：/taste status | on | off | steer on | steer off | reset", "warning");
        return;
      }
      const entries = branchEntriesOf(ctx);
      let pending: TasteState | undefined;
      if (command === "reset") pending = {};
      else if (command !== "status") {
        pending = { ...readTasteState(entries) };
        if (command === "on" || command === "off") pending.enabled = command === "on";
        else pending.steering = command === "steer on";
      }
      if (pending) pi.appendEntry(TASTE_STATE_TYPE, pending);
      ctx.ui.notify(formatStatus(statusOf(ctx, entries, pending)), "info");
    },
  });
}

export { TASTE_SECTION };
