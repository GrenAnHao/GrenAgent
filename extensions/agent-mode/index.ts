// agent-mode: 统一的模式系统（Agent / Ask / Debug / Plan，互斥）。
//
// 取代原独立的 plan-mode：把"模式"做成一个可视化、可回读、可持久化的统一概念。
//   - Agent ：默认，完整工具集，无额外约束。
//   - Ask   ：纯只读问答。只保留只读工具——禁 写/编辑/命令行(bash)/MCP。
//   - Debug ：完整工具集 + 调试方法论 prompt（参考 Cursor Debug Mode：先假设→插桩→
//             复现取证→定位→最小修复→验证后清理插桩）。
//   - Plan  ：只读规划 + 只读白名单 bash，产出编号步骤并可一键转入执行。
//
// 工具 gate 走两道：setActiveTools 限制 LLM 可见工具（主） + tool_call hook 兜底拦截
// （防止动态注册的工具绕过）。当前模式经 ctx.ui.setStatus("agent-mode", <mode>) 推到前端，
// 前端据此渲染模式选择器并在切会话/刷新后回读，状态本身持久化到 session entry。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentMode,
  DEFAULT_MODE,
  activeToolsFor,
  gateToolCall,
  isAgentMode,
  modeLabel,
  parseModeArg,
  toolWhitelist,
} from "./modes.js";
import { buildPlanCard, makePlanId, renderPlanMarkdown, writePlanFile } from "./plan.js";
import { makeQuestionsId, normalizeQuestions, type RawAskUserParams } from "./questions.js";
import { type TodoItem, extractTodoItems, markCompletedSteps } from "./utils.js";

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
  todos?: TodoItem[];
  executing?: boolean;
  savedTools?: string[];
  planId?: string;
}

export default function (pi: ExtensionAPI) {
  console.error("[agent-mode] extension loaded");

  let currentMode: AgentMode = DEFAULT_MODE;
  // 进入受限模式（ask/plan）前的完整工具集，退出时还原（避免丢失 todo/kb/memory 等扩展工具）。
  let savedTools: string[] | undefined;
  // plan 的步骤跟踪：规划阶段产出 todoItems；用户点卡片「开始执行」（/plan-build）后 executionMode=true（此时已切回 agent 拿全工具）。
  let todoItems: TodoItem[] = [];
  let executionMode = false;
  // 最近一次规划产出的 plan id（对应 .pi/plans/<id>.md），随会话持久化，便于回看/关联执行。
  let planId: string | undefined;

  const persistState = () =>
    pi.appendEntry("agent-mode", {
      mode: currentMode,
      todos: todoItems,
      executing: executionMode,
      savedTools,
      planId,
    } satisfies PersistedState);

  // 把当前模式推给前端（模式选择器据此回读/高亮），并维护 plan 执行进度徽章。
  const pushStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("agent-mode", currentMode);
    if (executionMode && todoItems.length > 0) {
      const done = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", `执行中 ${done}/${todoItems.length}`);
    } else if (currentMode === "plan") {
      ctx.ui.setStatus("plan-mode", "Plan");
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
  };

  // 应用模式：按需抓取/还原完整工具集，设置受限工具集，推状态并持久化。
  // 不触碰 plan 子状态（todoItems/executionMode）——那由调用方按场景决定。
  const applyMode = (next: AgentMode, ctx: ExtensionContext, opts?: { silent?: boolean }) => {
    const wasRestricted = toolWhitelist(currentMode) !== undefined;
    const willRestrict = toolWhitelist(next) !== undefined;
    // 仅在「当前非受限」时抓取 savedTools，避免把已受限的集合误当成完整集合存下来。
    if (willRestrict && !wasRestricted) savedTools = pi.getActiveTools();

    currentMode = next;

    if (willRestrict) {
      pi.setActiveTools(activeToolsFor(next, savedTools ?? pi.getActiveTools()) ?? []);
    } else if (wasRestricted && savedTools) {
      pi.setActiveTools(savedTools);
    }

    pushStatus(ctx);
    persistState();
    if (!opts?.silent) ctx.ui.notify(`已切换到 ${modeLabel(next)} 模式`, "info");
  };

  // 用户主动切换模式：离开 plan 时一并清掉规划/执行子状态。
  const switchMode = (next: AgentMode, ctx: ExtensionContext) => {
    if (next !== "plan") {
      todoItems = [];
      executionMode = false;
    }
    applyMode(next, ctx);
  };

  pi.registerCommand("mode", {
    description: "切换模式：/mode agent | ask | debug | plan",
    handler: async (args, ctx) => {
      const next = parseModeArg(args);
      if (!next) {
        ctx.ui.notify(`用法：/mode agent|ask|debug|plan（当前：${currentMode}）`, "warning");
        return;
      }
      if (next === currentMode) {
        ctx.ui.notify(`已是 ${modeLabel(next)} 模式`, "info");
        return;
      }
      switchMode(next, ctx);
    },
  });

  // 兼容旧 /plan：在 plan 与 agent 间切换。
  pi.registerCommand("plan", {
    description: "切换规划模式（等价 /mode plan）",
    handler: async (_args, ctx) => {
      switchMode(currentMode === "plan" ? "agent" : "plan", ctx);
    },
  });

  // Plan 卡片「开始执行」按钮触发（前端 runCommand('/plan-build')）：切回 agent 拿全工具，
  // 保留 todoItems 进入执行阶段，并启动一轮执行。模型可由卡片先行切换（pi.setModel）。
  pi.registerCommand("plan-build", {
    description: "开始执行当前计划（由计划卡片的执行按钮调用）",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("没有可执行的计划步骤。", "warning");
        return;
      }
      applyMode("agent", ctx, { silent: true });
      executionMode = true;
      pushStatus(ctx);
      persistState();
      const first = todoItems[0]?.text;
      pi.sendMessage(
        {
          customType: "plan-execute",
          content: first ? `执行计划，从第一步开始：${first}` : "执行你刚制定的计划。",
          display: true,
        },
        { triggerTurn: true },
      );
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
        { description: "一个或多个问题（逐题在卡片内渲染）" },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = makeQuestionsId();
      const p = params as RawAskUserParams;
      if ((p.questions?.length ?? 0) > 8) {
        console.error(`[ask_user] 题目数 ${p.questions?.length} 超过上限 8，已截断。`);
      }
      const data = normalizeQuestions(p.questions ?? [], id, {
        allowExtra: p.allowExtra,
        allowExtraImages: p.allowExtraImages,
        extraPlaceholder: p.extraPlaceholder,
      });
      if (!data) {
        return {
          content: [{ type: "text", text: "ask_user：未提供有效问题（每个问题至少要有 question 文本）。" }],
        };
      }

      // 阻塞式富卡：整张卡 JSON 作载荷经 ctx.ui.input 传给前端；前端识别哨兵后在消息流末尾
      // 内联渲染富卡（皮肤/步骤/多选），用户作答后回传 `[我的选择] …` 文本 resolve 本次调用——
      // 与 MCP 交互一致，模型拿到真实答案前不会继续。ctx.ui 协议无法承载结构化数据，故走 input.title。
      if (ctx.hasUI) {
        const payload = JSON.stringify({ __askUser: 1, data });
        const answer = await ctx.ui.input(payload, undefined, { signal });
        if (typeof answer === "string" && answer.trim()) {
          return { content: [{ type: "text", text: answer }] };
        }
        return { content: [{ type: "text", text: "用户取消了 ask_user 选择（未作答）。" }] };
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
              "请停止当前回合，等待用户在卡片上选择并回复后再继续——不要替用户作答。",
          },
        ],
      };
    },
  });

  pi.on("tool_call", async (event) => gateToolCall(currentMode, event.toolName, event.input));

  pi.on("before_agent_start", async () => {
    // 执行阶段（currentMode 已切回 agent，但仍带着待办步骤）：注入剩余步骤。
    // 模式说明（ask/debug/plan）的提示词由 fable-behavior 的英文 mode slice 统一注入，
    // 此处不再注入中文模式 prompt，避免双份重复占用 token。
    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN]\nRemaining steps:\n${remaining}\nExecute in order; mark each finished step with [DONE:n] in your reply.`,
          display: false,
        },
      };
    }
    return undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;
    if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
      pushStatus(ctx);
      persistState();
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // 用户中断（abort）：直接收手，不做执行收尾、不弹"执行计划/留在规划"确认框。
    // 否则中断后会先冒出 Request was aborted、紧接着又弹出计划确认模态框。
    if (ctx.signal?.aborted) return;
    // 执行阶段：全部步骤完成则收尾，回到纯 Agent。
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        pi.sendMessage({ customType: "plan-complete", content: "**计划完成。**", display: true }, { triggerTurn: false });
        executionMode = false;
        todoItems = [];
        pushStatus(ctx);
        persistState();
      }
      return;
    }

    // 规划阶段：从最后一条助手消息提取编号步骤，写 .pi/plans/<id>.md，并在对话流产出一张
    // Plan 摘要卡（customType=agent-plan）。不再弹 modal——执行 / 继续改都在卡片上完成：
    // 卡片「开始执行」按钮经前端 runCommand('/plan-build') 转入执行；继续发消息则让 AI 改 plan。
    if (currentMode !== "plan") return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    const fullText = lastAssistant ? getTextContent(lastAssistant) : "";
    if (fullText) {
      const extracted = extractTodoItems(fullText);
      if (extracted.length > 0) todoItems = extracted;
    }
    // 没解析到可执行步骤：不产卡片（助手叙述已在对话流），也不打扰用户。
    if (todoItems.length === 0) return;

    const id = makePlanId();
    const card = buildPlanCard(id, fullText, todoItems, `.pi/plans/${id}.md`);
    try {
      writePlanFile(ctx.cwd, id, renderPlanMarkdown(card, fullText));
    } catch (err) {
      // 写文件失败不致命：卡片仍展示摘要与步骤，只是 View Plan 读不到全文。
      console.error("[agent-mode] 写入计划文件失败：", err);
    }
    planId = id;
    persistState();
    pi.sendMessage(
      { customType: "agent-plan", content: JSON.stringify(card), display: true },
      { triggerTurn: false },
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "agent-mode").pop();
    const data = entry?.data as PersistedState | undefined;
    if (data) {
      currentMode = isAgentMode(data.mode) ? data.mode : DEFAULT_MODE;
      todoItems = data.todos ?? [];
      executionMode = data.executing ?? false;
      savedTools = data.savedTools;
      planId = data.planId;
    } else {
      currentMode = DEFAULT_MODE;
      todoItems = [];
      executionMode = false;
      savedTools = undefined;
      planId = undefined;
    }
    // 恢复受限模式的工具集（agent/debug 无需限制）。
    if (toolWhitelist(currentMode)) {
      pi.setActiveTools(activeToolsFor(currentMode, savedTools ?? pi.getActiveTools()) ?? []);
    }
    pushStatus(ctx);
  });
}
