// agent-mode: 统一的模式系统（Agent / Ask / Debug / Plan / Brainstorm，互斥）。
//
//   - Agent ：默认，完整工具集，无额外约束。
//   - Ask   ：只读问答。只读检索 + bash（写由只读 OS 沙箱执行，升权经用户批准）；禁 写/编辑/MCP。
//   - Debug ：完整工具集 + 调试方法论 prompt。
//   - Plan  ：只读调研 + upsert_plan 写结构化 Plan；侧栏审阅 / 修改后「确认执行」自动切 Agent 开跑。
//
// 工具 gate 走两道：setActiveTools 限制 LLM 可见工具（主） + tool_call hook 兜底拦截
// （防止动态注册的工具绕过）。当前模式经 ctx.ui.setStatus("agent-mode", <mode>) 推到前端，
// 状态本身持久化到 session entry。桌面切换走宿主 agent_set_mode：先写 live 再落盘；门闩现读 live；
// 工具集在下一轮 before_agent_start 对齐。
//
// Plan 是一等工件（见 .agents/notes/implemented/feature/2026-10-23-plan-mode-redesign.md）：
//   upsert_plan 写入 / 同 id 修订 → setStatus("agent-plan", 快照) 推侧栏；
//   侧栏经 /plan-update、/plan-confirm、/plan-cancel、/plan-finish 回写；
//   未确认（drafting / ready）时宿主拒绝手切到能动手的模式（planState.planBlocksModeSwitch）。
import { projectCwd } from "../_shared/session-cwd.js";
import { toolPrompt } from "../_shared/toolPrompt.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentSessionId } from "../_shared/workspace-context.js";
import {
  type AgentMode,
  DEFAULT_MODE,
  PLAN_ONLY_TOOLS,
  activeToolsFor,
  agentModeConfigKey,
  gateToolCall,
  getAgentMode,
  getDefaultAgentMode,
  hasAgentMode,
  isAgentMode,
  modeLabel,
  parseModeArg,
  setAgentMode,
  toolWhitelist,
  withoutPlanOnlyTools,
} from "./modes.js";
import {
  type Plan,
  type PlanStatus,
  type PlanStatusPayload,
  MAX_PLAN_STEPS,
  PLAN_STATUSES,
  allStepsDone,
  createPlan,
  isPlanOpen,
  isUnconfirmed,
  makePlanId,
  markDoneFromText,
  planEditedContext,
  planExecutionPrompt,
  planRefContent,
  planRemainingContext,
  revisePlan,
  validatePlanContent,
  withStatus,
  writePlanProjection,
} from "./plan.js";
import { PLAN_UNCONFIRMED_MESSAGE, isExecutingMode, setSessionPlan } from "./planState.js";
import {
  countValidQuestions,
  decodeAskUserAnswer,
  MAX_QUESTIONS,
  makeQuestionsId,
  normalizeQuestions,
  truncationNotice,
  type RawAskUserParams,
} from "./questions.js";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

interface PersistedState {
  mode?: AgentMode;
  savedTools?: string[];
  plan?: Plan;
  /** 模型最后见过的 Plan 版本；用户在侧栏改过（rev 更大）时下一轮规划把新版本告诉模型。 */
  planSeenRev?: number;
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  drafting: "草稿",
  ready: "待确认",
  confirmed: "已确认",
  executing: "执行中",
  done: "已完成",
  cancelled: "已取消",
};

/** 会话条目里读回的 Plan：只做形状检查，旧版卡片数据（todos / executing）一律不认。 */
export function restorePlan(raw: unknown): Plan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<Plan>;
  if (typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.steps)) return undefined;
  if (!PLAN_STATUSES.includes(p.status as PlanStatus)) return undefined;
  return {
    id: p.id,
    title: p.title,
    goal: typeof p.goal === "string" ? p.goal : "",
    steps: p.steps
      .filter((s): s is { text: string; done: boolean } => Boolean(s) && typeof (s as { text?: unknown }).text === "string")
      .map((s) => ({ text: s.text, done: s.done === true })),
    risks: Array.isArray(p.risks) ? p.risks.filter((r): r is string => typeof r === "string") : [],
    status: p.status as PlanStatus,
    rev: typeof p.rev === "number" ? p.rev : 1,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
    updatedBy: p.updatedBy === "user" ? "user" : "model",
    ...(typeof p.file === "string" ? { file: p.file } : {}),
  };
}

/** 会话里最近一条模式：本扩展的 agent-mode 条目或宿主切换写的 session-controls 条目。 */
export function persistedMode(entries: Array<{ type: string; customType?: string; data?: unknown }>): AgentMode | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "custom") continue;
    const data = e.data as { mode?: unknown } | undefined;
    if ((e.customType === "agent-mode" || e.customType === "session-controls") && isAgentMode(data?.mode)) return data.mode;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  console.error("[agent-mode] extension loaded");

  let sessionCtx: ExtensionContext | undefined;
  // 本会话 id：模式按会话存，切会话不跟着别的会话走。
  let sessionId: string | undefined;
  const liveMode = (cwd?: string) => getAgentMode(cwd ?? sessionCtx?.cwd, sessionId);
  let currentMode: AgentMode = DEFAULT_MODE;
  // 进入受限模式（ask/plan）前的完整工具集，退出时还原（避免丢失动态扩展工具）。
  let savedTools: string[] | undefined;
  // 本会话绑定的 Plan（源真值，随会话条目持久化）。
  let plan: Plan | undefined;
  let planSeenRev = 0;
  // 本轮（一次 agent run）里 upsert_plan 有没有成功过：规划回合结束时没有工件要显式报出来。
  let upsertedThisRun = false;
  // 确认执行那一轮的开跑消息已带全文步骤，不再重复注入剩余步骤。
  let skipNextExecutionContext = false;

  const persistState = () =>
    pi.appendEntry("agent-mode", {
      mode: currentMode,
      savedTools,
      ...(plan ? { plan, planSeenRev } : {}),
    } satisfies PersistedState);

  const pushPlan = (ctx: ExtensionContext, reason: PlanStatusPayload["reason"]) => {
    ctx.ui.setStatus("agent-plan", JSON.stringify({ plan: plan ?? null, reason } satisfies PlanStatusPayload));
  };

  // 把当前模式推给前端（模式选择器据此回读/高亮），并维护 plan 执行进度徽章。
  const pushStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("agent-mode", currentMode);
    // 项目默认模式：草稿输入栏显示用（新会话将继承它）。
    ctx.ui.setStatus("agent-mode-default", getDefaultAgentMode(projectCwd(ctx)));
    if (plan?.status === "executing") {
      const done = plan.steps.filter((t) => t.done).length;
      ctx.ui.setStatus("plan-mode", `执行中 ${done}/${plan.steps.length}`);
    } else if (currentMode === "plan") {
      ctx.ui.setStatus("plan-mode", "Plan");
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
  };

  /** 换 Plan：同步宿主共享表、写 MD 投影、持久化、推侧栏和徽章。 */
  const setPlan = (next: Plan | undefined, ctx: ExtensionContext, reason: PlanStatusPayload["reason"]) => {
    if (next) {
      try {
        next = { ...next, file: writePlanProjection(ctx.cwd, next) };
      } catch (err) {
        // 投影写失败不影响源真值：侧栏照常显示与确认。
        console.error("[agent-mode] 写入计划投影失败：", err);
      }
    }
    plan = next;
    setSessionPlan(sessionId, next);
    persistState();
    pushPlan(ctx, reason);
    pushStatus(ctx);
  };

  // 按模式对齐激活工具：受限模式取白名单交集（plan 额外带上 upsert_plan，它默认不激活），
  // 其余模式还原完整集合并去掉只属于规划模式的工具。
  const syncTools = (mode: AgentMode, restoreFrom?: string[]) => {
    if (toolWhitelist(mode)) {
      const picked = activeToolsFor(mode, savedTools ?? pi.getActiveTools()) ?? [];
      if (mode === "plan") for (const t of PLAN_ONLY_TOOLS) if (!picked.includes(t)) picked.push(t);
      pi.setActiveTools(picked);
    } else if (restoreFrom) {
      pi.setActiveTools(withoutPlanOnlyTools(restoreFrom));
    }
  };

  // 应用模式：按需抓取/还原完整工具集，设置受限工具集，推状态并持久化。不触碰 Plan。
  const applyMode = (next: AgentMode, ctx: ExtensionContext, opts?: { silent?: boolean; persist?: boolean }) => {
    const wasRestricted = toolWhitelist(currentMode) !== undefined;
    const willRestrict = toolWhitelist(next) !== undefined;
    // 仅在「当前非受限」时抓取 savedTools，避免把已受限的集合误当成完整集合存下来。
    if (willRestrict && !wasRestricted) savedTools = withoutPlanOnlyTools(pi.getActiveTools());

    currentMode = next;
    setAgentMode(next, projectCwd(ctx), sessionId);
    syncTools(next, wasRestricted ? savedTools : undefined);

    pushStatus(ctx);
    if (opts?.persist !== false) persistState();
    if (!opts?.silent) ctx.ui.notify(`已切换到 ${modeLabel(next)} 模式`, "info");
  };

  // 盘上的项目默认模式变了：只更新默认（给新会话继承），不改已打开会话的模式。
  // 当前会话的切换由宿主直接写会话内存，before_agent_start 按 live 对齐工具集。
  // 每个会话（含子代理）各订一份，会话结束退订。
  const unwatch = watchConfig((next) => {
    if (!sessionCtx) return;
    const parsed = parseModeArg(next[agentModeConfigKey(projectCwd(sessionCtx))] ?? "");
    if (!sessionId) {
      // 无会话身份时只有项目级模式可用：沿用旧行为，直接切。
      if (parsed && parsed !== getAgentMode(projectCwd(sessionCtx))) applyMode(parsed, sessionCtx);
      return;
    }
    if (!parsed || parsed === getDefaultAgentMode(projectCwd(sessionCtx))) return;
    setAgentMode(parsed, projectCwd(sessionCtx));
  });
  pi.on("session_shutdown", () => {
    unwatch();
    setSessionPlan(sessionId, undefined);
  });

  // brainstorm-deliver：从头脑风暴模式进入交付阶段，自动切回 Agent 模式并触发执行。
  // AI 在确认设计、准备开始实施时调用，省去用户手动切换模式的操作。
  pi.registerCommand("brainstorm-deliver", {
    description: "从头脑风暴切换到 Agent 模式并开始实施（由 AI 在交付阶段调用）",
    handler: async (args, ctx) => {
      if (liveMode(projectCwd(ctx)) !== "brainstorm") {
        ctx.ui.notify("当前不在头脑风暴模式，无需切换。", "info");
        return;
      }
      applyMode("agent", ctx, { silent: true });
      ctx.ui.notify("已自动切换到 Agent 模式，开始实施。", "info");
      const deliverMessage = args.trim() || "设计已确认，现在开始实施。请按已讨论的方案动手。";
      pi.sendMessage(
        { customType: "brainstorm-deliver", content: deliverMessage, display: true },
        { triggerTurn: true },
      );
    },
  });

  // ── Plan：侧栏回写的命令（前端 runCommand 调用，不进模型上下文） ──

  /** 命令参数里的 planId 要对得上本会话的 Plan；对不上时提示并返回 undefined。 */
  const planFor = (id: string | undefined, ctx: ExtensionContext): Plan | undefined => {
    if (!plan || !id || plan.id !== id) {
      ctx.ui.notify("找不到这份计划（可能已被新的计划取代）。", "warning");
      return undefined;
    }
    return plan;
  };

  pi.registerCommand("plan-update", {
    description: "保存侧栏里改过的计划（由计划面板调用）",
    handler: async (args, ctx) => {
      let raw: { planId?: unknown; rev?: unknown } & Record<string, unknown>;
      try {
        raw = JSON.parse(args);
      } catch {
        ctx.ui.notify("计划保存失败：参数不是合法 JSON。", "error");
        return;
      }
      const current = planFor(typeof raw.planId === "string" ? raw.planId : undefined, ctx);
      if (!current) return;
      if (!isUnconfirmed(current)) {
        ctx.ui.notify(`计划${STATUS_LABELS[current.status]}，不能再修改。`, "warning");
        return;
      }
      if (typeof raw.rev === "number" && raw.rev !== current.rev) {
        ctx.ui.notify(`计划已更新到第 ${current.rev} 版，请载入最新版本后再改。`, "warning");
        return;
      }
      const checked = validatePlanContent(raw);
      if (!checked.ok) {
        ctx.ui.notify(`计划保存失败：${checked.error}`, "error");
        return;
      }
      setPlan(revisePlan(current, checked.value, Date.now(), "user"), ctx, "updated");
      ctx.ui.notify(`计划已保存（第 ${plan!.rev} 版）。`, "info");
    },
  });

  pi.registerCommand("plan-confirm", {
    description: "确认执行计划：自动切到 Agent 模式并开跑（由计划面板调用）",
    handler: async (args, ctx) => {
      const [id, revRaw] = args.trim().split(/\s+/);
      const current = planFor(id, ctx);
      if (!current) return;
      if (current.status !== "ready") {
        ctx.ui.notify(`计划${STATUS_LABELS[current.status]}，不能确认执行。`, "warning");
        return;
      }
      if (revRaw && Number(revRaw) !== current.rev) {
        ctx.ui.notify(`计划已更新到第 ${current.rev} 版，请先看过最新版本再确认。`, "warning");
        return;
      }
      if (ctx.isIdle?.() === false) {
        ctx.ui.notify("会话正在运行，等这一轮结束再确认执行。", "warning");
        return;
      }
      // 单一编排：先落 confirmed（宿主守卫放行），再切 Agent 拿全工具，再进 executing 并开跑。
      const now = Date.now();
      setPlan(withStatus(current, "confirmed", now), ctx, "updated");
      applyMode("agent", ctx, { silent: true });
      setPlan(withStatus(plan!, "executing", now), ctx, "updated");
      skipNextExecutionContext = true;
      ctx.ui.notify("计划已确认，切到 Agent 模式开始执行。", "info");
      pi.sendMessage(
        { customType: "plan-execute", content: planExecutionPrompt(plan!), display: true },
        { triggerTurn: true },
      );
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "取消当前计划（由计划面板调用）",
    handler: async (args, ctx) => {
      const current = planFor(args.trim().split(/\s+/)[0], ctx);
      if (!current) return;
      if (!isPlanOpen(current)) {
        ctx.ui.notify(`计划${STATUS_LABELS[current.status]}。`, "info");
        return;
      }
      setPlan(withStatus(current, "cancelled", Date.now()), ctx, "updated");
      ctx.ui.notify("计划已取消。", "info");
    },
  });

  pi.registerCommand("plan-finish", {
    description: "把执行中的计划标记为完成（由计划面板调用）",
    handler: async (args, ctx) => {
      const current = planFor(args.trim().split(/\s+/)[0], ctx);
      if (!current) return;
      if (current.status !== "executing") {
        ctx.ui.notify(`计划${STATUS_LABELS[current.status]}，不能标记完成。`, "warning");
        return;
      }
      setPlan(withStatus(current, "done", Date.now()), ctx, "updated");
      ctx.ui.notify("计划已标记完成。", "info");
    },
  });

  // ── Plan：模型写计划的唯一入口 ──
  pi.registerTool({
    name: "upsert_plan",
    label: "Upsert Plan",
    description:
      "在规划（Plan）模式下写入或修订本会话的结构化计划。计划显示在用户的右侧计划面板，" +
      "用户可以在那里修改步骤并点「确认执行」——确认后会自动切到 Agent 模式开跑，你不能自己开始执行。" +
      "省略 planId 时：会话已有未确认的计划就修订它（同一 id），否则新建。传 planId 必须是当前计划的 id。" +
      "每次调用都传完整内容（title / goal / steps 全量覆盖，不是增量补丁）。参数不合法会返回错误，修正后重试。",
    ...toolPrompt("Write or revise this session's structured plan (plan mode only).", [
      "In plan mode, deliver the plan only by calling upsert_plan — never as a `Plan:` list in reply text; a planning turn that ends without upsert_plan is reported to the user as a failure.",
      "Call upsert_plan with the full content every time (title, goal, every step in full detail with target files/interfaces); it replaces the previous revision of the same planId. Omit planId to revise the open plan or start the first one.",
      "After upsert_plan succeeds, tell the user to review it in the plan panel and click 确认执行; do not start executing, and do not ask them to switch modes by hand.",
    ]),
    defaultActive: false,
    parameters: Type.Object({
      planId: Type.Optional(Type.String({ description: "要修订的计划 id（上一次 upsert_plan 返回的）。省略则修订当前未确认的计划或新建" })),
      title: Type.String({ description: "一句话标题" }),
      goal: Type.String({ description: "目标与验收标准：做什么、怎么算完成、关键取舍" }),
      steps: Type.Array(Type.String({ description: "一个步骤的完整描述（含目标文件 / 接口），不要缩写" }), {
        description: `按执行顺序的步骤，最多 ${MAX_PLAN_STEPS} 项`,
        maxItems: MAX_PLAN_STEPS,
      }),
      risks: Type.Optional(Type.Array(Type.String(), { description: "风险与回滚要点（可选）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (liveMode(ctx?.cwd) !== "plan") throw new Error("upsert_plan 只在规划（Plan）模式可用。");
      const checked = validatePlanContent(params);
      if (!checked.ok) throw new Error(`upsert_plan 参数不合法：${checked.error}`);
      const requested = typeof params.planId === "string" && params.planId.trim() ? params.planId.trim() : undefined;
      const open = isUnconfirmed(plan) ? plan : undefined;
      if (requested && requested !== open?.id) {
        throw new Error(
          open
            ? `planId「${requested}」不是当前计划（当前为 ${open.id}）。修订请传 ${open.id}，或省略 planId。`
            : `planId「${requested}」不存在或已结束。省略 planId 以新建计划。`,
        );
      }
      const now = Date.now();
      const created = !open;
      const next = open ? revisePlan(open, checked.value, now, "model") : createPlan(makePlanId(new Date(now)), checked.value, now);
      planSeenRev = next.rev;
      upsertedThisRun = true;
      setPlan(next, ctx, created ? "created" : "updated");
      // 对话流里每份计划只放一张摘要卡；修订不再发。
      if (created) pi.sendMessage({ customType: "agent-plan", content: planRefContent(next), display: true }, { triggerTurn: false });
      const saved = plan!;
      const text =
        `计划已${created ? "创建" : "修订"}：${saved.id}（第 ${saved.rev} 版，${saved.steps.length} 步，状态 ${saved.status}）。` +
        (saved.status === "ready"
          ? "用户会在右侧计划面板审阅并点「确认执行」；不要自己开始执行。"
          : "步骤为空，计划仍是草稿；补上步骤后再次调用 upsert_plan。");
      return { content: [{ type: "text", text }], details: { planId: saved.id, rev: saved.rev, status: saved.status } };
    },
  });

  // ask_user：对话流内提问卡（不弹窗）。AI 需要用户在若干选项中决策时调用，产出一张
  // agent-questions 卡片（前端渲染为 A/B/C/D 多选 + Continue/Skip），随后停下等用户选择回传。
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "向用户提一个或多个选择题，让用户在可点击的选项卡上做选择。" +
      "当你需要用户在若干选项中做决策（选方案 / 测验答题 / 确认方向 / 风险操作前确认等）时调用。" +
      "禁止在 assistant 正文里写 A/B/C/D 纯文本选项——必须用本工具。" +
      "本工具会阻塞直到用户作答，并把用户的选择作为工具结果返回（形如 [我的选择] …）——不要替用户作答，也不要预测答案。",
    promptSnippet: "Ask the user a clickable multiple-choice question.",
    promptGuidelines: [
      "When a decision has 2+ concrete viable options for the user to pick — approach/scope/tradeoff, framework or file-path choice, quiz answer, plan-mode clarification, or confirmation before a risky/irreversible action — call ask_user instead of deciding silently.",
      "This is the ONLY way to surface choices: never write A/B/C/D (or numbered) option lists in your reply text — plain-text options are not clickable and the user cannot answer them.",
      "The card shows only the question text and the option labels — it cannot render code, command output, tables, or diagrams. Put any context the question depends on in your reply BEFORE calling the tool (e.g. show the code, then ask what it prints).",
      "Autonomy still applies: when the answer is discoverable from the repo (read/grep first) or a single recommendation is obviously right, just act — reserve ask_user for genuine forks where the user's preference changes the outcome.",
      "ask_user BLOCKS until the user answers and returns their choice as the tool result (a `[我的选择]` block) — never pre-fill, guess, or answer the question yourself. State your recommendation in the question text; keep 2–5 short, mutually exclusive options.",
    ],
    parameters: Type.Object({
      allowExtra: Type.Optional(
        Type.Boolean({ description: "是否允许用户填写补充说明（文本，可选贴图），默认 false" }),
      ),
      allowExtraImages: Type.Optional(
        Type.Boolean({ description: "allowExtra 为 true 时是否允许贴图，默认 true" }),
      ),
      extraPlaceholder: Type.Optional(Type.String({ description: "补充说明输入框占位提示" })),
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "问题文本" }),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                id: Type.Optional(Type.String({ description: "选项 id（省略则自动编号）" })),
                label: Type.String({ description: "选项显示文本" }),
              }),
              { description: "选项列表（建议 2-5 个）" },
            ),
          ),
          allowMultiple: Type.Optional(Type.Boolean({ description: "是否允许多选，默认单选" })),
          allowCustom: Type.Optional(
            Type.Boolean({ description: "是否提供「其他/自定义」选项（选中后需填写文本）" }),
          ),
          customLabel: Type.Optional(Type.String({ description: "自定义选项标签，默认「其他（自定义）」" })),
        }),
        { description: `一个或多个问题（逐题分页渲染），最多 ${MAX_QUESTIONS} 题`, maxItems: MAX_QUESTIONS },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = makeQuestionsId();
      const p = params as RawAskUserParams;
      const notice = truncationNotice(countValidQuestions(p.questions ?? []));
      if (notice) console.error(`[ask_user] ${notice}`);
      const data = normalizeQuestions(p.questions ?? [], id, {
        allowExtra: p.allowExtra,
        allowExtraImages: p.allowExtraImages,
        extraPlaceholder: p.extraPlaceholder,
      });
      if (!data) {
        return {
          content: [{ type: "text", text: "ask_user：未提供有效问题（每个问题至少要有 question 文本）。" }],
          details: undefined,
        };
      }

      // 阻塞式富卡：整张卡 JSON 作载荷经 ctx.ui.input 传给前端；前端识别哨兵后在消息流末尾
      // 内联渲染富卡（皮肤/步骤/多选），用户作答后回传 `[我的选择] …` 文本 resolve 本次调用——
      // 与 MCP 交互一致，模型拿到真实答案前不会继续。ctx.ui 协议无法承载结构化数据，故走 input.title。
      if (ctx.hasUI) {
        const payload = JSON.stringify({ __askUser: 1, data });
        const answer = await ctx.ui.input(payload, undefined, { signal });
        const decoded = decodeAskUserAnswer(answer);
        if (decoded.text.trim() || decoded.images.length > 0) {
          const text = [decoded.text.trim() ? decoded.text : "", notice ?? ""].filter(Boolean).join("\n\n");
          return {
            content: [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...decoded.images,
            ],
            details: undefined,
          };
        }
        return { content: [{ type: "text", text: "用户取消了 ask_user 选择（未作答）。" }], details: undefined };
      }

      // 非交互模式（print / 无对话框 UI）：退回到对话流卡片（非阻塞），并提示模型停下等待。
      pi.sendMessage(
        { customType: "agent-questions", content: JSON.stringify(data), display: true },
        { triggerTurn: false },
      );
      return {
        content: [
          {
            type: "text",
            text:
              `已在对话流展示提问卡片（${data.questions.length} 个问题）。当前环境不支持阻塞式对话框，` +
              "请停止当前回合，等待用户在卡片上选择并回复后再继续——不要替用户作答。" +
              (notice ? `\n\n${notice}` : ""),
          },
        ],
        details: undefined,
      };
    },
  });

  pi.on("tool_call", async (event, ctx) =>
    gateToolCall(liveMode(ctx?.cwd), event.toolName, event.input),
  );

  pi.on("before_agent_start", async () => {
    upsertedThisRun = false;
    if (sessionCtx) {
      let live = liveMode();
      // 兜底：未确认的计划不允许经任何路径进入能动手的模式（宿主切换已先拦一道）。
      if (isExecutingMode(live) && isUnconfirmed(plan)) {
        setAgentMode("plan", projectCwd(sessionCtx), sessionId);
        live = "plan";
        sessionCtx.ui.notify(PLAN_UNCONFIRMED_MESSAGE, "warning");
      }
      if (live !== currentMode) applyMode(live, sessionCtx, { silent: true });
    }
    // 模式说明（ask/debug/plan）的提示词由 fable-behavior 的英文 mode slice 统一注入，此处不再注入。
    if (plan?.status === "executing") {
      if (skipNextExecutionContext) {
        skipNextExecutionContext = false;
        return undefined;
      }
      return {
        message: { customType: "plan-execution-context", content: planRemainingContext(plan), display: false },
      };
    }
    // 规划阶段：用户在侧栏改过计划，把当前版本告诉模型，避免它按旧版修订。
    if (currentMode === "plan" && plan && isUnconfirmed(plan) && plan.rev !== planSeenRev) {
      planSeenRev = plan.rev;
      persistState();
      return { message: { customType: "plan-edited-context", content: planEditedContext(plan), display: false } };
    }
    return undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (plan?.status !== "executing") return;
    if (!isAssistantMessage(event.message)) return;
    const marked = markDoneFromText(plan, getTextContent(event.message), Date.now());
    if (marked.changed > 0) setPlan(marked.plan, ctx, "updated");
  });

  pi.on("agent_end", async (event, ctx) => {
    // 用户中断（abort）：直接收手，不做执行收尾、不报规划失败。
    if (ctx.signal?.aborted) return;
    if ((event as { willRetry?: boolean }).willRetry === true) return;

    if (plan?.status === "executing") {
      if (allStepsDone(plan)) {
        setPlan(withStatus(plan, "done", Date.now()), ctx, "updated");
        pi.sendMessage({ customType: "plan-complete", content: "**计划完成。**", display: true }, { triggerTurn: false });
      }
      return;
    }

    // 规划回合结束却没有可审阅的计划：显式报出来，不回退到解析正文。
    if (liveMode(ctx.cwd) !== "plan" || upsertedThisRun || isPlanOpen(plan)) return;
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") return;
    pi.sendMessage(
      {
        customType: "agent-plan-missing",
        content: "本轮规划没有产出计划：模型没有调用 upsert_plan。可以补充需求或直接要求它调用 upsert_plan 写出计划。",
        display: true,
      },
      { triggerTurn: false },
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId?.() || undefined;
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "agent-mode").pop();
    const data = entry?.data as PersistedState | undefined;
    currentMode = data && isAgentMode(data.mode) ? data.mode : DEFAULT_MODE;
    savedTools = data?.savedTools;
    plan = restorePlan(data?.plan);
    planSeenRev = typeof data?.planSeenRev === "number" ? data.planSeenRev : plan?.rev ?? 0;
    upsertedThisRun = false;
    skipNextExecutionContext = false;
    setSessionPlan(sessionId, plan);
    pushPlan(ctx, "sync");

    if (!sessionId) {
      // 无会话身份（旧 worker / 测试桩）：沿用项目级行为，已写入的 live 优先，其次盘上，再会话条目。
      if (!hasAgentMode(projectCwd(ctx))) {
        const fromFile = parseModeArg(getConfig(agentModeConfigKey(projectCwd(ctx))) ?? "");
        const next = fromFile ?? persistedMode(entries) ?? DEFAULT_MODE;
        applyMode(next, ctx, { silent: true, persist: false });
        return;
      }
    } else if (!hasAgentMode(projectCwd(ctx))) {
      setAgentMode(parseModeArg(getConfig(agentModeConfigKey(projectCwd(ctx))) ?? "") ?? DEFAULT_MODE, projectCwd(ctx));
    }
    if (sessionId && !hasAgentMode(projectCwd(ctx), sessionId)) {
      // 会话自己记的模式优先（宿主切换写的 session-controls 与本扩展的 agent-mode 取最近一条）；
      // 没有时继承 ALS 里的父会话（子代理），再退项目默认。
      const own = persistedMode(entries);
      const parent = currentSessionId();
      const inherited = parent && parent !== sessionId && hasAgentMode(projectCwd(ctx), parent)
        ? getAgentMode(projectCwd(ctx), parent)
        : undefined;
      applyMode(own ?? inherited ?? getDefaultAgentMode(projectCwd(ctx)), ctx, { silent: true, persist: false });
      return;
    }

    const live = liveMode(projectCwd(ctx));
    if (live !== currentMode) {
      applyMode(live, ctx, { silent: true });
      return;
    }
    syncTools(currentMode, savedTools);
    pushStatus(ctx);
  });
}
