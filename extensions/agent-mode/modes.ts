// 模式定义与纯逻辑：工具白名单、工具调用 gate、命令参数解析、徽章/标签。
// 无磁盘 I/O；live 表只碰内存。状态机与副作用（setActiveTools/setStatus/persist）在 index.ts。
import { currentCwd, currentSessionId } from "../_shared/workspace-context.js";
import { isSafeCommand } from "./utils.js";

export type AgentMode = "agent" | "ask" | "debug" | "plan" | "brainstorm";

export const AGENT_MODES: readonly AgentMode[] = ["agent", "ask", "debug", "plan", "brainstorm"] as const;

export const DEFAULT_MODE: AgentMode = "agent";

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);
}

function normalizeCwd(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 与主进程 agentModeConfigKey 保持一致：工作区路径规范化后作为热更新键。 */
export function agentModeConfigKey(workspace: string): string {
  return `AGENT_MODE:${normalizeCwd(workspace)}`;
}

// byCwd 是项目默认模式（新会话继承）；bySession 是每个会话自己的模式，优先。
const byCwd = new Map<string, AgentMode>();
const bySession = new Map<string, AgentMode>();

function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

/** sessionId 省略时取 ALS 里的交互会话；会话没写过模式时回退项目默认。 */
export function getAgentMode(cwd?: string, sessionId: string | undefined = currentSessionId()): AgentMode {
  const own = sessionId ? bySession.get(sessionId) : undefined;
  return own ?? byCwd.get(resolveCwd(cwd)) ?? DEFAULT_MODE;
}

/** 带 sessionId 只写该会话；不带写项目默认。 */
export function setAgentMode(mode: AgentMode, cwd?: string, sessionId?: string): void {
  if (sessionId) bySession.set(sessionId, mode);
  else byCwd.set(resolveCwd(cwd), mode);
}

/** 项目默认模式（不看会话）。 */
export function getDefaultAgentMode(cwd?: string): AgentMode {
  return byCwd.get(resolveCwd(cwd)) ?? DEFAULT_MODE;
}

export function hasAgentMode(cwd?: string, sessionId?: string): boolean {
  return sessionId ? bySession.has(sessionId) : byCwd.has(resolveCwd(cwd));
}

/** 仅测试。 */
export function __resetAgentModeForTest(): void {
  byCwd.clear();
  bySession.clear();
}

// ask：只读问答。白名单为经核实存在的只读工具 + bash（写由只读 OS 沙箱拦；被拦后可用 bash 的
// sandbox_permissions 在同一次调用里升权，用户批准）：
//   - pi 内置：read / grep / find / ls / bash
//   - 联网只读：fetch_url（web-fetch，format 选 markdown / text / html / json / llms）、
//     web_search / anysearch_search / anysearch_sub_domains（web-search）
//   - 本地只读检索：search（batch-tools 多正则/glob 本地检索）、
//     memory_search / conversation_search、git_diff（code-review）、
//     code_explore（code-retrieval，只读 CodeGraph 检索；与上游 MCP 一样只列这一个）
//   - 交互/只读视图（不改文件）：ask_user（agent-mode 提问卡）、hl_read（hashline 带 #TAG 的只读视图）
// 写类(write/edit/review_note/todo/generate_image/speak)、
// 子代理(spawn_agent/explore_context)、外部命令(diagnostics)、MCP(<server>__*) 一律不在白名单，
// 经 setActiveTools 隐藏 + tool_call 兜底双重拦截。命令行由只读 OS 沙箱执行。
// 多列的名字若当前不可用，会在 activeToolsFor 交集中被滤除。
export const ASK_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "fetch_url",
  "web_search",
  "anysearch_search",
  "anysearch_sub_domains",
  "search",
  "memory_search",
  "conversation_search",
  "git_diff",
  "code_explore",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_diagnostics",
  "lsp_document_symbols",
  "hl_read",
  "ask_user",
  "present",
  // 只换本会话的工作目录，不写文件；离开 worktree 也靠它。
  "working_directory",
];

// plan：与 ask 共用白名单（含 bash）；bash 再由 isSafeCommand 限定为只读命令，带不带 sandbox_permissions 都一样。
export const PLAN_TOOLS: readonly string[] = ASK_TOOLS;

// brainstorm：使用完整工具集（与 agent 相同），不限制写文件/执行命令。
// 头脑风暴模式下 AI 仍需要能写文件、生成原型、执行代码——限制工具集是错误设计。
// 区别在于 fable-behavior 注入的 brainstorm.md 行为提示，而非工具白名单。
// BRAINSTORM_TOOLS 保留供引用，但 toolWhitelist 不再使用它（返回 undefined = 不限制）。
export const BRAINSTORM_TOOLS: readonly string[] = [
  ...ASK_TOOLS,
  "show_visual",
  "read_visual_choice",
];

// 受限模式返回白名单；agent/debug/brainstorm 用完整工具集（返回 undefined 表示不限制）。
export function toolWhitelist(mode: AgentMode): readonly string[] | undefined {
  if (mode === "ask") return ASK_TOOLS;
  if (mode === "plan") return PLAN_TOOLS;
  return undefined; // agent / debug / brainstorm: 不限制
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
//   ask        : 白名单之外一律拦（含 write/edit/MCP/写类扩展工具；bash 放行，写由只读沙箱拦）
//   plan       : 白名单（只读检索 + bash）之外一律拦；bash 再经 isSafeCommand 限定只读命令
//   agent/debug/brainstorm: 不拦（brainstorm 有完整工具集，由 fable-behavior 引导行为）
export function gateToolCall(mode: AgentMode, toolName: string, input: unknown): ToolGateResult | undefined {
  if (mode === "ask") {
    if (ASK_TOOLS.includes(toolName)) return undefined;
    return {
      block: true,
      reason:
        `问答模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与联网查阅，` +
        `不能修改文件或调用 MCP；命令行由只读 OS 沙箱执行。如需动手改动，请切换到 Agent 或 Debug 模式。`,
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
    case "brainstorm":
      return "Brainstorm";
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
    case "brainstorm":
      return "头脑风暴";
    default:
      return "Agent";
  }
}
