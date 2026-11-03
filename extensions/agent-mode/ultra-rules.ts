// Ultra 内置调度规则：只在主会话、模式为 ultra 的那一轮注入。
//
// 走 before_agent_start 的 systemPromptOptions.contextFiles（与 AGENTS.md、用户规则同一段），
// 不依赖 fable-behavior（关掉 Fable 也照样生效），也不另发 custom message（triggerTurn 的回合、
// 后台唤醒、子代理回报都会经过 before_agent_start，规则按当轮真实模式重新算）。
//
// 每次调用先按固定 path 移除旧条目再决定是否追加：SDK 1.3 的 before_agent_start 把同一个
// systemPromptOptions 对象传给所有扩展并累积修改，切出 ultra 后必须能清掉上一轮追加的内容。
// 规则文本见 ultra-rules.md，只写调度原则，不写死供应商 / 模型 / 顾问名额。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import type { AgentMode } from "./modes.js";

/** 追加进 contextFiles 的伪路径，用来在下一轮识别并移除自己。 */
export const ULTRA_RULES_CONTEXT_PATH = "pi://agent-mode/ultra-scheduling-rules.md";

/** 读完缓存一次：规则文本是构建产物的一部分，运行期不会变。 */
let cachedRules: string | undefined;

/**
 * 规则正文。打包后 md 必须和本模块落在同一目录（copyPiAdjacentAssets 负责拷贝，有独立测试）。
 * 读不到时只报错并以空串降级：不能让规则文件的打包疏漏把整个 agent-mode 扩展加载搞崩。
 */
export function ultraSchedulingRules(): string {
  if (cachedRules !== undefined) return cachedRules;
  try {
    cachedRules = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ultra-rules.md"), "utf8").trim();
  } catch (error) {
    console.error("[agent-mode] 读取 Ultra 调度规则失败：", error);
    cachedRules = "";
  }
  return cachedRules;
}

/** 规则正文的只读快照（测试与外部断言用）。 */
export const ULTRA_SCHEDULING_RULES: string = ultraSchedulingRules();

export interface ContextFileEntry {
  path: string;
  content: string;
}

export interface UltraRulesEvent {
  contextFiles?: ContextFileEntry[];
}

export interface UltraRulesContext {
  mode: AgentMode;
  /** 当前是否跑在子代理会话里：子代理即使模式继承成 ultra 也不注入，避免递归编排主代理。 */
  subagent: boolean;
}

/**
 * 按本轮真实模式增删 Ultra 规则，返回 contextFiles 是否发生变化。
 * 内容不变时不重建数组，避免白白打掉前缀缓存。
 */
export function applyUltraRules(event: UltraRulesEvent, context: UltraRulesContext): boolean {
  const current = event.contextFiles ?? [];
  const kept = current.filter((file) => file?.path !== ULTRA_RULES_CONTEXT_PATH);
  const removed = kept.length !== current.length;
  const rules = context.mode === "ultra" && !context.subagent ? ultraSchedulingRules() : "";

  if (!rules) {
    if (!removed) return false;
    event.contextFiles = kept;
    return true;
  }

  event.contextFiles = [...kept, { path: ULTRA_RULES_CONTEXT_PATH, content: rules }];
  return true;
}

export interface SubagentProbe {
  entries?: ReadonlyArray<{ type?: string; customType?: string }>;
  /** ALS 里的回合来源；无 ALS 时由 PI_IS_SUBAGENT 推断。 */
  origin?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 子代理会话判定，和 auto-title 用同一套判据：
 *   - 会话条目里有 subagent_meta（进程内子代理、fork 种子）
 *   - PI_IS_SUBAGENT=1（独立 fork 的 worker）
 *   - ALS origin=subagent
 * goal 回合属于主会话，不算子代理。
 */
export function isSubagentSession(probe: SubagentProbe): boolean {
  if (probe.origin === "subagent") return true;
  if ((probe.env ?? process.env).PI_IS_SUBAGENT === "1") return true;
  try {
    return (probe.entries ?? []).some((entry) => entry?.type === "custom" && entry.customType === "subagent_meta");
  } catch {
    return false;
  }
}

/** 从扩展上下文取子代理判定所需的现场信息（入口只做接线）。 */
export function subagentProbeOf(ctx: unknown): SubagentProbe {
  let entries: SubagentProbe["entries"];
  try {
    entries = (ctx as { sessionManager?: { getEntries?: () => SubagentProbe["entries"] } })?.sessionManager?.getEntries?.();
  } catch {
    entries = undefined;
  }
  return { entries, origin: currentWorkspaceContext()?.origin, env: process.env };
}
