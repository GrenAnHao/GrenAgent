// 模式定义与纯逻辑：工具白名单、工具调用 gate、命令参数解析、徽章/标签。
// 无 I/O，便于单测。状态机与副作用（setActiveTools/setStatus/persist）在 index.ts。
import { isSafeCommand } from "./utils.js";

export type AgentMode = "agent" | "ask" | "debug" | "plan";

export const AGENT_MODES: readonly AgentMode[] = ["agent", "ask", "debug", "plan"] as const;

export const DEFAULT_MODE: AgentMode = "agent";

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);
}

// ask：纯只读问答。白名单为经核实存在的只读工具（工具名取自各扩展的 registerTool）：
//   - pi 内置：read / grep / find / ls
//   - 联网只读：fetch_url / fetch_llms / fetch_html / fetch_markdown / fetch_txt / fetch_json（web-fetch）、
//     web_search / web_search_multi / fetch_web_content / fetch_github_readme（web-search）
//   - 本地只读检索：search（batch-tools 多正则/glob 本地检索）、code_search（code-search）、kb_search（knowledge-rag）、
//     memory_recall（long-term-memory）、history_search（session-search）、git_diff（code-review）
//   - 交互/只读视图（不改文件）：ask_user（agent-mode 提问卡）、hl_read（hashline 带 #TAG 的只读视图）
// 写类(write/edit/kb_add/memory_save/review_note/todo/generate_image/speak)、命令行(bash)、
// 子代理(spawn_agent/explore_context)、外部命令(diagnostics)、MCP(<server>__*) 一律不在白名单，
// 经 setActiveTools 隐藏 + tool_call 兜底双重拦截。多列的名字若当前不可用，会在 activeToolsFor 交集中被滤除。
export const ASK_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "fetch_url",
  "fetch_llms",
  "fetch_html",
  "fetch_markdown",
  "fetch_txt",
  "fetch_json",
  "web_search",
  "web_search_multi",
  "fetch_web_content",
  "fetch_github_readme",
  "search",
  "code_search",
  "kb_search",
  "memory_recall",
  "history_search",
  "git_diff",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_diagnostics",
  "lsp_document_symbols",
  "hl_read",
  "ask_user",
];

// plan：在 ask 的只读集之上额外放行 bash（再由 isSafeCommand 限定为只读命令），与既有规划模式一致。
export const PLAN_TOOLS: readonly string[] = [...ASK_TOOLS, "bash"];

// 受限模式返回白名单；agent/debug 用完整工具集（返回 undefined 表示不限制）。
export function toolWhitelist(mode: AgentMode): readonly string[] | undefined {
  if (mode === "ask") return ASK_TOOLS;
  if (mode === "plan") return PLAN_TOOLS;
  return undefined;
}

// 取白名单与当前全量工具的交集，避免 setActiveTools 激活不存在的工具名。
// 交集为空（极端情况）时回退到白名单本身，保证绝不放开写类工具。
export function activeToolsFor(mode: AgentMode, allTools: readonly string[]): string[] | undefined {
  const wl = toolWhitelist(mode);
  if (!wl) return undefined;
  const set = new Set(allTools);
  const picked = wl.filter((t) => set.has(t));
  return picked.length > 0 ? picked : [...wl];
}

export interface ToolGateResult {
  block: boolean;
  reason: string;
}

// tool_call 兜底拦截（setActiveTools 之外的第二道防线，防止动态注册的工具绕过白名单）：
//   ask  : 白名单之外一律拦（含 bash/write/edit/MCP/写类扩展工具）
//   plan : 白名单（只读检索 + 只读 bash）之外一律拦（禁 write/edit 与 py_run/hl_edit/dap_* 等写/执行类）
//   agent/debug : 不拦（debug 的危险命令仍由 safety 扩展把关）
export function gateToolCall(mode: AgentMode, toolName: string, input: unknown): ToolGateResult | undefined {
  if (mode === "ask") {
    if (ASK_TOOLS.includes(toolName)) return undefined;
    return {
      block: true,
      reason:
        `问答模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与联网查阅，` +
        `不能修改文件、执行命令行或调用 MCP。如需动手改动，请切换到 Agent 或 Debug 模式。`,
    };
  }
  if (mode === "plan") {
    if (toolName === "write" || toolName === "edit") {
      return { block: true, reason: "规划模式：禁止写入/编辑。请先切到 Agent 模式再执行计划。" };
    }
    if (toolName === "bash") {
      const command = String((input as { command?: unknown } | null)?.command ?? "");
      if (!isSafeCommand(command)) {
        return { block: true, reason: `规划模式：命令未在只读白名单内，已阻止。\n命令：${command}` };
      }
      return undefined;
    }
    // 白名单之外的工具（写 / 执行 / 调试类，如 py_run / hl_edit / dap_*）一并拦截——与 setActiveTools
    // 双保险，防止动态注册的执行类工具在只读规划模式下绕过白名单。
    if (!PLAN_TOOLS.includes(toolName)) {
      return {
        block: true,
        reason:
          `规划模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与白名单内只读命令，` +
          `不能写文件 / 执行代码 / 调试。如需动手，请切换到 Agent 模式。`,
      };
    }
    return undefined;
  }
  return undefined;
}

// 解析 /mode 命令参数为目标模式；空或非法返回 undefined（调用方据此提示用法）。
export function parseModeArg(args: string): AgentMode | undefined {
  const a = args.trim().toLowerCase();
  return isAgentMode(a) ? a : undefined;
}

// 状态栏徽章文本；agent（默认）不显示徽章。
export function modeBadge(mode: AgentMode): string | undefined {
  switch (mode) {
    case "ask":
      return "Ask";
    case "debug":
      return "Debug";
    case "plan":
      return "Plan";
    default:
      return undefined;
  }
}

// 模式中文名（通知文案用）。
export function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case "ask":
      return "问答（只读）";
    case "debug":
      return "调试";
    case "plan":
      return "规划";
    default:
      return "Agent";
  }
}
